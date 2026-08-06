const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { logAdminActivity } = require('../admin/admin.service');
const { pushNotification } = require('../notifications/notifications.service');

function slugify(str) {
  return str.toString().trim().toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-').replace(/^-+|-+$/g, '') || 'store';
}

/** A customer applies to become a seller. Creates the SellerApplication; the store itself is created only on approval. */
async function apply(userId, { storeName, businessInfo, documents }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('کاربر یافت نشد');

  const existing = await prisma.sellerApplication.findUnique({ where: { userId } });
  if (existing && existing.status === 'PENDING') {
    throw ApiError.conflict('درخواست قبلی شما هنوز در حال بررسی است');
  }

  const application = await prisma.sellerApplication.upsert({
    where: { userId },
    update: { storeName, businessInfo, documents, status: 'PENDING', reviewedAt: null, reviewedById: null },
    create: { userId, storeName, businessInfo, documents },
  });

  await pushNotification({
    icon: 'i-store', text: `درخواست فروشندگی جدید از «${storeName}»`, scope: 'ROLE', targetRole: 'ADMIN',
  });
  return application;
}

/** The applicant checking their own request — the only status source a customer/rejected
    applicant has, since they don't hold seller_applications:review and can't call listApplications. */
async function getMyApplication(userId) {
  return prisma.sellerApplication.findUnique({ where: { userId } });
}

async function listApplications({ status } = {}) {
  return prisma.sellerApplication.findMany({
    where: status ? { status } : undefined,
    include: { user: { select: { id: true, name: true, mobile: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

/** Approving creates the Store + upgrades the user's role to SELLER, atomically. */
async function review(applicationId, { status, note }, actor) {
  const application = await prisma.sellerApplication.findUnique({ where: { id: applicationId }, include: { user: true } });
  if (!application) throw ApiError.notFound('درخواست یافت نشد');
  if (application.status !== 'PENDING') throw ApiError.conflict('این درخواست قبلاً بررسی شده است');

  const result = await prisma.$transaction(async (tx) => {
    const updatedApp = await tx.sellerApplication.update({
      where: { id: applicationId },
      data: { status, reviewedById: actor.id, reviewedAt: new Date() },
    });

    if (status === 'APPROVED') {
      const sellerRole = await tx.role.findUnique({ where: { key: 'SELLER' } });
      await tx.user.update({ where: { id: application.userId }, data: { roleId: sellerRole.id } });
      await tx.store.create({
        data: {
          sellerId: application.userId,
          name: application.storeName,
          slug: `${slugify(application.storeName)}-${Date.now().toString(36)}`,
          status: 'APPROVED',
        },
      });
    }
    return updatedApp;
  });

  await logAdminActivity(actor.id, `${status === 'APPROVED' ? 'تایید' : 'رد'} درخواست فروشندگی «${application.storeName}»`);
  await pushNotification({
    icon: status === 'APPROVED' ? 'i-check' : 'i-x',
    text: `درخواست فروشندگی شما ${status === 'APPROVED' ? 'تایید' : 'رد'} شد${note ? `: ${note}` : ''}`,
    scope: 'USER',
    targetUserId: application.userId,
  });
  return result;
}

/**
 * Admin/super_admin removes a seller from the admin panel (DELETE /admin/sellers/:sellerId).
 *
 * This is deliberately a controlled, transactional SOFT delete — it never runs
 * `prisma.user.delete()` / `prisma.store.delete()` / `prisma.product.delete()`.
 * Reason: a seller's products can already appear in OrderItem rows, and
 * OrderItem -> Product has no cascade (see products.service.js `remove()`,
 * which already refuses to hard-delete a single product with order history
 * for the same reason). Hard-deleting a whole seller would either throw a raw
 * FK-constraint error the moment any of their products had ever been ordered,
 * or — if forced — destroy customers' order history. So instead:
 *   - the account is BANNED (existing `status` enum already makes
 *     auth.middleware.js's `authenticate()` reject it — no auth changes needed),
 *   - every refresh token/session is revoked,
 *   - the store is SUSPENDED (existing status already hidden from public
 *     `GET /stores` per stores.service.js `list()`),
 *   - every product is ARCHIVED + deactivated (existing status/isActive combo
 *     already hidden from public `GET /products` per products.service.js `list()`),
 *   - orders, order items, payments, reviews, chats (support + store) and
 *     notifications are left completely untouched.
 * `deletedAt`/`deletedById` are stamped for audit trail + idempotency (a second
 * delete attempt on the same seller is rejected as a conflict, not silently
 * repeated or 404'd).
 */
async function removeSeller(sellerId, actor) {
  if (sellerId === actor.id) throw ApiError.badRequest('امکان حذف حساب خودتان وجود ندارد');

  const target = await prisma.user.findUnique({ where: { id: sellerId }, include: { role: true, store: true } });
  if (!target) throw ApiError.notFound('فروشنده یافت نشد');
  if (target.role.key === 'SUPER_ADMIN') throw ApiError.forbidden('امکان حذف مدیر اصلی سایت وجود ندارد');
  if (target.role.key !== 'SELLER') throw ApiError.badRequest('کاربر انتخاب‌شده فروشنده نیست');
  if (target.deletedAt) throw ApiError.conflict('این فروشنده قبلاً حذف شده است');

  const { updatedUser, storeId, archivedProducts } = await prisma.$transaction(async (tx) => {
    // The `if (target.deletedAt)` check above is a plain read taken before this
    // transaction starts, so two simultaneous DELETE requests for the same
    // seller (double-click, retried request, etc.) could both pass it before
    // either commits. To make the delete itself idempotent/atomic against that
    // race, the actual "claim" of the deletion is a single conditional
    // `updateMany` re-checked at write-time: only the request that still finds
    // `deletedAt: null` at the moment of the write wins; the other gets the
    // same conflict error as the pre-check above instead of silently
    // re-running the whole soft-delete a second time.
    const claim = await tx.user.updateMany({
      where: { id: sellerId, deletedAt: null },
      data: { status: 'BANNED', deletedAt: new Date(), deletedById: actor.id },
    });
    if (claim.count === 0) {
      throw ApiError.conflict('این فروشنده قبلاً حذف شده است');
    }

    let sId = null;
    let archivedCount = 0;

    // Not every SELLER-role row is guaranteed to have a Store (defensive: a
    // seller with no store yet is still deletable, there's just nothing to archive).
    if (target.store) {
      sId = target.store.id;
      const archived = await tx.storeProduct.updateMany({
        where: { storeId: sId },
        data: { status: 'ARCHIVED', isActive: false },
      });
      archivedCount = archived.count;
      await tx.store.update({ where: { id: sId }, data: { status: 'SUSPENDED' } });
    }

    // Kill every active session — a deleted seller shouldn't keep using an
    // already-issued access token's matching refresh token to stay logged in.
    await tx.refreshToken.updateMany({ where: { userId: sellerId, revoked: false }, data: { revoked: true } });

    const user = await tx.user.findUnique({ where: { id: sellerId }, include: { role: true } });

    return { updatedUser: user, storeId: sId, archivedProducts: archivedCount };
  });

  await logAdminActivity(actor.id, `حذف فروشنده «${target.name}»`, {
    code: 'DELETE_SELLER',
    targetUserId: sellerId,
    storeId,
    archivedProducts,
  });

  return {
    id: updatedUser.id,
    name: updatedUser.name,
    status: updatedUser.status,
    deletedAt: updatedUser.deletedAt,
    storeId,
    archivedProducts,
  };
}

module.exports = {
  apply, getMyApplication, listApplications, review, removeSeller,
};
