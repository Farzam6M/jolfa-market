const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { pushNotification } = require('../notifications/notifications.service');

async function payWithWallet(order, userId) {
  return prisma.$transaction(async (tx) => {
    // Atomic claim: order flips PENDING -> CONFIRMED only if it's still
    // PENDING. A concurrent duplicate request for the same order (double
    // form submit, retried click) loses this race instead of both debiting
    // the wallet and creating two SUCCESS payments for one order.
    const claimed = await tx.order.updateMany({ where: { id: order.id, status: 'PENDING' }, data: { status: 'CONFIRMED' } });
    if (claimed.count === 0) throw ApiError.conflict('این سفارش قبلاً پرداخت شده یا در وضعیت دیگری است');

    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet || Number(wallet.balance) < Number(order.total)) {
      throw ApiError.badRequest('موجودی کیف پول کافی نیست');
    }
    await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { decrement: order.total } } });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id, type: 'DEBIT', amount: order.total, reason: `پرداخت سفارش ${order.orderNumber}`, refId: order.id,
      },
    });
    const payment = await tx.payment.create({
      data: {
        orderId: order.id, method: 'WALLET', amount: order.total, status: 'SUCCESS', paidAt: new Date(),
      },
    });
    return payment;
  });
}

/**
 * GATEWAY payments are created PENDING and settled by `confirmGateway`
 * (the real payment-gateway callback) — never marked SUCCESS synchronously,
 * since the actual charge happens on the gateway's side.
 */
async function initGatewayPayment(order) {
  return prisma.payment.create({
    data: {
      orderId: order.id, method: 'GATEWAY', amount: order.total, status: 'PENDING', transactionRef: `PENDING-${order.orderNumber}`,
    },
  });
}

async function payCashOnDelivery(order) {
  return prisma.$transaction(async (tx) => {
    // Same atomic claim as payWithWallet — see comment there.
    const claimed = await tx.order.updateMany({ where: { id: order.id, status: 'PENDING' }, data: { status: 'CONFIRMED' } });
    if (claimed.count === 0) throw ApiError.conflict('این سفارش قبلاً پرداخت شده یا در وضعیت دیگری است');

    const payment = await tx.payment.create({
      data: {
        orderId: order.id, method: 'CASH_ON_DELIVERY', amount: order.total, status: 'PENDING',
      },
    });
    return payment;
  });
}

async function pay(userId, { orderId, method }) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('سفارش یافت نشد');
  if (order.userId !== userId) throw ApiError.forbidden('این سفارش متعلق به شما نیست');
  if (order.status !== 'PENDING') throw ApiError.conflict('این سفارش قبلاً پرداخت شده یا در وضعیت دیگری است');

  let payment;
  if (method === 'WALLET') payment = await payWithWallet(order, userId);
  else if (method === 'GATEWAY') payment = await initGatewayPayment(order);
  else payment = await payCashOnDelivery(order);

  if (payment.status === 'SUCCESS') {
    await pushNotification({ icon: 'i-wallet', text: `پرداخت سفارش ${order.orderNumber} با موفقیت انجام شد`, scope: 'USER', targetUserId: userId });
  }
  return payment;
}

/** Called by the real gateway's webhook/callback route once the charge is confirmed. */
async function confirmGateway(transactionRef, success) {
  const payment = await prisma.payment.findFirst({ where: { transactionRef } });
  if (!payment) throw ApiError.notFound('پرداخت یافت نشد');

  // Idempotency guard: a payment that's already SUCCESS/FAILED has already
  // been settled and notified once — a duplicate/replayed callback for the
  // same transactionRef must be a no-op, not a second state flip (which
  // would otherwise re-fire notifications, or even flip a SUCCESS payment
  // back to FAILED on a late/duplicate delivery from the gateway).
  if (payment.status !== 'PENDING') return payment;

  const status = success ? 'SUCCESS' : 'FAILED';
  // Atomic claim: only the first callback for this payment can actually flip
  // it out of PENDING. Payment gateways commonly retry/duplicate webhook
  // delivery — without this, two concurrent callbacks could both pass the
  // check above and both run the order-confirm + notification side effects.
  const claim = await prisma.payment.updateMany({
    where: { id: payment.id, status: 'PENDING' },
    data: { status, paidAt: success ? new Date() : null },
  });
  if (claim.count === 0) return prisma.payment.findUnique({ where: { id: payment.id } });

  const order = await prisma.order.findUnique({ where: { id: payment.orderId } });
  if (success) {
    await prisma.order.update({ where: { id: payment.orderId }, data: { status: 'CONFIRMED' } });
    await pushNotification({ icon: 'i-wallet', text: `پرداخت سفارش ${order.orderNumber} با موفقیت انجام شد`, scope: 'USER', targetUserId: order.userId });
  } else {
    await pushNotification({ icon: 'i-wallet', text: `پرداخت سفارش ${order.orderNumber} ناموفق بود`, scope: 'USER', targetUserId: order.userId });
  }
  return prisma.payment.findUnique({ where: { id: payment.id } });
}

async function getWallet(userId) {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    include: { transactions: { orderBy: { createdAt: 'desc' }, take: 50 } },
  });
  if (!wallet) throw ApiError.notFound('کیف پول یافت نشد');
  return wallet;
}

/** Admin-only: lists payments across all users/orders (gated by PAYMENTS_READ_ANY at the route layer). */
async function listAll({ status, method, page = 1, pageSize = 20 } = {}) {
  const where = {
    ...(status ? { status } : {}),
    ...(method ? { method } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: { order: { select: { orderNumber: true, userId: true } } },
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.payment.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

module.exports = {
  pay, confirmGateway, getWallet, listAll,
};
