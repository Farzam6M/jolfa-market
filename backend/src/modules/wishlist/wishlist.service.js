const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');

async function list(userId) {
  return prisma.wishlistItem.findMany({
    where: {
      userId,
      // Same "still sellable" rule already enforced for public browsing (see
      // products.service.js list()/getById()) and for cart/checkout (see
      // cart.service.js addItem(), orders.service.js checkout()): a product
      // that's no longer APPROVED/active, or whose store has been suspended,
      // or whose seller has been soft-deleted (removeSeller()), must not be
      // shown here either. This only filters what list() *returns* — the
      // WishlistItem row itself is left untouched in the database, so it
      // reappears on its own if the product becomes sellable again.
      product: {
        status: 'APPROVED',
        isActive: true,
        store: { status: { not: 'SUSPENDED' }, seller: { deletedAt: null } },
      },
    },
    include: { product: { include: { images: true, store: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

async function add(userId, productId) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { store: { select: { status: true, seller: { select: { deletedAt: true } } } } },
  });
  if (!product || product.status !== 'APPROVED' || !product.isActive) {
    throw ApiError.notFound('محصول یافت نشد یا در دسترس نیست');
  }
  // Same rule as above: a product whose store is suspended or whose seller
  // has been soft-deleted must not be addable to the wishlist either, even
  // if the product row itself still carries an APPROVED/isActive state from
  // before that happened.
  if (!product.store || product.store.status === 'SUSPENDED' || !product.store.seller || product.store.seller.deletedAt) {
    throw ApiError.notFound('محصول یافت نشد یا در دسترس نیست');
  }
  return prisma.wishlistItem.upsert({
    where: { userId_productId: { userId, productId } },
    update: {},
    create: { userId, productId },
  });
}

async function remove(userId, productId) {
  await prisma.wishlistItem.deleteMany({ where: { userId, productId } });
}

module.exports = { list, add, remove };
