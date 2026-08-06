const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { logAdminActivity } = require('../admin/admin.service');

// A review targets the shared global Product, not any one store's offer of
// it (see prisma/schema.prisma and the 20260805000000_review_back_to_product
// migration) — reviews represent the product itself, so a customer writes
// (and sees) exactly one review per product no matter which store(s) they
// bought it from, and a review isn't deleted just because the store they
// originally bought from later removes/archives its own listing.

/**
 * Eligible if the user has an order item for ANY store's offer of this
 * product — not just one specific store's — since the review is about the
 * product, not the seller. Joins through StoreProduct.productId (OrderItem
 * itself is unchanged — still keyed on storeProductId, per the task's
 * "do not modify Orders").
 */
async function assertVerifiedPurchase(userId, productId) {
  const purchased = await prisma.orderItem.findFirst({
    where: {
      storeProduct: { productId },
      order: { userId, status: { in: ['CONFIRMED', 'PREPARING', 'SENT', 'DELIVERED'] } },
    },
  });
  if (!purchased) throw ApiError.forbidden('فقط خریداران این محصول می‌توانند نظر ثبت کنند');
}

async function listForProduct(productId) {
  return prisma.review.findMany({
    where: { productId, status: 'APPROVED' },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

async function create(userId, { productId, rating, comment }) {
  await assertVerifiedPurchase(userId, productId);
  return prisma.review.upsert({
    where: { productId_userId: { productId, userId } },
    update: { rating, comment, status: 'PENDING' },
    create: {
      productId, userId, rating, comment,
    },
  });
}

async function remove(reviewId, userId) {
  const review = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!review) throw ApiError.notFound('نظر یافت نشد');
  if (review.userId !== userId) throw ApiError.forbidden('شما نویسنده این نظر نیستید');
  await prisma.review.delete({ where: { id: reviewId } });
}

async function moderate(reviewId, status, actor) {
  const review = await prisma.review.update({ where: { id: reviewId }, data: { status } });
  await logAdminActivity(actor.id, `${status === 'APPROVED' ? 'تایید' : 'رد'} نظر محصول`);
  return review;
}

module.exports = {
  listForProduct, create, remove, moderate,
};
