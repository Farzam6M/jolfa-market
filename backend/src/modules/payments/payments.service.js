const crypto = require('crypto');
const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { pushNotification } = require('../notifications/notifications.service');
const { logAdminActivity } = require('../admin/admin.service');

async function payWithWallet(order, userId) {
  return prisma.$transaction(async (tx) => {
    // Atomic claim: order flips PENDING -> CONFIRMED only if it's still
    // PENDING. A concurrent duplicate request for the same order (double
    // form submit, retried click) loses this race instead of both debiting
    // the wallet and creating two SUCCESS payments for one order.
    const claimed = await tx.order.updateMany({ where: { id: order.id, status: 'PENDING' }, data: { status: 'CONFIRMED' } });
    if (claimed.count === 0) throw ApiError.conflict('این سفارش قبلاً پرداخت شده یا در وضعیت دیگری است');

    // Atomic debit: the previous implementation did findUnique (read balance)
    // then a separate update({decrement}) (write) — a read-check-write that
    // is not atomic under Postgres's default Read Committed isolation. Two
    // concurrent payWithWallet calls for two different orders could both
    // read the same starting balance, both see it as "enough", and both
    // proceed to decrement, driving balance negative. This single
    // conditional updateMany (balance: {gte: amount}) makes "is there enough
    // balance" and "debit it" one atomic database operation — the same
    // compare-and-swap pattern already used for stock (checkout, see
    // orders.service.js) and for the order/payment status claims above and
    // in confirmGateway(). Wallet.userId is @unique, so this always targets
    // at most one row.
    //
    // Not-found and insufficient-balance are intentionally not
    // distinguished here (same as before): whether the wallet is missing or
    // its balance is too low, count will be 0 and the same message is
    // thrown, preserving the exact error behavior of the prior
    // implementation.
    const debited = await tx.wallet.updateMany({
      where: { userId, balance: { gte: order.total } },
      data: { balance: { decrement: order.total } },
    });
    if (debited.count !== 1) {
      throw ApiError.badRequest('موجودی کیف پول کافی نیست');
    }
    const wallet = await tx.wallet.findUnique({ where: { userId } });
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
 *
 * The placeholder ref is randomized per attempt (not just derived from
 * orderNumber) so that retrying a failed/abandoned gateway session for the
 * same order can never produce two PENDING payments with the *same* ref —
 * that collision previously meant confirmGateway's lookup-by-transactionRef
 * could settle the wrong attempt, silently losing a real successful charge.
 * Swap this for whatever ref the actual gateway's session-creation call
 * returns once a provider is wired in; the uniqueness requirement stays.
 */
async function initGatewayPayment(order) {
  return prisma.payment.create({
    data: {
      orderId: order.id, method: 'GATEWAY', amount: order.total, status: 'PENDING', transactionRef: `PENDING-${order.orderNumber}-${crypto.randomBytes(8).toString('hex')}`,
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
    // Conditional, not unconditional: an order can leave PENDING for reasons
    // that have nothing to do with this payment (most importantly, an admin
    // cancelling an abandoned order, which restocks it — see
    // orders.service.js updateStatus). A gateway callback can arrive late or
    // be redelivered well after that happens. Blindly setting status:
    // 'CONFIRMED' here would resurrect a CANCELLED order — reversing the
    // ORDER_TRANSITIONS state machine's rule that CANCELLED is terminal —
    // while the stock it freed stays sold. The payment itself is still
    // marked SUCCESS above (money was genuinely captured), it just no
    // longer auto-confirms an order that has moved on; that needs manual
    // reconciliation/refund, not a silent state-machine violation.
    const claim = await prisma.order.updateMany({ where: { id: payment.orderId, status: 'PENDING' }, data: { status: 'CONFIRMED' } });
    if (claim.count === 0) {
      logger.error(`Gateway payment ${payment.id} succeeded for order ${order.orderNumber} but the order is no longer PENDING (now ${order.status}) — order left as-is, needs manual reconciliation`);
    }
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

/**
 * Sum of a payment's PROCESSED refunds only — REQUESTED (still-pending
 * gateway) refunds never count toward "has this payment been fully paid
 * back yet", since no money has actually moved for them.
 */
async function sumProcessedRefunds(tx, paymentId) {
  const agg = await tx.paymentRefund.aggregate({
    where: { paymentId, status: 'PROCESSED' },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount || 0);
}

/**
 * Refunds a WALLET payment: credits the customer's wallet immediately
 * (money for a WALLET payment lives entirely inside this app, so there is
 * nothing to wait on) and records the refund as PROCESSED right away.
 *
 * Idempotent via `idempotencyKey` (DB-@unique on PaymentRefund): a second
 * call with the same key is a pure no-op — it returns the existing
 * PaymentRefund row without crediting the wallet again or inserting a
 * duplicate row. This is what stops a retried cancellation/refund request
 * (double click, retried job, concurrent request) from double-crediting a
 * customer.
 *
 * Accepts an optional `tx` (Prisma transaction client) so a caller — e.g.
 * orders.service.js#refundDeliveredOrder, which must debit seller wallets
 * and record settlement reversals in the SAME all-or-nothing transaction —
 * can run this as part of a larger atomic operation. Defaults to `prisma`
 * for standalone use (e.g. the pre-delivery cancellation path).
 */
async function refundWallet(paymentId, amount, idempotencyKey, actor, tx = prisma) {
  const existing = await tx.paymentRefund.findUnique({ where: { idempotencyKey } });
  if (existing) return existing; // Idempotent replay — no second credit, no duplicate row.

  const payment = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw ApiError.notFound('پرداخت یافت نشد');
  if (payment.status !== 'SUCCESS') throw ApiError.conflict('فقط پرداخت موفق قابل استرداد است');

  const order = await tx.order.findUnique({ where: { id: payment.orderId } });

  // Atomic credit — same conditional-updateMany pattern as every other
  // wallet mutation in this codebase (payWithWallet's debit,
  // orders.service.js#settleDeliveredOrder's seller credit). A missing
  // wallet (should be impossible) surfaces as count !== 1 and throws,
  // rolling back the whole refund rather than silently losing the credit.
  const credited = await tx.wallet.updateMany({
    where: { userId: order.userId },
    data: { balance: { increment: amount } },
  });
  if (credited.count !== 1) throw ApiError.internal('کیف پول مشتری برای استرداد یافت نشد');

  const wallet = await tx.wallet.findUnique({ where: { userId: order.userId } });
  await tx.walletTransaction.create({
    data: {
      walletId: wallet.id, type: 'CREDIT', amount, reason: `استرداد سفارش ${order.orderNumber}`, refId: payment.id,
    },
  });

  const refund = await tx.paymentRefund.create({
    data: {
      paymentId: payment.id,
      orderId: payment.orderId,
      amount,
      status: 'PROCESSED',
      reason: 'استرداد کیف پول',
      idempotencyKey,
      requestedById: actor.id,
      processedAt: new Date(),
    },
  });

  // Only flip the Payment itself to REFUNDED once its PROCESSED refunds
  // add up to the full original amount — a partial refund (delivered-order
  // partial item refund) must leave the payment SUCCESS so it can still be
  // read as "there is a successful payment behind this order".
  const totalProcessed = await sumProcessedRefunds(tx, payment.id);
  if (totalProcessed >= Number(payment.amount)) {
    await tx.payment.updateMany({ where: { id: payment.id, status: { not: 'REFUNDED' } }, data: { status: 'REFUNDED' } });
  }

  return refund;
}

/**
 * Refunds a GATEWAY payment. NEVER calls any gateway API (none is wired in
 * — see initGatewayPayment's comment) and NEVER moves money itself: it only
 * records a REQUESTED PaymentRefund so an admin can later confirm the real
 * off-platform reversal via `markGatewayRefundProcessed`. Payment.status is
 * deliberately left untouched here (still SUCCESS) — it only becomes
 * REFUNDED once the corresponding refund(s) are actually confirmed
 * PROCESSED.
 *
 * Same idempotency contract and `tx` parameter as refundWallet — see there.
 */
async function refundGateway(paymentId, amount, idempotencyKey, actor, tx = prisma) {
  const existing = await tx.paymentRefund.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  const payment = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw ApiError.notFound('پرداخت یافت نشد');
  if (payment.status !== 'SUCCESS') throw ApiError.conflict('فقط پرداخت موفق قابل استرداد است');

  return tx.paymentRefund.create({
    data: {
      paymentId: payment.id,
      orderId: payment.orderId,
      amount,
      status: 'REQUESTED',
      reason: 'در انتظار تأیید استرداد درگاه پرداخت',
      idempotencyKey,
      requestedById: actor.id,
    },
  });
}

/**
 * Admin-only manual confirmation that a GATEWAY refund actually happened
 * on the gateway's side (no gateway webhook exists for this — see
 * refundGateway's comment). Atomic claim (updateMany REQUESTED ->
 * PROCESSED) so two concurrent "mark processed" calls for the same refund
 * can only succeed once; the loser gets back the already-processed row as
 * a graceful no-op instead of double-counting toward the payment total.
 */
async function markGatewayRefundProcessed(refundId, actor) {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.paymentRefund.updateMany({
      where: { id: refundId, status: 'REQUESTED' },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    const refund = await tx.paymentRefund.findUnique({ where: { id: refundId } });
    if (!refund) throw ApiError.notFound('درخواست استرداد یافت نشد');
    if (claimed.count === 0) return refund; // Already PROCESSED (or was never REQUESTED) — no-op.

    const payment = await tx.payment.findUnique({ where: { id: refund.paymentId } });
    // Payment -> REFUNDED only once ALL of its PROCESSED refunds (across
    // possibly several partial gateway confirmations) add up to the full
    // original amount — mirrors refundWallet's same rule.
    const totalProcessed = await sumProcessedRefunds(tx, payment.id);
    if (totalProcessed >= Number(payment.amount)) {
      await tx.payment.updateMany({ where: { id: payment.id, status: { not: 'REFUNDED' } }, data: { status: 'REFUNDED' } });
    }
    return refund;
  }).then(async (refund) => {
    await logAdminActivity(actor.id, `تأیید دستی استرداد درگاه پرداخت ${refund.id}`);
    return refund;
  });
}

module.exports = {
  pay, confirmGateway, getWallet, listAll, refundWallet, refundGateway, markGatewayRefundProcessed,
};
