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

  // A user soft-deleted via DELETE /admin/sellers/:sellerId (removeSeller() in
  // sellers.service.js — User.deletedAt stamped) must never be brought back to
  // ACTIVE through this generic status endpoint. Without this guard, an admin
  // using the general "مدیریت کاربران" panel could silently undo a seller
  // deletion (restoring login) while deletedAt stays set and the store/products
  // remain in their deleted state — an inconsistent, invisible "half-restored"
  // account. There is deliberately no restore flow anywhere in this project, so
  // any status other than the deleted state stays blocked once deletedAt is set.
  if (target.deletedAt) {
    throw ApiError.conflict('این کاربر قبلاً حذف شده است و امکان تغییر وضعیت آن وجود ندارد');
  }

  const updated = await prisma.$transaction(async (tx) => {
    // The `if (target.deletedAt)` check above is a plain read taken before this
    // transaction starts, so it cannot see a removeSeller() soft-delete that
    // commits concurrently, between that read and this transaction's write.
    // Mirrors removeSeller()'s own race guard: the actual write is a
    // conditional `updateMany` re-checked at write-time — only succeeds while
    // `deletedAt` is still null. If removeSeller() won the race first, `count`
    // is 0 here and this status change is rejected instead of silently
    // overwriting the status a soft-delete just set.
    const claim = await tx.user.updateMany({ where: { id: targetId, deletedAt: null }, data: { status } });
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
      await tx.product.updateMany({
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
