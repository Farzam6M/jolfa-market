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

// ── identityKey ──────────────────────────────────────────────────────
// Deterministic normalization of a product's identity fields, so that
// two stores submitting "the same" product (however they typed it —
// different casing, extra spaces, a field left blank) resolve to the
// SAME global Product row. This — not slug — is the actual dedup key
// (Product.identityKey is UNIQUE at the DB level; see point 2/6).
function normalizeIdentityPart(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildIdentityKey({
  name, brand, model, capacity, color,
}) {
  return [name, brand, model, capacity, color].map(normalizeIdentityPart).join('|');
}

const publicInclude = {
  product: { include: { category: true } },
  images: { orderBy: { position: 'asc' } },
  wholesaleTiers: true,
  store: { select: { id: true, name: true, slug: true, logoUrl: true, rating: true } },
};

// The single definition of "this offer is publicly/customer visible" —
// reused by the public where-clause in list() (inlined there, unchanged)
// AND by the offerCount aggregate below, so the two can never drift apart:
// an offer that wouldn't appear in the public catalogue can never be
// counted in "Available in X stores" either.
const VISIBLE_OFFER_WHERE = {
  status: 'APPROVED',
  isActive: true,
  store: { status: { not: 'SUSPENDED' }, seller: { deletedAt: null } },
};

/**
 * The API/route contract predates the Product/StoreProduct split (routes
 * still address a single :id, callers still expect name/brand/slug/etc.
 * flat on the product object) — this flattens a StoreProduct + its nested
 * global Product back into that shape so nothing outside this file has to
 * change. `id` stays the StoreProduct id (it's what carts/orders/wishlist/
 * reviews/routes actually address); `productId` exposes the global
 * Product id for anything that wants to reference the shared identity
 * directly (e.g. "same product, other stores" lookups).
 */
function flattenStoreProduct(sp) {
  if (!sp) return sp;
  const { product, ...storeFields } = sp;
  return {
    ...product,
    ...storeFields,
    id: sp.id,
    productId: sp.productId,
  };
}

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
    ...(categoryId ? { product: { categoryId } } : {}),
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
        { product: { name: { contains: q, mode: 'insensitive' } } },
        { product: { brand: { contains: q, mode: 'insensitive' } } },
        { product: { description: { contains: q, mode: 'insensitive' } } },
        { product: { category: { name: { contains: q, mode: 'insensitive' } } } },
      ],
    } : {}),
    ...(minPrice || maxPrice ? { price: { ...(minPrice ? { gte: minPrice } : {}), ...(maxPrice ? { lte: maxPrice } : {}) } } : {}),
  };

  // `ownRequest` (see above) is only true for a staff member moderating, or a
  // seller browsing their OWN store's offers — both of those genuinely need
  // one row per StoreProduct (an admin approves/rejects each store's
  // submission individually; a seller manages each of their own listings
  // individually). Every OTHER caller here is public/customer browsing
  // (global search, category pages, the general catalogue — with or without
  // a `storeId` filter), where the real-world unit being searched/listed is
  // the shared, platform-wide Product — a single item that happens to be
  // sold by 1..N stores must appear once, not once per store (see
  // buildProductLevelPage() below for why this is safe/necessary).
  if (!ownRequest) {
    return buildProductLevelPage(where, page, pageSize);
  }

  const [items, total] = await Promise.all([
    prisma.storeProduct.findMany({
      where, include: publicInclude, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' },
    }),
    prisma.storeProduct.count({ where }),
  ]);
  return { items: items.map(flattenStoreProduct), total, page, pageSize };
}

/**
 * Public/customer-facing product listing, de-duplicated to ONE row per
 * global Product — even though the underlying table being filtered
 * (StoreProduct) can hold several rows for the same Product (one per store
 * that sells it). Without this, searching/browsing for "iPhone 16 Pro"
 * sold by 3 stores would return 3 separate cards for what is, from the
 * customer's point of view, one product.
 *
 * Approach (kept as plain Prisma — no raw SQL, no schema change):
 *   1. `distinct: ['productId']` gives one StoreProduct row per Product
 *      that matches `where`, using `orderBy` to pick a deterministic
 *      "representative" row per group and to drive the page ordering —
 *      same default ordering (newest first) as the previous behavior.
 *   2. A second `distinct` query (id-only, unpaginated) gives the true
 *      total *Product* count for pagination — counting StoreProduct rows
 *      directly would over-count any product sold by 2+ stores.
 *   3. For the page of productIds picked in step 1, the actual cheapest
 *      matching offer is fetched (with the full include) to represent
 *      that product in the response — a customer searching/browsing sees
 *      each product at its best available price, without the response
 *      shape changing (still a flattened Product+offer object; carts/
 *      wishlist/reviews are untouched — they already address a specific
 *      StoreProduct id, same as before).
 *   4. `offerCount` (how many stores currently, visibly sell this exact
 *      Product) is attached to each item via ONE extra groupBy query
 *      scoped to just this page's productIds — not a per-item query, so
 *      this stays O(1) additional round-trips per page regardless of page
 *      size (no N+1). It always reflects VISIBLE_OFFER_WHERE (APPROVED +
 *      isActive + non-suspended store + non-deleted seller), independent
 *      of this call's own search-only filters (q/minPrice/maxPrice/
 *      categoryId/storeId/type) — those narrow WHICH products show up,
 *      not how many stores a shown product is actually available from.
 */
async function buildProductLevelPage(where, page, pageSize) {
  const [pageAnchors, allMatches] = await Promise.all([
    prisma.storeProduct.findMany({
      where,
      distinct: ['productId'],
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { productId: true },
    }),
    prisma.storeProduct.findMany({
      where, distinct: ['productId'], select: { productId: true },
    }),
  ]);
  const total = allMatches.length;
  const productIds = pageAnchors.map((r) => r.productId);
  if (productIds.length === 0) return { items: [], total, page, pageSize };

  const [offers, offerCounts] = await Promise.all([
    prisma.storeProduct.findMany({
      where: { ...where, productId: { in: productIds } },
      include: publicInclude,
      orderBy: { price: 'asc' }, // cheapest offer per product wins the representative slot below
    }),
    prisma.storeProduct.groupBy({
      by: ['productId'],
      where: { ...VISIBLE_OFFER_WHERE, productId: { in: productIds } },
      _count: { _all: true },
    }),
  ]);
  const bestOfferByProduct = new Map();
  offers.forEach((offer) => {
    if (!bestOfferByProduct.has(offer.productId)) bestOfferByProduct.set(offer.productId, offer);
  });
  const offerCountByProduct = new Map(offerCounts.map((row) => [row.productId, row._count._all]));

  // Preserve the ordering already decided by pageAnchors (newest-product-first),
  // not the price-ascending order `offers` was fetched in.
  const items = productIds
    .map((id) => bestOfferByProduct.get(id))
    .filter(Boolean)
    .map((offer) => ({
      ...flattenStoreProduct(offer),
      // Falls back to 1 only in the defensive case where the representative
      // offer itself (already known visible, since it matched `where`) isn't
      // found in the groupBy for some reason — never 0 for a product that's
      // actually being shown.
      offerCount: offerCountByProduct.get(offer.productId) || 1,
    }));
  return { items, total, page, pageSize };
}

async function getById(id, requester) {
  const storeProduct = await prisma.storeProduct.findUnique({
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
  if (!storeProduct) throw ApiError.notFound('محصول یافت نشد');

  const isOwner = !!requester && storeProduct.store.sellerId === requester.id;
  const isStaff = canModerate(requester);
  if (storeProduct.status !== 'APPROVED' && !isStaff && !isOwner) {
    throw ApiError.notFound('محصول یافت نشد');
  }
  if (!storeProduct.isActive && !isStaff && !isOwner) {
    throw ApiError.notFound('محصول یافت نشد');
  }
  // Same rule as the public list(): a suspended store or a soft-deleted seller's
  // product must not be individually viewable either, for the same non-staff/
  // non-owner audience (see removeSeller() in sellers.service.js).
  const storeDisabled = storeProduct.store.status === 'SUSPENDED' || !!storeProduct.store.seller.deletedAt;
  if (storeDisabled && !isStaff && !isOwner) {
    throw ApiError.notFound('محصول یافت نشد');
  }

  const flat = flattenStoreProduct(storeProduct);
  delete flat.store.sellerId; // internal id, not part of the public product shape
  delete flat.store.status;
  delete flat.store.seller; // internal moderation fields, not part of the public product shape
  return flat;
}

async function getOwnerUserId(storeProductId) {
  const storeProduct = await prisma.storeProduct.findUnique({ where: { id: storeProductId }, include: { store: true } });
  return storeProduct ? storeProduct.store.sellerId : null;
}

/**
 * GET /products/:productId/offers — the true multi-vendor view: one global
 * Product plus every store's live, purchasable offer for it, cheapest first.
 *
 * `productId` here is the GLOBAL Product id (Product.id), NOT a StoreProduct
 * id — every other :id route in this router addresses a StoreProduct, so
 * this is intentionally a distinct path (see products.routes.js) rather than
 * a change to the existing GET /:id contract (which stays untouched for
 * backward compatibility with the admin panel's flat-StoreProduct usage).
 *
 * Visibility mirrors the public list()/getById() rule exactly — never an
 * independent, looser filter: an offer is only included if its own
 * moderation status/visibility toggle AND its store's status AND its
 * seller's (non-)deletion all say "live", same as the public catalogue.
 */
async function getOffersByProduct(productId) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { category: true },
  });
  if (!product) throw ApiError.notFound('محصول یافت نشد');

  const offers = await prisma.storeProduct.findMany({
    where: {
      productId,
      status: 'APPROVED',
      isActive: true,
      store: { status: { not: 'SUSPENDED' }, seller: { deletedAt: null } },
    },
    include: {
      images: { orderBy: { position: 'asc' } },
      wholesaleTiers: true,
      store: { select: { id: true, name: true, slug: true, logoUrl: true, rating: true } },
    },
    orderBy: { price: 'asc' }, // cheapest offer first, per spec
  });

  return {
    product,
    offers: offers.map((offer) => ({
      // The purchasable identifier — this IS the StoreProduct id, exactly
      // what POST /cart/items / wishlist / reviews already expect as
      // `productId` (see cart.service.js / wishlist.service.js) — no new
      // identifier scheme introduced here.
      id: offer.id,
      store: offer.store,
      price: offer.price,
      compareAtPrice: offer.compareAtPrice,
      stock: offer.stock,
      warranty: offer.warranty,
      shippingTime: offer.shippingTime,
      discount: offer.discount,
      type: offer.type,
      images: offer.images,
      wholesaleTiers: offer.wholesaleTiers,
    })),
  };
}

/**
 * Find the global Product for this identity, or create it if this is the
 * first time ANY store has submitted it. Race-safe: if two requests for
 * the same new product run concurrently, only one `create` wins — the
 * loser catches the unique(identityKey) violation and re-fetches the
 * winner's row instead of erroring out (point 6 — DB constraint is the
 * real guard, this is just making that race resolve gracefully instead
 * of surfacing a 500).
 */
async function findOrCreateProduct(identity) {
  const identityKey = buildIdentityKey(identity);
  const existing = await prisma.product.findUnique({ where: { identityKey } });
  if (existing) return existing;

  try {
    return await prisma.product.create({
      data: {
        name: identity.name,
        brand: identity.brand || null,
        model: identity.model || null,
        capacity: identity.capacity || null,
        color: identity.color || null,
        description: identity.description || null,
        specifications: identity.specifications ?? undefined,
        categoryId: identity.categoryId || null,
        slug: `${slugify(identity.name)}-${Date.now().toString(36)}`,
        identityKey,
      },
    });
  } catch (err) {
    if (err.code === 'P2002' && err.meta?.target?.includes('identityKey')) {
      const winner = await prisma.product.findUnique({ where: { identityKey } });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Create (or, if this store already carries an offer for this exact
 * global product, UPDATE) the StoreProduct row. Race-safe the same way
 * as findOrCreateProduct: `@@unique([storeId, productId])` is the real
 * guard, the findFirst-then-create here is just the happy path — a lost
 * race falls back to the update path instead of erroring.
 */
async function upsertStoreOffer(store, product, offer, staff, actor) {
  const existing = await prisma.storeProduct.findUnique({
    where: { storeId_productId: { storeId: store.id, productId: product.id } },
  });
  if (existing) {
    return applyStoreProductUpdate(existing, offer, staff, actor, { isNewSubmission: true });
  }

  try {
    return await prisma.storeProduct.create({
      data: {
        storeId: store.id,
        productId: product.id,
        price: offer.price,
        compareAtPrice: offer.compareAtPrice,
        stock: offer.stock,
        warranty: offer.warranty,
        shippingTime: offer.shippingTime,
        discount: offer.discount,
        type: offer.type,
        ...(staff ? { status: 'APPROVED', reviewedById: actor.id, reviewedAt: new Date() } : {}),
        images: offer.images ? { create: offer.images.map((url, i) => ({ url, position: i })) } : undefined,
        wholesaleTiers: offer.wholesaleTiers ? { create: offer.wholesaleTiers } : undefined,
      },
      include: publicInclude,
    });
  } catch (err) {
    if (err.code === 'P2002' && err.meta?.target?.includes('storeId')) {
      const winner = await prisma.storeProduct.findUnique({
        where: { storeId_productId: { storeId: store.id, productId: product.id } },
      });
      if (winner) return applyStoreProductUpdate(winner, offer, staff, actor, { isNewSubmission: true });
    }
    throw err;
  }
}

/**
 * Shared update path for an existing StoreProduct row — used both by the
 * ordinary PATCH /:id flow AND by create() when a store re-submits a
 * product it already has an offer for (point 5: no duplicate row, the
 * existing offer is updated "according to the existing business
 * behavior", i.e. the same rules update() already applied: editing
 * resets moderation to PENDING and clears any old rejection note, unless
 * a staff member is the one doing it).
 */
async function applyStoreProductUpdate(storeProduct, data, staff, actor, { isNewSubmission = false } = {}) {
  const { images, wholesaleTiers, ...rest } = data;

  const existingImages = isNewSubmission
    ? await prisma.productImage.findMany({ where: { storeProductId: storeProduct.id } })
    : storeProduct.images;
  const droppedImageUrls = images
    ? (existingImages || []).map((img) => img.url).filter((url) => !images.includes(url))
    : [];

  const updated = await prisma.storeProduct.update({
    where: { id: storeProduct.id },
    data: {
      ...rest,
      status: staff ? 'APPROVED' : 'PENDING',
      rejectReason: null,
      ...(staff ? { reviewedById: actor.id, reviewedAt: new Date() } : {}),
      ...(images ? { images: { deleteMany: {}, create: images.map((url, i) => ({ url, position: i })) } } : {}),
      ...(wholesaleTiers ? { wholesaleTiers: { deleteMany: {}, create: wholesaleTiers } } : {}),
    },
    include: publicInclude,
  });

  droppedImageUrls.forEach(deleteLocalUpload); // no-op for external (non-/uploads/) URLs
  return updated;
}

async function create(userId, data, actor) {
  const {
    storeId: requestedStoreId, images, wholesaleTiers,
    name, brand, model, capacity, color, description, specifications, categoryId,
    price, compareAtPrice, stock, warranty, shippingTime, discount, type,
  } = data;
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
  await assertCategoryUsable(categoryId);

  // Step 2/3/4: identity resolution — reuse the global Product if one
  // already matches this identityKey, otherwise create exactly one.
  const product = await findOrCreateProduct({
    name, brand, model, capacity, color, description, specifications, categoryId,
  });

  // Step 5/6: one offer per (store, product) — reuse+update if this store
  // already has one, otherwise create it.
  const wasExisting = !!(await prisma.storeProduct.findUnique({
    where: { storeId_productId: { storeId: store.id, productId: product.id } },
    select: { id: true },
  }));

  // A product a staff member creates directly doesn't need to await its own
  // approval — it's published immediately. A seller's own submission still
  // goes through the normal PENDING -> moderate() flow.
  const storeProduct = await upsertStoreOffer(store, product, {
    price, compareAtPrice, stock, warranty, shippingTime, discount, type, images, wholesaleTiers,
  }, staff, actor);

  if (!staff) {
    await pushNotification({
      icon: 'i-box', text: `محصول ${wasExisting ? 'به‌روزرسانی‌شده' : 'جدید'} «${product.name}» از فروشگاه «${store.name}» برای بررسی ارسال شد`, scope: 'ROLE', targetRole: 'ADMIN',
    });
  }
  return flattenStoreProduct(storeProduct);
}

/**
 * Every mutating owner-scoped action shares the same rule: the requester must
 * either own the product's store, or hold the staff override (admin /
 * super_admin via PRODUCTS_MODERATE or the '*' wildcard). Centralized here so
 * "admin has full access" can't silently regress in one action but not another.
 *
 * A seller's account being suspended/banned is already caught upstream by
 * auth.middleware.js (status != ACTIVE never even reaches here). What's NOT
 * caught upstream is a store being suspended while the seller's own account
 * stays ACTIVE (stores.service.js moderate() can do this independently) —
 * so that's checked here explicitly: a suspended store's owner can still log
 * in, but can no longer edit/manage its offers. Staff keep full access
 * regardless (e.g. to archive/clean up a suspended store's listings).
 */
function assertCanManage(storeProduct, actor) {
  const isOwner = storeProduct.store.sellerId === actor.id;
  const staff = canModerate(actor);
  if (!isOwner && !staff) throw ApiError.forbidden('شما مالک این محصول نیستید');
  if (isOwner && !staff && storeProduct.store.status === 'SUSPENDED') {
    throw ApiError.forbidden('فروشگاه شما مسدود شده و امکان مدیریت محصولات وجود ندارد');
  }
}

async function update(storeProductId, actor, data) {
  const storeProduct = await prisma.storeProduct.findUnique({ where: { id: storeProductId }, include: { store: true, images: true, product: true } });
  if (!storeProduct) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(storeProduct, actor);

  // Identity fields (name/brand/model/capacity/color/description/specifications/
  // categoryId) live on the shared global Product now, not on this seller's
  // offer — every store selling this product shows the same values, so a
  // plain seller (even the owner of THIS StoreProduct) must not be able to
  // change them: doing so would silently edit what every other store's
  // listing displays too. Only staff (admin/super_admin, via
  // PRODUCTS_MODERATE) may touch these — a seller submitting them is
  // rejected outright rather than having them silently dropped, so the
  // seller gets a clear signal instead of a request that "succeeded" but
  // quietly ignored half of what they sent.
  const {
    name, brand, model, capacity, color, description, specifications, categoryId, ...offerRest
  } = data;
  const touchesIdentity = [name, brand, model, capacity, color, description, specifications, categoryId]
    .some((v) => v !== undefined);
  const staff = canModerate(actor);

  if (touchesIdentity && !staff) {
    throw ApiError.forbidden('ویرایش مشخصات محصول (نام، برند، مدل، دسته‌بندی و توضیحات) فقط توسط ادمین امکان‌پذیر است — این فیلدها مشترک بین همه فروشگاه‌ها هستند');
  }

  if (categoryId) await assertCategoryUsable(categoryId);

  if (touchesIdentity) {
    const nextIdentity = {
      name: name ?? storeProduct.product.name,
      brand: brand ?? storeProduct.product.brand,
      model: model ?? storeProduct.product.model,
      capacity: capacity ?? storeProduct.product.capacity,
      color: color ?? storeProduct.product.color,
    };
    const identityKey = buildIdentityKey(nextIdentity);
    if (identityKey !== storeProduct.product.identityKey) {
      // Renaming this offer's product into an identity that matches a
      // DIFFERENT existing Product isn't a content edit — the seller
      // should submit that as a fresh offer against the existing product
      // instead, so their store's price/stock don't silently overwrite
      // an unrelated shared Product row.
      const clash = await prisma.product.findUnique({ where: { identityKey } });
      if (clash && clash.id !== storeProduct.productId) {
        throw ApiError.conflict('این مشخصات با یک محصول دیگر یکسان است — لطفاً به‌جای ویرایش، پیشنهاد جدیدی برای همان محصول ثبت کنید');
      }
      await prisma.product.update({
        where: { id: storeProduct.productId },
        data: {
          ...nextIdentity,
          description: description ?? storeProduct.product.description,
          specifications: specifications ?? undefined,
          categoryId: categoryId ?? storeProduct.product.categoryId,
          identityKey,
        },
      });
    } else if (description !== undefined || specifications !== undefined || categoryId !== undefined) {
      await prisma.product.update({
        where: { id: storeProduct.productId },
        data: {
          ...(description !== undefined ? { description } : {}),
          ...(specifications !== undefined ? { specifications } : {}),
          ...(categoryId !== undefined ? { categoryId } : {}),
        },
      });
    }
  }

  // Everything left in offerRest is StoreProduct-scoped (price/compareAtPrice/
  // stock/warranty/shippingTime/discount/type/images/wholesaleTiers — the exact
  // set updateSchema accepts beyond the identity fields above); `staff` here
  // only affects whether this re-submission needs re-moderation, same as create().
  return flattenStoreProduct(await applyStoreProductUpdate(storeProduct, offerRest, staff, actor));
}

async function remove(storeProductId, actor) {
  const storeProduct = await prisma.storeProduct.findUnique({ where: { id: storeProductId }, include: { store: true, images: true } });
  if (!storeProduct) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(storeProduct, actor);

  // A product that already appears in one or more orders must never be
  // hard-deleted — doing so would corrupt that order's history (and, absent
  // this check, would otherwise surface as an opaque FK-constraint error).
  const orderItemCount = await prisma.orderItem.count({ where: { storeProductId } });
  if (orderItemCount > 0) {
    throw ApiError.conflict('این محصول دارای سابقه سفارش است و امکان حذف آن وجود ندارد');
  }

  await prisma.storeProduct.delete({ where: { id: storeProductId } });
  // Only after the DB row is actually gone: drop its gallery files from disk
  // so a deleted product doesn't leave orphaned uploads behind. The shared
  // global Product row is left untouched — other stores may still offer it.
  storeProduct.images.forEach((img) => deleteLocalUpload(img.url));
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
async function updateStock(storeProductId, actor, { stock, mode = 'SET' }) {
  const storeProduct = await prisma.storeProduct.findUnique({ where: { id: storeProductId }, include: { store: true } });
  if (!storeProduct) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(storeProduct, actor);

  if (mode === 'DECREMENT') {
    const result = await prisma.storeProduct.updateMany({
      where: { id: storeProductId, stock: { gte: stock } },
      data: { stock: { decrement: stock } },
    });
    if (result.count === 0) throw ApiError.badRequest('موجودی کافی نیست');
  } else if (mode === 'INCREMENT') {
    await prisma.storeProduct.update({ where: { id: storeProductId }, data: { stock: { increment: stock } } });
  } else {
    if (stock < 0) throw ApiError.badRequest('موجودی نمی‌تواند منفی باشد');
    await prisma.storeProduct.update({ where: { id: storeProductId }, data: { stock } });
  }

  return flattenStoreProduct(await prisma.storeProduct.findUnique({ where: { id: storeProductId }, include: publicInclude }));
}

/**
 * Seller-controlled visibility toggle (active/inactive). Independent from the
 * admin moderation `status` — pausing a product for sale doesn't require
 * (or trigger) re-approval.
 */
async function toggleActive(storeProductId, actor, isActive) {
  const storeProduct = await prisma.storeProduct.findUnique({ where: { id: storeProductId }, include: { store: true } });
  if (!storeProduct) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(storeProduct, actor);

  return flattenStoreProduct(await prisma.storeProduct.update({
    where: { id: storeProductId },
    data: { isActive },
    include: publicInclude,
  }));
}

async function moderate(storeProductId, { status, note }, actor) {
  const storeProduct = await prisma.storeProduct.findUnique({ where: { id: storeProductId }, include: { store: { include: { seller: true } }, product: true } });
  if (!storeProduct) throw ApiError.notFound('محصول یافت نشد');

  // A product whose store has been suspended, or whose owning seller has been
  // soft-deleted (see removeSeller() in sellers.service.js), must never be
  // (re-)approved through moderation — mirrors the identical guard on
  // stores.service.js moderate() for the store itself.
  if (status === 'APPROVED' && storeProduct.store
      && (storeProduct.store.status === 'SUSPENDED' || (storeProduct.store.seller && storeProduct.store.seller.deletedAt))) {
    throw ApiError.conflict('این محصول متعلق به فروشگاهی است که مسدود یا فروشنده آن حذف شده — امکان تایید آن وجود ندارد');
  }

  const updated = await prisma.storeProduct.update({
    where: { id: storeProductId },
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

  await logAdminActivity(actor.id, `${status === 'APPROVED' ? 'تایید' : 'رد'} محصول «${storeProduct.product.name}»`);
  await pushNotification({
    icon: status === 'APPROVED' ? 'i-check' : 'i-x',
    text: `محصول «${storeProduct.product.name}» ${status === 'APPROVED' ? 'تایید' : 'رد'} شد${note ? `: ${note}` : ''}`,
    scope: 'USER',
    targetUserId: storeProduct.store.sellerId,
  });
  return flattenStoreProduct(updated);
}

/**
 * Add one image to a product's gallery. Ownership (or staff override) is
 * enforced the same way as every other mutating action; a per-product cap
 * (MAX_IMAGES) stops a seller from uploading an unbounded gallery.
 */
async function addImage(storeProductId, actor, url) {
  const storeProduct = await prisma.storeProduct.findUnique({
    where: { id: storeProductId },
    include: { store: true, images: true },
  });
  if (!storeProduct) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(storeProduct, actor);
  if (storeProduct.images.length >= MAX_IMAGES) {
    throw ApiError.badRequest(`حداکثر ${MAX_IMAGES} تصویر برای هر محصول مجاز است`);
  }

  const nextPosition = storeProduct.images.length;
  return prisma.productImage.create({ data: { storeProductId, url, position: nextPosition } });
}

/**
 * Remove one image. The image row must actually belong to the product in
 * the URL — without this check a seller could pass any imageId and delete
 * another seller's image (an IDOR), since ProductImage has no owner field
 * of its own to check against.
 */
async function removeImage(storeProductId, imageId, actor) {
  const storeProduct = await prisma.storeProduct.findUnique({ where: { id: storeProductId }, include: { store: true } });
  if (!storeProduct) throw ApiError.notFound('محصول یافت نشد');
  assertCanManage(storeProduct, actor);

  const image = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!image || image.storeProductId !== storeProductId) throw ApiError.notFound('تصویر یافت نشد');

  await prisma.productImage.delete({ where: { id: imageId } });
  deleteLocalUpload(image.url); // no-op for external (non-/uploads/) URLs
}

module.exports = {
  list, getById, getOwnerUserId, getOffersByProduct, create, update, remove, moderate, updateStock, toggleActive, addImage, removeImage,
  buildIdentityKey, flattenStoreProduct, // exported for tests
};
