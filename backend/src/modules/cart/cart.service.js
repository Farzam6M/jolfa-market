const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { computeEffectivePrice } = require('../../utils/pricing');

const SHIPPING_FEE = 45000; // flat shipping fee applied whenever the cart isn't empty — mirrors frontend CART_SHIPPING

async function getOrCreateCart(userId) {
  let cart = await prisma.cart.findUnique({
    where: { userId },
    include: { items: { include: { product: { include: { images: true, store: true, wholesaleTiers: true } } } } },
  });
  if (!cart) {
    cart = await prisma.cart.create({
      data: { userId },
      include: { items: { include: { product: { include: { images: true, store: true, wholesaleTiers: true } } } } },
    });
  }
  return cart;
}

function withTotals(cart) {
  const subtotal = cart.items.reduce((s, it) => s + Number(it.priceSnapshot) * it.qty, 0);
  const shipping = cart.items.length ? SHIPPING_FEE : 0;
  return { ...cart, totals: { subtotal, shipping, total: subtotal + shipping } };
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
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { wholesaleTiers: true, store: { select: { status: true, seller: { select: { deletedAt: true } } } } },
  });
  if (!product || product.status !== 'APPROVED' || !product.isActive) {
    throw ApiError.notFound('محصول یافت نشد یا در دسترس نیست');
  }
  // Same rule already enforced for public browsing (see products.service.js
  // list()/getById()): a product whose store has been suspended or whose
  // seller has been soft-deleted (removeSeller()) must not be addable to the
  // cart either, even if the product row itself still carries an
  // APPROVED/isActive state from before that happened.
  if (!product.store || product.store.status === 'SUSPENDED' || !product.store.seller || product.store.seller.deletedAt) {
    throw ApiError.notFound('محصول یافت نشد یا در دسترس نیست');
  }

  const cart = await getOrCreateCart(userId);
  const existing = cart.items.find((it) => it.productId === productId);
  const desiredQty = (existing ? existing.qty : 0) + qty;
  if (desiredQty > product.stock) throw ApiError.badRequest('موجودی کافی نیست');

  // priceSnapshot always reflects the product's CURRENT price/wholesale tier
  // (for desiredQty) — both on first add and on every re-add — so it can
  // never drift stale against a later price change.
  const priceSnapshot = computeEffectivePrice(product, desiredQty);

  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId } },
    update: { qty: { increment: qty }, priceSnapshot },
    create: {
      cartId: cart.id, productId, qty, priceSnapshot,
    },
  });
  return getCart(userId);
}

async function updateItem(userId, itemId, qty) {
  const cart = await getOrCreateCart(userId);
  const item = cart.items.find((it) => it.id === itemId);
  if (!item) throw ApiError.notFound('کالا در سبد خرید یافت نشد');
  if (qty > item.product.stock) throw ApiError.badRequest('موجودی کافی نیست');

  const priceSnapshot = computeEffectivePrice(item.product, qty);
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
