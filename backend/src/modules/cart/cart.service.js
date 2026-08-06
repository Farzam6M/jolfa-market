const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { computeEffectivePrice } = require('../../utils/pricing');
const { flattenStoreProduct } = require('../products/products.service');

const SHIPPING_FEE = 45000; // flat shipping fee applied whenever the cart isn't empty — mirrors frontend CART_SHIPPING

// NOTE: a cart line item is a specific STORE's offer (price/stock are
// per-store), not the shared global Product — see products.service.js for
// the Product/StoreProduct split. Internally the relation is `storeProduct`;
// the response is flattened back to the pre-split `product`/`productId`
// shape (via flattenStoreProduct) so callers of this API don't need to change.
const itemInclude = { storeProduct: { include: { images: true, store: true, wholesaleTiers: true, product: true } } };

function flattenCart(cart) {
  return {
    ...cart,
    items: cart.items.map((it) => {
      const { storeProduct, ...rest } = it;
      return { ...rest, productId: it.storeProductId, product: flattenStoreProduct(storeProduct) };
    }),
  };
}

async function getOrCreateCart(userId) {
  let cart = await prisma.cart.findUnique({ where: { userId }, include: { items: { include: itemInclude } } });
  if (!cart) {
    cart = await prisma.cart.create({ data: { userId }, include: { items: { include: itemInclude } } });
  }
  return cart;
}

function withTotals(cart) {
  const subtotal = cart.items.reduce((s, it) => s + Number(it.priceSnapshot) * it.qty, 0);
  const shipping = cart.items.length ? SHIPPING_FEE : 0;
  return { ...flattenCart(cart), totals: { subtotal, shipping, total: subtotal + shipping } };
}

async function getCart(userId) {
  return withTotals(await getOrCreateCart(userId));
}

/**
 * Adding is capped at the product's real stock, counting what's ALREADY in
 * the cart — checking only the incoming `qty` (the original behavior) let a
 * customer add 3, then 3 more, and end up with 6 in the cart against a
 * product that only had 5 in stock. This is a UX/consistency guard, not the
 * security boundary — checkout re-validates and atomically decrements stock
 * regardless, so this can't itself be used to oversell.
 */
async function addItem(userId, { productId, qty }) {
  const storeProductId = productId; // route/body param name kept for API compatibility
  const storeProduct = await prisma.storeProduct.findUnique({
    where: { id: storeProductId },
    include: { wholesaleTiers: true, store: { select: { status: true, seller: { select: { deletedAt: true } } } } },
  });
  if (!storeProduct || storeProduct.status !== 'APPROVED' || !storeProduct.isActive) {
    throw ApiError.notFound('محصول یافت نشد یا در دسترس نیست');
  }
  // Same rule already enforced for public browsing (see products.service.js
  // list()/getById()): a product whose store has been suspended or whose
  // seller has been soft-deleted (removeSeller()) must not be addable to the
  // cart either, even if the product row itself still carries an
  // APPROVED/isActive state from before that happened.
  if (!storeProduct.store || storeProduct.store.status === 'SUSPENDED' || !storeProduct.store.seller || storeProduct.store.seller.deletedAt) {
    throw ApiError.notFound('محصول یافت نشد یا در دسترس نیست');
  }

  const cart = await getOrCreateCart(userId);
  const existing = cart.items.find((it) => it.storeProductId === storeProductId);
  const desiredQty = (existing ? existing.qty : 0) + qty;
  if (desiredQty > storeProduct.stock) throw ApiError.badRequest('موجودی کافی نیست');

  // priceSnapshot always reflects the product's CURRENT price/wholesale tier
  // (for desiredQty) — both on first add and on every re-add — so it can
  // never drift stale against a later price change.
  const priceSnapshot = computeEffectivePrice(storeProduct, desiredQty);

  await prisma.cartItem.upsert({
    where: { cartId_storeProductId: { cartId: cart.id, storeProductId } },
    update: { qty: { increment: qty }, priceSnapshot },
    create: {
      cartId: cart.id, storeProductId, qty, priceSnapshot,
    },
  });
  return getCart(userId);
}

async function updateItem(userId, itemId, qty) {
  const cart = await getOrCreateCart(userId);
  const item = cart.items.find((it) => it.id === itemId);
  if (!item) throw ApiError.notFound('کالا در سبد خرید یافت نشد');
  if (qty > item.storeProduct.stock) throw ApiError.badRequest('موجودی کافی نیست');

  const priceSnapshot = computeEffectivePrice(item.storeProduct, qty);
  await prisma.cartItem.update({ where: { id: itemId }, data: { qty, priceSnapshot } });
  return getCart(userId);
}

async function removeItem(userId, itemId) {
  const cart = await getOrCreateCart(userId);
  const item = cart.items.find((it) => it.id === itemId);
  if (!item) throw ApiError.notFound('کالا در سبد خرید یافت نشد');
  await prisma.cartItem.delete({ where: { id: itemId } });
  return getCart(userId);
}

async function clear(userId) {
  const cart = await getOrCreateCart(userId);
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  return getCart(userId);
}

module.exports = {
  getCart, addItem, updateItem, removeItem, clear, getOrCreateCart, SHIPPING_FEE,
};
