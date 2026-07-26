const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { logAdminActivity } = require('../admin/admin.service');
const { pushNotification } = require('../notifications/notifications.service');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { assertCategoryUsable } = require('../categories/categories.service');
const { deleteLocalUpload } = require('../../utils/uploadedFile');
const { MAX_IMAGES } = require('./products.validation');

function canModerate(requester) {
  return !!requester && (requester.permissions.includes('*') || requester.permissions.includes(PERMISSIONS.PRODUCTS_MODERATE));
}

function slugify(str) {
  return str.toString().trim().toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-').replace(/^-+|-+$/g, '') || 'product';
}

const publicInclude = {
  images: { orderBy: { position: 'asc' } },
  wholesaleTiers: true,
  category: true,
  store: { select: { id: true, name: true, slug: true, logoUrl: true, rating: true } },
};

/** Only-approved-by-default listing for public/customer browsing; sellers/admins can widen via `status`. */
async function list({
  categoryId, storeId, type, status, q, minPrice, maxPrice, inStock, page, pageSize,
}, requester) {
  // A `status` override is only honored for staff (moderation) or for a seller
  // requesting their own store's products — otherwise anyone could pass
  // ?status=PENDING (or REJECTED/ARCHIVED) and browse every seller's
  // not-yet-approved catalogue.
  let effectiveStatus = 'APPROVED';
  let ownRequest = false;
  if (status) {
    ownRequest = canModerate(requester);
    if (!ownRequest && requester && storeId) {
      const store = await prisma.store.findUnique({ where: { id: storeId } });
      ownRequest = !!store && store.sellerId === requester.id;
    }
    if (ownRequest) effectiveStatus = status;
  }

  const where = {
    ...(categoryId ? { categoryId } : {}),
    ...(storeId ? { storeId } : {}),
    ...(type ? { type } : {}),
    status: effectiveStatus,
    // Inactive products (seller-paused) are hidden from the public/customer catalogue,
    // but a staff member or the owning seller browsing their own store can still see them.
    // Same reasoning for a suspended store / soft-deleted seller (see removeSeller() in
    // sellers.service.js): the public catalogue must never surface a product whose store
    // has been suspended or whose owner has been soft-deleted, even if the product row
    // itself still carries an APPROVED status from before that happened.
    ...(ownRequest ? {} : { isActive: true, store: { status: { not: 'SUSPENDED' }, seller: { deletedAt: null } } }),
    ...(inStock ? { stock: { gt: 0 } } : {}),
    ...(q ? {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { category: { name: { contains: q, mode: 'insensitive' } } },
      ],
    } : {}),
    ...(minPrice || maxPrice ? { price: { ...(minPrice ? { gte: minPrice } : {}), ...(maxPrice ? { lte: maxPrice } : {}) } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where, include: publicInclude, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' },
    }),
    prisma.product.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

async function getById(id, requester) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      ...publicInclude,
      store: {
        select: {
          ...publicInclude.store.select, sellerId: true, status: true, seller: { select: { deletedAt: true } },
        },
      },
    },
  });
  if (!product) throw ApiError.notFound('محصول یافت نشد');

  const isOwner = !!requester && product.store.sellerId === requester.id;
  const isStaff = canModerate(requester);
  if (product.status !== 'APPROVED' && !isStaff && !isOwner) {
    throw ApiError.notFound('محصول یافت نشد');
  }
  if (!product.isActive && !isStaff && !isOwner) {
    throw ApiError.notFound('محصول یافت نشد');
  }
  // Same rule as the public list(): a suspended store or a soft-deleted seller's
  // product must not be individually viewable either, for the same non-staff/
  // non-owner audience (see removeSeller() in sellers.service.js).
  const storeDisabled = product.store.status === 'SUSPENDED' || !!product.store.seller.deletedAt;
  if (storeDisabled && !isStaff && !isOwner) {
    throw ApiError.notFound('محصول یافت نشد');
  }

  delete product.store.sellerId; // internal id, not part of the public product shape
  delete product.store.status;
  delete product.store.seller; // internal moderation fields, not part of the public product shape
  return product;
}

async function getOwnerUserId(productId) {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { store: true } });
  return product ? product.store.sellerId : null;
}

async function create(userId, data, actor) {
  const { storeId: requestedStoreId, images, wholesaleTiers, ...rest } = data;
  const staff = canModerate(actor);

  let store;
  if (requestedStoreId) {
    // Only a staff member (admin/super_admin, via PRODUCTS_MODERATE) may pick
    // an arbitrary store — a seller can never use this to create a product
    // under a store they don't own (privilege-escalation guard).
    if (!staff) throw ApiError.forbidden('امکان ثبت محصول برای فروشگاه دیگر وجود ندارد');
    store = await prisma.store.findUnique({ where: { id: requestedStoreId } });
    if (!store) throw ApiError.notFound('فروشگاه یافت نشد');
    if (store.status !== 'APPROVED') throw ApiError.badRequest('فروشگاه انتخاب‌شده تایید نشده است');
  } else {
    store = await prisma.store.findUnique({ where: { sellerId: userId } });
    if (!store) throw ApiError.forbidden('برای ثبت محصول باید فروشگاه تایید شده داشته باشید');
    if (store.status !== 'APPROVED') throw ApiError.forbidden('فروشگاه شما هنوز تایید نشده است');
  }
  await assertCategoryUsable(data.categoryId);

  // A product a staff member creates directly doesn't need to await its own
  // approval — it's published immediately. A seller's own submission still
  // goes through the normal PENDING -> moderate() flow.
  const product = await prisma.product.create({
    data: {
      ...rest,
      storeId: store.id,
      slug: `${slugify(data.name)}-${Date.now().toString(36)}`,
      ...(staff ? { status: 'APPROVED', reviewedById: actor.id, reviewedAt: new Date() } : {}),
      images: images ? { create: images.map((url, i) => ({ url, position: i })) } : undefined,
      wholesaleTiers: wholesaleTiers ? { create: wholesaleTiers } : undefined,
    },
    include: publicInclude,
  });

  if (!staff) {
    await pushNotification({
      icon: 'i-box', text: `محصول جدید «${product.name}» از فروشگاه «${store.name}» برای بررسی ارسال شد`, scope: 'ROLE', targetRole: 'ADMIN',
    });
  }
  return product;
}

/**
 * Every mutating owner-scoped action shares the same rule: the requester must
 * either own the product's store, or hold the staff override (admin /
 * super_admin via PRODUCTS_MODERATE or the '*' wildcard). Centralized here so
 * "admin has full access" can't silently regress in one action but not another.
 */
function assertCanManage(product, actor) {
  const isOwner = product.store.sellerId === actor.id;
  if (!isOwner && !canModerate(actor)) throw ApiError.forbidden('شما مالک این محصول نیستید');
}

async function update(productId, actor, data) {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { store: true, images: true } });
  if (!product) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(product, actor);
  if (data.categoryId) await assertCategoryUsable(data.categoryId);

  const { images, wholesaleTiers, ...rest } = data;
  // `images: { deleteMany: {}, create: [...] }` below replaces the whole
  // gallery, so any previously-local (`/uploads/...`) file whose URL isn't
  // in the new list is genuinely being dropped, not just re-ordered — that
  // file must be removed from disk or it becomes an orphan (mirrors the
  // cleanup hero.service.js already does on its image replace/delete).
  const droppedImageUrls = images
    ? product.images.map((img) => img.url).filter((url) => !images.includes(url))
    : [];

  const updated = await prisma.product.update({
    where: { id: productId },
    data: {
      ...rest,
      // Editing resets moderation status — a changed product must be re-approved.
      // Any earlier rejection note no longer applies to this new revision.
      status: 'PENDING',
      rejectReason: null,
      ...(images ? { images: { deleteMany: {}, create: images.map((url, i) => ({ url, position: i })) } } : {}),
      ...(wholesaleTiers ? { wholesaleTiers: { deleteMany: {}, create: wholesaleTiers } } : {}),
    },
    include: publicInclude,
  });

  droppedImageUrls.forEach(deleteLocalUpload); // no-op for external (non-/uploads/) URLs
  return updated;
}

async function remove(productId, actor) {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { store: true, images: true } });
  if (!product) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(product, actor);

  // A product that already appears in one or more orders must never be
  // hard-deleted — doing so would corrupt that order's history (and, absent
  // this check, would otherwise surface as an opaque FK-constraint error).
  const orderItemCount = await prisma.orderItem.count({ where: { productId } });
  if (orderItemCount > 0) {
    throw ApiError.conflict('این محصول دارای سابقه سفارش است و امکان حذف آن وجود ندارد');
  }

  await prisma.product.delete({ where: { id: productId } });
  // Only after the DB row is actually gone: drop its gallery files from disk
  // so a deleted product doesn't leave orphaned uploads behind.
  product.images.forEach((img) => deleteLocalUpload(img.url));
}

/**
 * Dedicated inventory-management endpoint. Distinct from `update()` on purpose:
 * a stock change is an operational action (restock/sell-through), not a content
 * edit, so it must NOT reset the product back to PENDING moderation.
 *
 * INCREMENT/DECREMENT are done as atomic, single-statement DB updates (not a
 * read-modify-write) so two concurrent sales can't race and both succeed
 * against a stock count that only had room for one — a `stock: { gte }` guard
 * is baked into the WHERE clause of the decrement itself.
 */
async function updateStock(productId, actor, { stock, mode = 'SET' }) {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { store: true } });
  if (!product) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(product, actor);

  if (mode === 'DECREMENT') {
    const result = await prisma.product.updateMany({
      where: { id: productId, stock: { gte: stock } },
      data: { stock: { decrement: stock } },
    });
    if (result.count === 0) throw ApiError.badRequest('موجودی کافی نیست');
  } else if (mode === 'INCREMENT') {
    await prisma.product.update({ where: { id: productId }, data: { stock: { increment: stock } } });
  } else {
    if (stock < 0) throw ApiError.badRequest('موجودی نمی‌تواند منفی باشد');
    await prisma.product.update({ where: { id: productId }, data: { stock } });
  }

  return prisma.product.findUnique({ where: { id: productId }, include: publicInclude });
}

/**
 * Seller-controlled visibility toggle (active/inactive). Independent from the
 * admin moderation `status` — pausing a product for sale doesn't require
 * (or trigger) re-approval.
 */
async function toggleActive(productId, actor, isActive) {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { store: true } });
  if (!product) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(product, actor);

  return prisma.product.update({
    where: { id: productId },
    data: { isActive },
    include: publicInclude,
  });
}

async function moderate(productId, { status, note }, actor) {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { store: { include: { seller: true } } } });
  if (!product) throw ApiError.notFound('محصول یافت نشد');

  // A product whose store has been suspended, or whose owning seller has been
  // soft-deleted (see removeSeller() in sellers.service.js), must never be
  // (re-)approved through moderation — mirrors the identical guard on
  // stores.service.js moderate() for the store itself.
  if (status === 'APPROVED' && product.store
      && (product.store.status === 'SUSPENDED' || (product.store.seller && product.store.seller.deletedAt))) {
    throw ApiError.conflict('این محصول متعلق به فروشگاهی است که مسدود یا فروشنده آن حذف شده — امکان تایید آن وجود ندارد');
  }

  const updated = await prisma.product.update({
    where: { id: productId },
    data: {
      status,
      reviewedById: actor.id,
      reviewedAt: new Date(),
      // Persisted so it's visible on every later fetch (seller's own product
      // list, admin panel) — not just the one-off notification pushed below.
      // A later APPROVED moderation clears out any earlier rejection note.
      rejectReason: status === 'REJECTED' ? (note || null) : null,
    },
    include: publicInclude,
  });

  await logAdminActivity(actor.id, `${status === 'APPROVED' ? 'تایید' : 'رد'} محصول «${product.name}»`);
  await pushNotification({
    icon: status === 'APPROVED' ? 'i-check' : 'i-x',
    text: `محصول «${product.name}» ${status === 'APPROVED' ? 'تایید' : 'رد'} شد${note ? `: ${note}` : ''}`,
    scope: 'USER',
    targetUserId: product.store.sellerId,
  });
  return updated;
}

/**
 * Add one image to a product's gallery. Ownership (or staff override) is
 * enforced the same way as every other mutating action; a per-product cap
 * (MAX_IMAGES) stops a seller from uploading an unbounded gallery.
 */
async function addImage(productId, actor, url) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { store: true, images: true },
  });
  if (!product) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(product, actor);
  if (product.images.length >= MAX_IMAGES) {
    throw ApiError.badRequest(`حداکثر ${MAX_IMAGES} تصویر برای هر محصول مجاز است`);
  }

  const nextPosition = product.images.length;
  return prisma.productImage.create({ data: { productId, url, position: nextPosition } });
}

/**
 * Remove one image. The image row must actually belong to the product in
 * the URL — without this check a seller could pass any imageId and delete
 * another seller's image (an IDOR), since ProductImage has no owner field
 * of its own to check against.
 */
async function removeImage(productId, imageId, actor) {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { store: true } });
  if (!product) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(product, actor);

  const image = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!image || image.productId !== productId) throw ApiError.notFound('تصویر یافت نشد');

  await prisma.productImage.delete({ where: { id: imageId } });
  deleteLocalUpload(image.url); // no-op for external (non-/uploads/) URLs
}

module.exports = {
  list, getById, getOwnerUserId, create, update, remove, moderate, updateStock, toggleActive, addImage, removeImage,
};
