const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { hashPassword, comparePassword } = require('../../utils/password');
const { logAdminActivity } = require('../admin/admin.service');

const MAX_ADMINS = 4; // mirrors the frontend's MAX_ADMINS business rule

function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role.key,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    emailVerified: !!user.emailVerifiedAt,
    mobileVerified: !!user.mobileVerifiedAt,
  };
}

function toPublicAddress(address) {
  return {
    id: address.id,
    fullName: address.fullName,
    phone: address.phone,
    province: address.province,
    city: address.city,
    addressLine: address.addressLine,
    postalCode: address.postalCode,
    isDefault: address.isDefault,
    createdAt: address.createdAt,
  };
}

async function getById(id) {
  const user = await prisma.user.findUnique({ where: { id }, include: { role: true } });
  if (!user) throw ApiError.notFound('کاربر یافت نشد');
  return toPublicUser(user);
}

async function updateSelf(id, data) {
  const user = await prisma.user.update({ where: { id }, data, include: { role: true } });
  return toPublicUser(user);
}

async function list({ role, page, pageSize, search }) {
  const where = {
    ...(role ? { role: { key: role } } : {}),
    ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { mobile: { contains: search } }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where, include: { role: true }, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);
  return { items: items.map(toPublicUser), total, page, pageSize };
}

async function updateStatus(targetId, status, actor) {
  const target = await prisma.user.findUnique({ where: { id: targetId }, include: { role: true, store: true } });
  if (!target) throw ApiError.notFound('کاربر یافت نشد');
  if (target.role.key === 'SUPER_ADMIN') throw ApiError.forbidden('امکان تغییر وضعیت مدیر اصلی وجود ندارد');

  // Only a real DELETED account (via deleteUser()) must stay blocked here.
  // BANNED/SUSPENDED are ordinary reversible states — including a seller
  // banned by removeSeller() (sellers.service.js), which stamps
  // status: 'BANNED' + deletedAt for its own audit trail. That deletedAt is
  // NOT a signal that the account is deleted (only status === 'DELETED' is),
  // so it must never be used to block a status change here.
  if (target.status === 'DELETED') {
    throw ApiError.conflict('این کاربر قبلاً حذف شده است و امکان تغییر وضعیت آن وجود ندارد');
  }

  const updated = await prisma.$transaction(async (tx) => {
    // The `if (target.status === 'DELETED')` check above is a plain read taken
    // before this transaction starts, so it cannot see a concurrent
    // deleteUser() commit that lands between that read and this transaction's
    // write. The actual write is a conditional `updateMany` re-checked at
    // write-time — only succeeds while status is still not DELETED. If
    // deleteUser() won the race first, `count` is 0 here and this status
    // change is rejected instead of silently overwriting DELETED.
    const claim = await tx.user.updateMany({
      where: { id: targetId, status: { not: 'DELETED' } },
      data: {
        status,
        // Restoring/changing status via this generic endpoint always clears
        // any stale removeSeller() soft-delete markers, so the account can
        // never end up "half-restored" (status changed here, but deletedAt/
        // deletedById still stamped from a prior removeSeller() ban).
        deletedAt: null,
        deletedById: null,
      },
    });
    if (claim.count === 0) {
      throw ApiError.conflict('این کاربر قبلاً حذف شده است و امکان تغییر وضعیت آن وجود ندارد');
    }

    // Keep a SELLER's store/product visibility in sync with their own account
    // status. Without this, banning/suspending a seller through this generic
    // endpoint only blocked their login (auth.middleware rejects non-ACTIVE
    // users) while their Store stayed APPROVED and their Products stayed
    // APPROVED/isActive — still fully live in the public catalogue, cart, and
    // checkout. This mirrors (does not replace) the same cascade removeSeller()
    // already performs in sellers.service.js, so the two "disable a seller"
    // paths in this project can no longer disagree about the resulting state.
    // Matches removeSeller(): only the store's status and the products'
    // status/isActive are touched — deletedAt is intentionally left untouched
    // here, since this is a reversible status change, not a deletion.
    if (target.role.key === 'SELLER' && status !== 'ACTIVE' && target.store) {
      await tx.storeProduct.updateMany({
        where: { storeId: target.store.id },
        data: { status: 'ARCHIVED', isActive: false },
      });
      await tx.store.update({ where: { id: target.store.id }, data: { status: 'SUSPENDED' } });
    }

    const user = await tx.user.findUnique({ where: { id: targetId }, include: { role: true } });
    return user;
  });

  await logAdminActivity(actor.id, `تغییر وضعیت کاربر «${target.name}» به ${status}`);
  return toPublicUser(updated);
}

/**
 * Admin/super_admin general "Delete User" (soft delete) — DELETE /users/:id.
 * Applies to any role (customer, seller, admin), unlike removeSeller() in
 * sellers.service.js which is seller-only and doesn't free mobile/email.
 *
 * Never a raw `prisma.user.delete()`: a user's Orders/Payments/SupportMessages/
 * StoreMessages/Reviews all carry history that must survive (order history in
 * particular already can't be hard-deleted — see products.service.js
 * `remove()`'s identical rule), so this only marks the account deleted:
 *   - status -> DELETED, deletedAt/deletedById stamped (audit + idempotency,
 *     same pattern as removeSeller()),
 *   - mobile is rewritten to a guaranteed-unique synthetic value and email is
 *     cleared, so the exact same mobile/email can be used again on a fresh
 *     registration (see auth.service.js `register()` — it only rejects a
 *     mobile that still exists on some row),
 *   - every refresh token is revoked; a still-unexpired access token is also
 *     rejected on its very next request by authenticate() (auth.middleware.js),
 *     which re-checks `status === 'ACTIVE'` against the DB on every call — so
 *     no separate access-token blocklist is needed,
 *   - orders, payments, support/store chat messages, reviews, notifications
 *     are all left completely untouched.
 * A deleted SELLER's store/products are archived exactly like removeSeller()
 * does, so this can't be a second path into a state removeSeller() disagrees
 * with.
 */
async function deleteUser(targetId, actor) {
  if (targetId === actor.id) throw ApiError.badRequest('امکان حذف حساب خودتان وجود ندارد');

  const target = await prisma.user.findUnique({ where: { id: targetId }, include: { role: true, store: true } });
  if (!target) throw ApiError.notFound('کاربر یافت نشد');
  // Only a real DELETED account blocks another delete. BANNED/SUSPENDED
  // (including a seller previously banned by removeSeller(), which also
  // stamps deletedAt for its own audit trail) must remain deletable through
  // this generic endpoint — deleting them here correctly promotes them to
  // the real DELETED state.
  if (target.status === 'DELETED') throw ApiError.conflict('این کاربر قبلاً حذف شده است');

  // Absolute protection, matching removeSeller()'s identical rule: the
  // super_admin account can never be soft-deleted through any admin-panel
  // action, no matter who's asking — otherwise the platform could end up
  // with no super_admin left able to log in.
  if (target.role.key === 'SUPER_ADMIN') {
    throw ApiError.forbidden('امکان حذف مدیر اصلی سایت وجود ندارد');
  }
  // An ADMIN account may only be removed by a super_admin (wildcard '*') —
  // a plain admin can never delete another admin, even though both hold
  // USERS_DELETE (enforced here, not just at the route, since the route only
  // knows the permission was granted, not who the specific target is).
  const isSuperAdmin = actor.permissions.includes('*');
  if (target.role.key === 'ADMIN' && !isSuperAdmin) {
    throw ApiError.forbidden('فقط مدیر اصلی سایت می‌تواند حساب یک ادمین را حذف کند');
  }

  // Frees the mobile number for a brand-new registration with the same
  // value: mobile is NOT NULL + @unique, so (unlike email) it can't just be
  // cleared — it's rewritten to a value guaranteed unique (embeds the user's
  // own id) and clearly synthetic/non-guessable as a real mobile number.
  const freedMobile = `deleted:${target.mobile}:${target.id}`;

  const updated = await prisma.$transaction(async (tx) => {
    // Same idempotency/race pattern as removeSeller(): the plain read above
    // happens before this transaction starts, so two concurrent delete
    // requests for the same user could both pass it. The actual claim is a
    // conditional updateMany re-checked at write-time — only the request
    // that still finds status !== 'DELETED' at the moment of the write wins.
    const claim = await tx.user.updateMany({
      where: { id: targetId, status: { not: 'DELETED' } },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        deletedById: actor.id,
        mobile: freedMobile,
        email: null,
      },
    });
    if (claim.count === 0) {
      throw ApiError.conflict('این کاربر قبلاً حذف شده است');
    }

    // Kill every active session immediately.
    await tx.refreshToken.updateMany({ where: { userId: targetId, revoked: false }, data: { revoked: true } });

    // Mirrors removeSeller(): a deleted SELLER's store/products must also
    // stop being publicly visible (GET /products / GET /stores already hide
    // ARCHIVED/SUSPENDED, per products.service.js / stores.service.js list()).
    let sId = null;
    if (target.role.key === 'SELLER' && target.store) {
      sId = target.store.id;
      await tx.storeProduct.updateMany({ where: { storeId: sId }, data: { status: 'ARCHIVED', isActive: false } });
      await tx.store.update({ where: { id: sId }, data: { status: 'SUSPENDED' } });
    }

    const user = await tx.user.findUnique({ where: { id: targetId }, include: { role: true } });
    return { user, storeId: sId };
  });

  await logAdminActivity(actor.id, `حذف کاربر «${target.name}»`, {
    code: 'DELETE_USER',
    targetUserId: targetId,
    targetRole: target.role.key,
    storeId: updated.storeId,
    // Kept here (not on the User row) purely for the audit trail — the
    // actual row's mobile/email are now the freed/cleared values above.
    originalMobile: target.mobile,
    originalEmail: target.email,
  });

  return toPublicUser(updated.user);
}

/**
 * Creates a staff account (ADMIN role). Enforces MAX_ADMINS and requires
 * the caller to already hold ADMINS_MANAGE (checked at the route layer via
 * RBAC) — only a super_admin can reach this.
 */
async function createStaffUser({ name, mobile, password }, roleKey, actor) {
  if (roleKey === 'ADMIN') {
    const currentAdmins = await prisma.user.count({ where: { role: { key: 'ADMIN' } } });
    if (currentAdmins >= MAX_ADMINS) {
      throw ApiError.conflict(`حداکثر تعداد ادمین (${MAX_ADMINS} نفر) قبلاً ثبت شده است`);
    }
  }
  const existing = await prisma.user.findUnique({ where: { mobile } });
  if (existing) throw ApiError.conflict('این شماره موبایل قبلاً ثبت شده است');

  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { name, mobile, passwordHash, roleId: role.id },
    include: { role: true },
  });
  await prisma.wallet.create({ data: { userId: user.id } });
  await logAdminActivity(actor.id, `ایجاد حساب ${roleKey} جدید: ${name}`);
  return toPublicUser(user);
}

/** Sets the user's avatar to an uploaded file's public URL. */
async function updateAvatar(userId, avatarUrl) {
  const user = await prisma.user.update({ where: { id: userId }, data: { avatarUrl }, include: { role: true } });
  return toPublicUser(user);
}

/**
 * Changes email and/or mobile. Requires the current password (these are
 * login-credential-adjacent fields, not plain profile fields) and resets
 * the relevant verification flag so the new value must be re-verified —
 * otherwise a user could "verify" a contact they no longer actually own.
 */
async function updateContact(userId, { email, mobile, currentPassword }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('کاربر یافت نشد');

  const ok = await comparePassword(currentPassword, user.passwordHash);
  if (!ok) throw ApiError.unauthorized('رمز عبور فعلی صحیح نیست');

  const data = {};
  if (email !== undefined && email !== user.email) {
    data.email = email;
    data.emailVerifiedAt = null;
  }
  if (mobile !== undefined && mobile !== user.mobile) {
    data.mobile = mobile;
    data.mobileVerifiedAt = null;
  }

  if (Object.keys(data).length === 0) {
    const unchanged = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    return toPublicUser(unchanged);
  }

  const updated = await prisma.user.update({ where: { id: userId }, data, include: { role: true } });
  await logAdminActivity(userId, 'به‌روزرسانی اطلاعات تماس', { emailChanged: 'email' in data, mobileChanged: 'mobile' in data });
  return toPublicUser(updated);
}

async function listAddresses(userId) {
  const addresses = await prisma.address.findMany({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] });
  return addresses.map(toPublicAddress);
}

async function createAddress(userId, data) {
  if (data.isDefault) {
    await prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
  }
  const address = await prisma.address.create({ data: { ...data, userId } });
  return toPublicAddress(address);
}

/** Ownership is enforced here (not just at the route) so a guessed/enumerated address id from another user can never be read or written — prevents IDOR. */
async function assertOwnedAddress(userId, addressId) {
  const address = await prisma.address.findUnique({ where: { id: addressId } });
  if (!address || address.userId !== userId) throw ApiError.notFound('آدرس یافت نشد');
  return address;
}

async function updateAddress(userId, addressId, data) {
  await assertOwnedAddress(userId, addressId);
  if (data.isDefault) {
    await prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
  }
  const updated = await prisma.address.update({ where: { id: addressId }, data });
  return toPublicAddress(updated);
}

async function deleteAddress(userId, addressId) {
  await assertOwnedAddress(userId, addressId);
  await prisma.address.delete({ where: { id: addressId } });
}

async function setDefaultAddress(userId, addressId) {
  await assertOwnedAddress(userId, addressId);
  await prisma.$transaction([
    prisma.address.updateMany({ where: { userId }, data: { isDefault: false } }),
    prisma.address.update({ where: { id: addressId }, data: { isDefault: true } }),
  ]);
}

module.exports = {
  toPublicUser,
  getById,
  updateSelf,
  list,
  updateStatus,
  deleteUser,
  createStaffUser,
  MAX_ADMINS,
  updateAvatar,
  updateContact,
  listAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
};
