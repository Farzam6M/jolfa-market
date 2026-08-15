const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { pushNotification } = require('../notifications/notifications.service');
const { logAdminActivity } = require('../admin/admin.service');
const {
  postPaymentConfirmed, postWalletPaymentConfirmed, postRefund, postPaymentReversed,
} = require('../ledger/ledger.service');

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

    // Ledger — PAYMENT_CONFIRMED (WALLET variant): posted in the SAME
    // transaction as the wallet debit and Payment.create above, mirroring
    // confirmGateway's own GATEWAY-only postPaymentConfirmed call. eventId
    // = the WALLET Payment.id just created — never collides with a GATEWAY
    // Payment.id (see ledger.constants.js's EVENT_ACCOUNT_MAP comment).
    await postWalletPaymentConfirmed(tx, {
      eventId: payment.id,
      actorId: null,
      customerId: userId,
      amount: order.total,
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

// CASH_ON_DELIVERY is out of scope (P2.7 — COD scope closure): no code path
// in this codebase ever creates a COD Payment, transitions one to SUCCESS,
// collects COD cash, or posts a COD Ledger event. paySchema (see
// payments.validation.js) already rejects 'CASH_ON_DELIVERY' at the HTTP
// boundary before this function is ever reached, but `method` is re-checked
// explicitly here too — an internal/authoritative guard rather than a
// silent fallback, so this service can never be made to create an
// unsupported-method Payment even if called some other way in the future.
// Historical rows with method = CASH_ON_DELIVERY may still exist from
// before this closure (see this repo's PaymentMethod enum, which is left
// unchanged for that reason) — they are read-only history now, never a
// path new payments can take.
async function pay(userId, { orderId, method }) {
  if (method !== 'WALLET' && method !== 'GATEWAY') {
    throw ApiError.badRequest('روش پرداخت پشتیبانی نمی‌شود');
  }

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('سفارش یافت نشد');
  if (order.userId !== userId) throw ApiError.forbidden('این سفارش متعلق به شما نیست');
  if (order.status !== 'PENDING') throw ApiError.conflict('این سفارش قبلاً پرداخت شده یا در وضعیت دیگری است');

  const payment = method === 'WALLET' ? await payWithWallet(order, userId) : await initGatewayPayment(order);

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

  // DB success path wrapped in a transaction so the PENDING -> SUCCESS/FAILED
  // claim, the conditional order-confirm, and the Ledger PAYMENT_CONFIRMED
  // journal (GATEWAY-only, only on a real SUCCESS claim) all commit or roll
  // back together. Notifications stay outside — they already ran after all
  // DB work in the pre-Ledger version of this function.
  const txResult = await prisma.$transaction(async (tx) => {
    // Atomic claim: only the first callback for this payment can actually flip
    // it out of PENDING. Payment gateways commonly retry/duplicate webhook
    // delivery — without this, two concurrent callbacks could both pass the
    // check above and both run the order-confirm + notification side effects.
    const claim = await tx.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status, paidAt: success ? new Date() : null },
    });
    if (claim.count === 0) return { claimed: false };

    const order = await tx.order.findUnique({ where: { id: payment.orderId } });
    let orderClaimCount = null;

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
      const orderClaim = await tx.order.updateMany({ where: { id: payment.orderId, status: 'PENDING' }, data: { status: 'CONFIRMED' } });
      orderClaimCount = orderClaim.count;

      // Ledger — PAYMENT_CONFIRMED: GATEWAY-only (never WALLET/COD — those
      // never go through this function), and only when this call actually
      // won the PENDING -> SUCCESS claim above. Same transaction.
      await postPaymentConfirmed(tx, {
        eventId: payment.id,
        actorId: null,
        amount: payment.amount,
      });
    }

    return {
      claimed: true, order, orderClaimCount,
    };
  });

  if (!txResult.claimed) return prisma.payment.findUnique({ where: { id: payment.id } });

  const { order, orderClaimCount } = txResult;
  if (success) {
    if (orderClaimCount === 0) {
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
 *
 * `fullRefundableAmount` overrides what "fully refunded" means for the
 * REFUNDED-flip check below. Defaults to the Payment's own `amount` (used
 * by pre-delivery cancellation, which always refunds the whole payment
 * including shipping — nothing has shipped yet). A delivered order's item
 * refund, by contrast, only ever refunds item lines (shipping already
 * happened and is non-refundable — see refundDeliveredOrder's docstring),
 * so its caller passes the order's item subtotal here instead of the full
 * payment amount; otherwise a full item refund could never reach
 * payment.amount (which includes the non-refundable shipping fee) and the
 * Payment would incorrectly stay SUCCESS forever.
 *
 * `origin` (P2.4) — a PaymentRefundOrigin value, REQUIRED with no default so
 * every call site must say explicitly which kind of refund this is rather
 * than letting it be silently guessed later: 'PRE_DELIVERY_CANCELLATION'
 * (orders.service.js#updateStatus's CANCELLED branch) or
 * 'POST_DELIVERY_REFUND' (orders.service.js#refundDeliveredOrder). Persisted
 * on the new PaymentRefund row and read back by
 * orders.service.js#markGatewayRefundProcessed to decide which Ledger event
 * (if any) to post — see that function's own doc comment. `ledgerStatus` is
 * likewise always set explicitly (never left to a DB default) to the
 * placeholder 'POSTABLE': for a PRE_DELIVERY_CANCELLATION refund the caller
 * immediately posts postPaymentReversed and flips it to 'POSTED' in the same
 * transaction; for a POST_DELIVERY_REFUND, refundDeliveredOrder overwrites it
 * with the real POSTABLE/SHORTFALL_HELD outcome once its seller-wallet
 * clawback (Pass 2) actually completes — never computed here, since this
 * function has no visibility into that clawback.
 */
async function refundWallet(paymentId, amount, idempotencyKey, actor, origin, tx = prisma, fullRefundableAmount = null) {
  if (origin !== 'PRE_DELIVERY_CANCELLATION' && origin !== 'POST_DELIVERY_REFUND') {
    throw ApiError.internal('refundWallet requires an explicit origin (PRE_DELIVERY_CANCELLATION or POST_DELIVERY_REFUND)');
  }

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
      origin,
      ledgerStatus: 'POSTABLE',
    },
  });

  // Only flip the Payment itself to REFUNDED once its PROCESSED refunds
  // add up to the full refundable amount — a partial refund (delivered-order
  // partial item refund) must leave the payment SUCCESS so it can still be
  // read as "there is a successful payment behind this order". Defaults to
  // payment.amount (pre-delivery cancellation refunds the whole thing,
  // shipping included); see fullRefundableAmount's doc above.
  const totalProcessed = await sumProcessedRefunds(tx, payment.id);
  const refundThreshold = fullRefundableAmount != null ? Number(fullRefundableAmount) : Number(payment.amount);
  if (totalProcessed >= refundThreshold) {
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
 *
 * `origin` (P2.4) — same required, no-default PaymentRefundOrigin contract
 * as refundWallet's — see that function's doc comment. Persisted here too;
 * this is exactly what lets markGatewayRefundProcessed later decide, once
 * the real off-platform reversal is confirmed, which Ledger event (if any)
 * to post — without ever having to guess from current settlement state.
 * `ledgerStatus` starts at the same 'POSTABLE' placeholder as refundWallet's
 * — for PRE_DELIVERY_CANCELLATION it stays POSTABLE until
 * markGatewayRefundProcessed's Case C posts PAYMENT_REVERSED and flips it to
 * POSTED; for POST_DELIVERY_REFUND, refundDeliveredOrder immediately
 * overwrites it with the real POSTABLE/SHORTFALL_HELD outcome once Pass 2's
 * seller-wallet clawback completes (this function has no visibility into
 * that clawback, same reasoning as refundWallet).
 */
async function refundGateway(paymentId, amount, idempotencyKey, actor, origin, tx = prisma) {
  if (origin !== 'PRE_DELIVERY_CANCELLATION' && origin !== 'POST_DELIVERY_REFUND') {
    throw ApiError.internal('refundGateway requires an explicit origin (PRE_DELIVERY_CANCELLATION or POST_DELIVERY_REFUND)');
  }

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
      origin,
      ledgerStatus: 'POSTABLE',
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
 *
 * P2.4 — this is also the ONLY place a GATEWAY refund's Ledger event is
 * posted (never at refund-request time in refundWallet/refundGateway — see
 * their own doc comments): only the caller that actually wins the
 * REQUESTED -> PROCESSED claim above may post, and it branches strictly on
 * the PERSISTED refund.origin / refund.ledgerStatus — never inferred from
 * current OrderItemSettlement/Wallet.balance state (see
 * payments.service.js#refundWallet's `origin`/`ledgerStatus` doc comment
 * and PaymentRefundOrigin/PaymentRefundLedgerStatus's own schema.prisma
 * comments):
 *
 *   - origin === 'PRE_DELIVERY_CANCELLATION': no settlement to reverse —
 *     posts PAYMENT_REVERSED (GATEWAY leg), eventId = Payment.id, then
 *     flips ledgerStatus -> 'POSTED'.
 *   - origin === 'POST_DELIVERY_REFUND' && ledgerStatus === 'POSTABLE':
 *     the seller-wallet clawback fully succeeded when this refund was
 *     created (refundDeliveredOrder's Pass 2) — reconstructs
 *     sellerRefunds/commissionAmount from the OrderItemSettlementReversal
 *     rows THIS refund created (never recomputed from current wallet
 *     state) and posts REFUND, eventId = PaymentRefund.id, then flips
 *     ledgerStatus -> 'POSTED'.
 *   - origin === 'POST_DELIVERY_REFUND' && ledgerStatus === 'SHORTFALL_HELD':
 *     the clawback was incomplete — money movement above still becomes
 *     PROCESSED, but NO Ledger journal is posted (fabricating a clean
 *     REFUND here would misstate a settlement reversal that never fully
 *     happened); left for manual reconciliation, ledgerStatus stays
 *     SHORTFALL_HELD.
 *   - origin/ledgerStatus NULL (legacy row, created before P2.4): money
 *     movement above is NOT blocked by this — only the automated Ledger
 *     posting is skipped, logged for manual reconciliation rather than
 *     guessed.
 */
async function markGatewayRefundProcessed(refundId, actor) {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.paymentRefund.updateMany({
      where: { id: refundId, status: 'REQUESTED' },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    let refund = await tx.paymentRefund.findUnique({ where: { id: refundId } });
    if (!refund) throw ApiError.notFound('درخواست استرداد یافت نشد');
    if (claimed.count === 0) return refund; // Already PROCESSED (or was never REQUESTED) — no-op, no second Ledger posting.

    const payment = await tx.payment.findUnique({ where: { id: refund.paymentId } });
    // Payment -> REFUNDED only once ALL of its PROCESSED refunds (across
    // possibly several partial gateway confirmations) add up to the full
    // original amount — mirrors refundWallet's same rule.
    const totalProcessed = await sumProcessedRefunds(tx, payment.id);
    if (totalProcessed >= Number(payment.amount)) {
      await tx.payment.updateMany({ where: { id: payment.id, status: { not: 'REFUNDED' } }, data: { status: 'REFUNDED' } });
    }

    if (refund.origin === 'PRE_DELIVERY_CANCELLATION') {
      // Case C — GATEWAY pre-delivery cancellation reversal, deferred from
      // updateStatus's CANCELLED branch (see that function's own comment)
      // until this real REQUESTED -> PROCESSED confirmation. No seller
      // wallet / platform revenue legs — nothing was ever settled.
      await postPaymentReversed(tx, {
        eventId: payment.id,
        actorId: null,
        method: 'GATEWAY',
        amount: refund.amount,
      });
      refund = await tx.paymentRefund.update({ where: { id: refund.id }, data: { ledgerStatus: 'POSTED' } });
    } else if (refund.origin === 'POST_DELIVERY_REFUND' && refund.ledgerStatus === 'POSTABLE') {
      // Case A — reconstruct seller/commission reversal amounts from the
      // OrderItemSettlementReversal rows THIS refund created (persisted
      // historical data — safe to use; never recomputed from current
      // Wallet.balance or re-derived from settlement state). storeId ->
      // sellerId is resolved via OrderItemSettlement.store, matching
      // schema.prisma's actual relation names.
      const reversals = await tx.orderItemSettlementReversal.findMany({
        where: { refundId: refund.id },
        include: { settlement: { include: { store: { select: { sellerId: true } } } } },
      });

      const sellerTotals = new Map(); // sellerId -> Prisma.Decimal
      let commissionTotal = new Prisma.Decimal(0);
      // eslint-disable-next-line no-restricted-syntax
      for (const reversal of reversals) {
        const { sellerId } = reversal.settlement.store;
        const prevAmount = sellerTotals.get(sellerId) || new Prisma.Decimal(0);
        sellerTotals.set(sellerId, prevAmount.plus(new Prisma.Decimal(reversal.refundedSellerEarning)));
        commissionTotal = commissionTotal.plus(new Prisma.Decimal(reversal.refundedCommissionAmount));
      }

      const order = await tx.order.findUnique({ where: { id: refund.orderId } });

      await postRefund(tx, {
        eventId: refund.id,
        actorId: null,
        customerId: order.userId,
        customerAmount: refund.amount,
        sellerRefunds: Array.from(sellerTotals.entries()).map(([sellerId, amount]) => ({ sellerId, amount })),
        commissionAmount: commissionTotal,
      });
      refund = await tx.paymentRefund.update({ where: { id: refund.id }, data: { ledgerStatus: 'POSTED' } });
    } else if (refund.origin === 'POST_DELIVERY_REFUND' && refund.ledgerStatus === 'SHORTFALL_HELD') {
      // Case B — money movement above still completes (REQUESTED ->
      // PROCESSED already claimed), but the Ledger must not fabricate a
      // clean settlement reversal when the seller clawback was left
      // incomplete at refund-creation time (see SellerPayoutLiability /
      // refundDeliveredOrder). No postRefund call; ledgerStatus stays
      // SHORTFALL_HELD, pending manual reconciliation.
    } else {
      // Case D — legacy row: origin and/or ledgerStatus is NULL, meaning
      // this PaymentRefund predates the P2.4 columns. Do NOT infer origin
      // from settlement existence, and do NOT infer shortfall from current
      // Wallet.balance — both are exactly the guesses this design forbids.
      // The money-movement transition above still applies unmodified;
      // only the automated Ledger posting is skipped here, flagged for
      // manual reconciliation via the existing logging convention.
      logger.warn(`markGatewayRefundProcessed: PaymentRefund ${refund.id} has no origin/ledgerStatus (pre-P2.4 legacy row) — REQUESTED->PROCESSED transition applied normally, but no Ledger journal was posted; needs manual reconciliation`);
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
