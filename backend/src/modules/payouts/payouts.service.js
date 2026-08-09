const crypto = require('crypto');
const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { pushNotification } = require('../notifications/notifications.service');
const { logAdminActivity } = require('../admin/admin.service');

/**
 * Creates a PayoutRequest and, in the SAME transaction, atomically reserves
 * (debits) `amount` out of the seller's wallet — this is the "REQUESTED"
 * step of the Phase 5 state machine (see schema.prisma's PayoutStatus doc).
 *
 * Idempotency: `idempotencyKey` is DB-@unique on PayoutRequest (same
 * pattern as PaymentRefund.idempotencyKey — see
 * payments.service.js#refundWallet). A second call with the same key is a
 * pure no-op: it returns the existing row without reserving the amount
 * again or inserting a duplicate. This is what stops a retried/
 * double-submitted withdrawal request from double-reserving a seller's
 * balance. Callers may supply their own key (e.g. a client-generated UUID
 * tied to one logical "withdraw" button press); one is generated
 * server-side when omitted.
 *
 * Wallet debit uses the same atomic conditional updateMany
 * (balance: {gte: amount}) compare-and-swap pattern as every other
 * wallet-affecting flow in this codebase (payments.service.js#payWithWallet,
 * orders.service.js#settleDeliveredOrder / #refundDeliveredOrder) rather
 * than a read-then-write, so it can never race with any other operation on
 * the same wallet into a negative balance. A missing wallet (should be
 * impossible — every user gets one at registration/store-creation, see
 * auth.service.js / users.service.js / stores.service.js) surfaces exactly
 * like "insufficient balance" does: count !== 1, same error message,
 * matching payWithWallet's own documented convention of not distinguishing
 * the two cases.
 */
async function createPayout(sellerId, payload, actor) {
  const idempotencyKey = payload.idempotencyKey || crypto.randomUUID();

  const existing = await prisma.payoutRequest.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.sellerId !== sellerId) throw ApiError.conflict('کلید idempotency قبلاً برای درخواست دیگری استفاده شده است');
    return existing; // Idempotent replay — no second reservation, no duplicate row.
  }

  return prisma.$transaction(async (tx) => {
    const payoutRequest = await tx.payoutRequest.create({
      data: {
        sellerId,
        amount: payload.amount,
        idempotencyKey,
        bankAccountHolder: payload.bankAccountHolder,
        bankIban: payload.bankIban,
        bankCardNumber: payload.bankCardNumber || null,
        bankName: payload.bankName || null,
        requestedById: actor.id,
      },
    });

    // Atomic reserve: debit only succeeds if the wallet exists AND has
    // enough balance — see function-level comment above.
    const debited = await tx.wallet.updateMany({
      where: { userId: sellerId, balance: { gte: payload.amount } },
      data: { balance: { decrement: payload.amount } },
    });
    if (debited.count !== 1) {
      throw ApiError.badRequest('موجودی کیف پول برای برداشت کافی نیست');
    }

    const wallet = await tx.wallet.findUnique({ where: { userId: sellerId } });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'DEBIT',
        amount: payload.amount,
        reason: `رزرو مبلغ درخواست برداشت ${payoutRequest.id}`,
        refId: payoutRequest.id,
      },
    });

    return payoutRequest;
  });
}

/** Seller's own payout requests (WALLET_WITHDRAW_SELF, ownership enforced by scoping to sellerId). */
async function listMine(sellerId, { status, page = 1, pageSize = 20 } = {}) {
  const where = { sellerId, ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    prisma.payoutRequest.findMany({
      where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' },
    }),
    prisma.payoutRequest.count({ where }),
  ]);
  return {
    items, total, page, pageSize,
  };
}

/** Admin-only: lists payout requests across all sellers (gated by PAYOUTS_MANAGE at the route layer). */
async function listAll({
  status, sellerId, page = 1, pageSize = 20,
} = {}) {
  const where = {
    ...(status ? { status } : {}),
    ...(sellerId ? { sellerId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.payoutRequest.findMany({
      where,
      include: {
        seller: { select: { id: true, name: true, mobile: true } },
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.payoutRequest.count({ where }),
  ]);
  return {
    items, total, page, pageSize,
  };
}

/**
 * Credits `amount` back to a seller's wallet, releasing a reservation made
 * by createPayout. Shared by reject() and markFailed() — the only two
 * transitions in the Phase 5 state machine that return money. Same atomic
 * conditional updateMany pattern as every other wallet credit in this
 * codebase (settleDeliveredOrder, payments.service.js#refundWallet). Must
 * be called from INSIDE the caller's transaction (`tx`) so the wallet
 * credit and the status transition commit or roll back together.
 */
async function releaseReservation(tx, payoutRequest, reason) {
  const credited = await tx.wallet.updateMany({
    where: { userId: payoutRequest.sellerId },
    data: { balance: { increment: payoutRequest.amount } },
  });
  if (credited.count !== 1) throw ApiError.internal('کیف پول فروشنده برای بازگشت وجه یافت نشد');

  const wallet = await tx.wallet.findUnique({ where: { userId: payoutRequest.sellerId } });
  await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      type: 'CREDIT',
      amount: payoutRequest.amount,
      reason,
      refId: payoutRequest.id,
    },
  });
}

/**
 * REQUESTED -> APPROVED. No wallet movement — the amount was already
 * reserved (debited) at REQUESTED time and stays reserved until either
 * PROCESSED (money genuinely leaves) or FAILED (returned).
 *
 * Atomic claim (updateMany REQUESTED -> APPROVED), same idempotent-no-op
 * convention as payments.service.js#markGatewayRefundProcessed: a second
 * concurrent/retried call for the same id sees claim.count === 0 and just
 * returns the row as-is rather than erroring, so a double-click can't
 * double-fire the approvedAt/approvedById stamp or any side effects.
 */
async function approvePayout(id, actor) {
  const claimed = await prisma.payoutRequest.updateMany({
    where: { id, status: 'REQUESTED' },
    data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date() },
  });

  const payoutRequest = await prisma.payoutRequest.findUnique({ where: { id } });
  if (!payoutRequest) throw ApiError.notFound('درخواست برداشت یافت نشد');
  if (claimed.count === 0) return payoutRequest; // Already past REQUESTED — no-op.

  await logAdminActivity(actor.id, `تأیید درخواست برداشت ${payoutRequest.id}`);
  await pushNotification({
    icon: 'i-wallet', text: 'درخواست برداشت وجه شما تأیید شد و در انتظار واریز است', scope: 'USER', targetUserId: payoutRequest.sellerId,
  });
  return payoutRequest;
}

/**
 * REQUESTED -> REJECTED. Returns the reserved amount to the seller's
 * wallet in the SAME transaction as the status claim, so a crash between
 * the two is impossible (either both happen or neither does).
 *
 * Same atomic-claim-then-no-op-on-miss convention as approvePayout — see
 * there. The credit-back only ever runs on the call that actually wins the
 * REQUESTED -> REJECTED claim, so a retried/duplicate reject can never
 * double-credit the wallet.
 */
async function rejectPayout(id, reason, actor) {
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payoutRequest.updateMany({
      where: { id, status: 'REQUESTED' },
      data: {
        status: 'REJECTED', failureReason: reason || null,
      },
    });

    const payoutRequest = await tx.payoutRequest.findUnique({ where: { id } });
    if (!payoutRequest) throw ApiError.notFound('درخواست برداشت یافت نشد');
    if (claimed.count === 0) return payoutRequest; // Already past REQUESTED — no-op, no second credit.

    await releaseReservation(tx, payoutRequest, `بازگشت وجه درخواست برداشت رد شده ${payoutRequest.id}`);
    return payoutRequest;
  });

  await logAdminActivity(actor.id, `رد درخواست برداشت ${result.id}`);
  await pushNotification({
    icon: 'i-wallet', text: 'درخواست برداشت وجه شما رد شد و مبلغ به کیف پول شما بازگشت', scope: 'USER', targetUserId: result.sellerId,
  });
  return result;
}

/**
 * APPROVED -> PROCESSED. No wallet movement — this is the terminal
 * success state confirming the off-platform bank transfer actually
 * happened; the money already left the seller's wallet at REQUESTED time.
 * Same atomic-claim-then-no-op-on-miss convention as approvePayout.
 */
async function markProcessed(id, actor) {
  const claimed = await prisma.payoutRequest.updateMany({
    where: { id, status: 'APPROVED' },
    data: { status: 'PROCESSED', processedById: actor.id, processedAt: new Date() },
  });

  const payoutRequest = await prisma.payoutRequest.findUnique({ where: { id } });
  if (!payoutRequest) throw ApiError.notFound('درخواست برداشت یافت نشد');
  if (claimed.count === 0) return payoutRequest; // Already past APPROVED — no-op.

  await logAdminActivity(actor.id, `ثبت واریز درخواست برداشت ${payoutRequest.id}`);
  await pushNotification({
    icon: 'i-wallet', text: 'مبلغ درخواست برداشت شما با موفقیت واریز شد', scope: 'USER', targetUserId: payoutRequest.sellerId,
  });
  return payoutRequest;
}

/**
 * APPROVED -> FAILED. Intentionally a separate endpoint/transition from
 * REQUESTED -> REJECTED (see Phase 5 spec) since it represents a different
 * real-world event: the transfer was already approved and attempted
 * off-platform but did not go through (bad bank details, bank-side
 * rejection, ...), rather than an admin declining the request up front.
 * Returns the reserved amount to the wallet, same as rejectPayout — see
 * there for the atomicity/idempotency rationale.
 */
async function markFailed(id, failureReason, actor) {
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payoutRequest.updateMany({
      where: { id, status: 'APPROVED' },
      data: {
        status: 'FAILED', failureReason,
      },
    });

    const payoutRequest = await tx.payoutRequest.findUnique({ where: { id } });
    if (!payoutRequest) throw ApiError.notFound('درخواست برداشت یافت نشد');
    if (claimed.count === 0) return payoutRequest; // Already past APPROVED — no-op, no second credit.

    await releaseReservation(tx, payoutRequest, `بازگشت وجه برداشت ناموفق ${payoutRequest.id}`);
    return payoutRequest;
  });

  await logAdminActivity(actor.id, `ثبت شکست واریز درخواست برداشت ${result.id}`);
  await pushNotification({
    icon: 'i-wallet', text: 'واریز درخواست برداشت وجه شما ناموفق بود و مبلغ به کیف پول شما بازگشت', scope: 'USER', targetUserId: result.sellerId,
  });
  return result;
}

module.exports = {
  createPayout, listMine, listAll, approvePayout, rejectPayout, markProcessed, markFailed,
};
