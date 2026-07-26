const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { logAdminActivity } = require('../admin/admin.service');

/** Only customers who actually bought the product may review it — mirrors real marketplace verified-purchase rules. */
async function assertVerifiedPurchase(userId, productId) {
  const purchased = await prisma.orderItem.findFirst({
    where: {
      productId,
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
