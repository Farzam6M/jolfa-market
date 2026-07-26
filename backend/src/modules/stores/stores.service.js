const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { logAdminActivity } = require('../admin/admin.service');
const { pushNotification } = require('../notifications/notifications.service');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { hashPassword, comparePassword } = require('../../utils/password');
const { generateNumericCode } = require('../../utils/tokens');

function canModerate(requester) {
  return !!requester && (requester.permissions.includes('*') || requester.permissions.includes(PERMISSIONS.STORES_MODERATE));
}

function slugify(str) {
  return str.toString().trim().toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-').replace(/^-+|-+$/g, '') || 'store';
}

async function generateUniqueMobile() {
  // Keeps trying random 09XXXXXXXXX numbers until one isn't already taken.
  for (;;) {
    const candidate = `09${generateNumericCode(9)}`;
    // eslint-disable-next-line no-await-in-loop
    const existing = await prisma.user.findUnique({ where: { mobile: candidate } });
    if (!existing) return candidate;
  }
}

/**
 * Only-approved-by-default listing for public/customer browsing. A seller
 * checking on their own store's status should use GET /stores/me instead —
 * the `status` filter here is only honored for staff, so an anonymous or
 * customer request can't pass ?status=PENDING to browse stores still
 * awaiting moderation.
 */
async function list({ status, region, page, pageSize }, requester) {
  const effectiveStatus = status && canModerate(requester) ? status : 'APPROVED';
  const where = {
    status: effectiveStatus,
    ...(region ? { region } : {}),
    // Defense-in-depth: a soft-deleted seller (see removeSeller() in
    // sellers.service.js) must never have their store surfaced by list(),
    // regardless of which `status` branch is being queried — the public
    // caller only ever sees APPROVED here, but staff/admin can request any
    // status (PENDING/REJECTED/SUSPENDED) for the "مدیریت فروشندگان" table,
    // and that table must be just as blind to a deleted seller's leftover
    // store as the public listing is. Previously this was only applied when
    // effectiveStatus === 'APPROVED', so a staff ?status=SUSPENDED/PENDING/
    // REJECTED query could still leak such a store — inconsistent with this
    // same guard's own stated intent and with the unconditional equivalent
    // already used in products.service.js. Applying it unconditionally here
    // does not change what any status filter itself returns for a normal
    // (non-deleted) seller's store.
    seller: { deletedAt: null },
  };
  const [items, total] = await Promise.all([
    prisma.store.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
    prisma.store.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

async function getBySlug(slug, requester) {
  const store = await prisma.store.findUnique({
    where: { slug },
    include: { seller: { select: { deletedAt: true } } },
  });
  if (!store) throw ApiError.notFound('فروشگاه یافت نشد');

  const isOwner = !!requester && store.sellerId === requester.id;
  const isStaff = canModerate(requester);
  // Same "still a visible/live store" rule already enforced by list() and by
  // products.service.js getById(): a soft-deleted seller's store (see
  // removeSeller() in sellers.service.js) must not be visible to a non-owner/
  // non-staff caller either — checked explicitly here via seller.deletedAt
  // rather than relying only on `status` (which, for older/edge-case rows,
  // might not by itself reflect the seller's deletion).
  if ((store.status !== 'APPROVED' || store.seller.deletedAt) && !isStaff && !isOwner) {
    throw ApiError.notFound('فروشگاه یافت نشد');
  }

  delete store.seller; // internal moderation field, not part of the public store shape
  return store;
}

async function getOwnByUserId(userId) {
  const store = await prisma.store.findUnique({ where: { sellerId: userId } });
  if (!store) throw ApiError.notFound('فروشگاهی برای این کاربر یافت نشد');
  return store;
}

async function updateOwn(userId, data) {
  const store = await prisma.store.findUnique({ where: { sellerId: userId } });
  if (!store) throw ApiError.notFound('فروشگاهی برای این کاربر یافت نشد');
  return prisma.store.update({ where: { id: store.id }, data });
}

/**
 * Full store edit by an admin/super_admin (any store, any field except status —
 * status changes go through `moderate` so they're logged/notified consistently).
 * This is what gives admin genuine "full access" to store management, distinct
 * from the seller's own-store-only `updateOwn`.
 */
async function adminUpdate(storeId, data) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw ApiError.notFound('فروشگاه یافت نشد');
  return prisma.store.update({ where: { id: storeId }, data });
}

/**
 * Admin's "افزودن مستقیم فروشگاه" (add store directly) form — the only path
 * in this app that creates a Store without going through the seller
 * application/review flow. Mirrors that flow's transactional shape (create
 * or upgrade the seller's User row + create the Store together) so the new
 * store shows up everywhere GET /stores is used, with no separate/local
 * data source left behind.
 */
async function createDirect({ name, categoryTag, region, description, logoUrl, mobile, password }, actor) {
  let user;
  let plainPassword = password;

  if (mobile) {
    const existing = await prisma.user.findUnique({ where: { mobile }, include: { role: true } });
    if (existing) {
      if (existing.role.key !== 'CUSTOMER') {
        throw ApiError.conflict('این شماره موبایل قبلاً برای حساب دیگری (غیر از مشتری) ثبت شده است');
      }
      if (!password) {
        throw ApiError.badRequest('این شماره قبلاً به‌عنوان مشتری ثبت‌نام کرده — برای تبدیل آن به فروشگاه، رمز عبور همان حساب را وارد کنید');
      }
      const matches = await comparePassword(password, existing.passwordHash);
      if (!matches) throw ApiError.unauthorized('رمز عبور وارد شده با رمز عبور حساب مشتری این شماره مطابقت ندارد');
      const sellerRole = await prisma.role.findUnique({ where: { key: 'SELLER' } });
      user = await prisma.user.update({ where: { id: existing.id }, data: { roleId: sellerRole.id }, include: { role: true } });
    }
  }

  if (!user) {
    const mobileToUse = mobile || await generateUniqueMobile();
    if (mobile) {
      const existingCheck = await prisma.user.findUnique({ where: { mobile: mobileToUse } });
      if (existingCheck) throw ApiError.conflict('این شماره موبایل قبلاً ثبت شده است');
    }
    plainPassword = password || Math.random().toString(36).slice(-8);
    const sellerRole = await prisma.role.findUnique({ where: { key: 'SELLER' } });
    const passwordHash = await hashPassword(plainPassword);
    user = await prisma.user.create({
      data: { name, mobile: mobileToUse, passwordHash, roleId: sellerRole.id },
      include: { role: true },
    });
    await prisma.wallet.create({ data: { userId: user.id } });
  }

  const existingStore = await prisma.store.findUnique({ where: { sellerId: user.id } });
  if (existingStore) throw ApiError.conflict('این حساب قبلاً یک فروشگاه دارد');

  const store = await prisma.store.create({
    data: {
      sellerId: user.id,
      name,
      slug: `${slugify(name)}-${Date.now().toString(36)}`,
      categoryTag,
      region,
      description,
      logoUrl,
      status: 'APPROVED',
    },
  });

  await logAdminActivity(actor.id, `فروشگاه «${name}» به‌صورت مستقیم اضافه و فعال شد`);
  await pushNotification({
    icon: 'i-store', text: `فروشگاه شما «${name}» با موفقیت ثبت و فعال شد`, scope: 'USER', targetUserId: user.id,
  });

  return { store, credentials: { mobile: user.mobile, password: plainPassword } };
}

async function moderate(storeId, status, actor) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, include: { seller: true } });
  if (!store) throw ApiError.notFound('فروشگاه یافت نشد');

  // Guard: a store whose owner has been soft-deleted (removeSeller() in
  // sellers.service.js — User.deletedAt stamped + User.status BANNED) must never
  // be re-approved/re-activated through this endpoint. Without this check, an
  // admin toggling status (see toggleRowStoreStatus in the frontend) could bring
  // a deleted seller's store back to APPROVED while the seller account itself
  // stays deleted, producing an inconsistent "active store, deleted seller" state.
  //
  // The check above (`store.seller...`) is a plain read and, on its own, would
  // leave a race window against a concurrent removeSeller() call: that read
  // could see a not-yet-deleted seller, then removeSeller() commits its
  // soft-delete, then this function's write would silently overwrite the
  // store back to APPROVED. To close that window, the actual write for
  // APPROVED is a single conditional `updateMany` whose WHERE re-checks the
  // seller's live state at write-time (not the earlier read) — so if a
  // soft-delete lands in between, the condition no longer matches and the
  // update simply affects zero rows instead of racing past it.
  let updated;
  if (status === 'APPROVED') {
    const result = await prisma.store.updateMany({
      where: { id: storeId, seller: { deletedAt: null, status: { not: 'BANNED' } } },
      data: { status },
    });
    if (result.count === 0) {
      throw ApiError.conflict('این فروشگاه متعلق به فروشنده‌ای است که قبلاً حذف شده — امکان فعال‌سازی مجدد آن وجود ندارد');
    }
    updated = await prisma.store.findUnique({ where: { id: storeId } });
  } else {
    updated = await prisma.store.update({ where: { id: storeId }, data: { status } });
  }
  await logAdminActivity(actor.id, `تغییر وضعیت فروشگاه «${store.name}» به ${status}`);
  await pushNotification({
    icon: 'i-store', text: `وضعیت فروشگاه شما به «${status}» تغییر کرد`, scope: 'USER', targetUserId: store.sellerId,
  });
  return updated;
}

module.exports = {
  list, getBySlug, getOwnByUserId, updateOwn, adminUpdate, createDirect, moderate,
};
