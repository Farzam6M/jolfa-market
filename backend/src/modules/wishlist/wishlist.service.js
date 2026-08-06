const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { flattenStoreProduct } = require('../products/products.service');

// A wishlist item targets a specific store's offer (StoreProduct), same as
// before the Product/StoreProduct split — see products.service.js. Response
// is flattened back to the pre-split `product`/`productId` shape.
async function list(userId) {
  const items = await prisma.wishlistItem.findMany({
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
      storeProduct: {
        status: 'APPROVED',
        isActive: true,
        store: { status: { not: 'SUSPENDED' }, seller: { deletedAt: null } },
      },
    },
    include: { storeProduct: { include: { images: true, store: true, product: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return items.map((it) => {
    const { storeProduct, ...rest } = it;
    return { ...rest, productId: it.storeProductId, product: flattenStoreProduct(storeProduct) };
  });
}

async function add(userId, productId) {
  const storeProductId = productId; // route/body param name kept for API compatibility
  const storeProduct = await prisma.storeProduct.findUnique({
    where: { id: storeProductId },
    include: { store: { select: { status: true, seller: { select: { deletedAt: true } } } } },
  });
  if (!storeProduct || storeProduct.status !== 'APPROVED' || !storeProduct.isActive) {
    throw ApiError.notFound('محصول یافت نشد یا در دسترس نیست');
  }
  // Same rule as above: a product whose store is suspended or whose seller
  // has been soft-deleted must not be addable to the wishlist either, even
  // if the product row itself still carries an APPROVED/isActive state from
  // before that happened.
  if (!storeProduct.store || storeProduct.store.status === 'SUSPENDED' || !storeProduct.store.seller || storeProduct.store.seller.deletedAt) {
    throw ApiError.notFound('محصول یافت نشد یا در دسترس نیست');
  }
  return prisma.wishlistItem.upsert({
    where: { userId_storeProductId: { userId, storeProductId } },
    update: {},
    create: { userId, storeProductId },
  });
}

async function remove(userId, productId) {
  await prisma.wishlistItem.deleteMany({ where: { userId, storeProductId: productId } });
}

module.exports = { list, add, remove };
