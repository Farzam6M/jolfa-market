const crypto = require('crypto');
const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { pushNotification } = require('../notifications/notifications.service');
const { logAdminActivity } = require('../admin/admin.service');
const { getOutstandingLiabilityTotal } = require('../payout-liabilities/payout-liabilities.service');
const { postPayoutReserve, postPayoutRelease, postPayoutProcessed } = require('../ledger/ledger.service');

// Persian labels for PayoutStatus, mirroring orders.service.js's
// STATUS_LABELS convention — used only to render the invalid-transition
// error message below.
const PAYOUT_STATUS_LABELS = {
  REQUESTED: 'در انتظار بررسی',
  APPROVED: 'تأیید شده',
  PROCESSED: 'واریز شده',
  REJECTED: 'رد شده',
  FAILED: 'ناموفق',
};

/**
 * Called after an atomic `updateMany(where: {id, status: fromState})` claim
 * misses (claimed.count === 0), i.e. the payout was NOT in `fromState` at
 * claim time. Distinguishes the two reasons that can happen, per Phase 5
 * Fix #3:
 *
 *  - `payoutRequest.status === toState` already: this is a duplicate/
 *    retried call for a transition that already succeeded (possibly by a
 *    concurrent caller that won the race). Safe, idempotent no-op — return
 *    normally, no error, no second side effect.
 *  - any other status: caller is asking for a transition the state machine
 *    does not allow from where the payout actually is. Must NOT be a
 *    silent 200 no-op (that was the Fix #3 bug) — raise an explicit error,
 *    same convention as orders.service.js#updateStatus's
 *    ORDER_TRANSITIONS check (ApiError.conflict / 409, `«from» -> «to»`
 *    message shape).
 */
function assertIdempotentOrThrowInvalidTransition(payoutRequest, toState) {
  if (payoutRequest.status === toState) return; // idempotent replay — caller proceeds, no side effects.
  throw ApiError.conflict(
    `تغییر وضعیت از «${PAYOUT_STATUS_LABELS[payoutRequest.status]}» به «${PAYOUT_STATUS_LABELS[toState]}» مجاز نیست`,
  );
}

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
 * Concurrency: the upfront `findUnique` above is only a fast-path check —
 * it does NOT close the race window. Two requests sharing the same
 * idempotencyKey can both observe "not found" and both enter the
 * transaction below; the DB-level `@unique` on idempotencyKey is the real
 * guard (same "findFirst-then-create, unique constraint is the real
 * guard" pattern as products.service.js#findOrCreateProduct /
 * #upsertStoreOffer). The loser's `payoutRequest.create` throws P2002
 * BEFORE the wallet debit runs, so its transaction rolls back with no
 * reservation ever taken — it is then caught below and turned into a
 * graceful idempotent-replay return of the winner's row, exactly like a
 * sequential retry, instead of surfacing the raw duplicate-key error.
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
 *
 * Phase 6 — liability-aware cap: withdrawableAmount = max(0, balance -
 * outstandingLiabilityTotal), so a payout can never reserve money still
 * needed to cover an OUTSTANDING SellerPayoutLiability (see
 * payout-liabilities.service.js#getOutstandingLiabilityTotal). This is
 * folded into the SAME gte check as the reservation itself
 * (`balance >= amount + outstandingLiabilityTotal`, algebraically
 * identical to `balance - outstandingLiabilityTotal >= amount`), so the
 * liability check and the reservation are one atomic condition — never a
 * separate "SELECT liability; SELECT wallet; THEN create payout" that
 * could race. getOutstandingLiabilityTotal itself is a plain SUM
 * aggregate rather than a single-row compare-and-swap, so — exactly like
 * orders.service.js#refundDeliveredOrder's identical "aggregate read,
 * then act on it" shape — this whole transaction runs at Serializable
 * isolation: a concurrent write that would change the aggregate (a new
 * liability created by a refund, a liability partially recovered by a
 * concurrent settlement, or another concurrent payout against the same
 * wallet) aborts this transaction with Postgres's serialization-failure
 * detection (Prisma P2034) instead of silently reserving against a stale
 * liability total. Caught below and turned into the same 409 convention
 * refundDeliveredOrder already uses for this exact class of race.
 */
// RC-B: max attempts for the WHOLE createPayout transaction when it aborts
// with a Serializable conflict (Prisma P2034). Only P2034 triggers a
// retry — validation errors, insufficient balance, and idempotency-key
// duplicates are never retried (see the catch block below).
const P2034_MAX_ATTEMPTS = 3;

async function createPayout(sellerId, payload, actor) {
  const idempotencyKey = payload.idempotencyKey || crypto.randomUUID();

  const existing = await prisma.payoutRequest.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.sellerId !== sellerId) throw ApiError.conflict('کلید idempotency قبلاً برای درخواست دیگری استفاده شده است');
    return existing; // Idempotent replay — no second reservation, no duplicate row.
  }

  // RC-B: the entire transaction is retried from scratch on P2034 — never
  // just a part of it. Each attempt is a brand-new prisma.$transaction
  // call, so a prior aborted attempt (which Postgres/Prisma guarantees
  // rolled back everything: the payoutRequest row, the wallet debit, the
  // ledger posting, the walletTransaction row) leaves nothing behind for
  // the next attempt to collide with or duplicate. The idempotencyKey is
  // reused across attempts, so if an earlier attempt's create() somehow
  // did commit before the abort (it can't — abort rolls back the whole
  // tx) there would be a P2002, which is handled the same way it already
  // is below regardless of which attempt raised it.
  for (let attempt = 1; attempt <= P2034_MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await prisma.$transaction(async (tx) => {
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

        // Phase 6: read INSIDE this Serializable transaction — see
        // function-level comment above for why this can't be a plain
        // pre-transaction read.
        const outstandingLiabilityTotal = await getOutstandingLiabilityTotal(tx, sellerId);

        // Atomic reserve: debit only succeeds if the wallet exists AND has
        // enough balance to cover both this withdrawal AND every
        // outstanding liability (balance >= amount + outstandingLiabilityTotal
        // <=> withdrawableAmount = balance - outstandingLiabilityTotal >=
        // amount) — see function-level comment above. When
        // outstandingLiabilityTotal is 0 this is exactly the pre-Phase-6
        // check, unchanged.
        const debited = await tx.wallet.updateMany({
          where: { userId: sellerId, balance: { gte: Number(payload.amount) + outstandingLiabilityTotal } },
          data: { balance: { decrement: payload.amount } },
        });
        if (debited.count !== 1) {
          // Same existing error/convention for both "not enough balance at
          // all" and "enough balance but some of it is reserved for an
          // outstanding liability" — no new error system, per Phase 6 spec.
          // A business-level failure, NEVER retried (see catch below).
          throw ApiError.badRequest('موجودی کیف پول برای برداشت کافی نیست');
        }

        // Ledger — PAYOUT_RESERVE: mirrors the wallet debit above exactly,
        // in the SAME transaction. eventId = PayoutRequest.id (see
        // ledger.service.js#postPayoutReserve's own doc).
        await postPayoutReserve(tx, {
          eventId: payoutRequest.id,
          actorId: null,
          sellerId,
          amount: payload.amount,
        });

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
      }, { isolationLevel: 'Serializable' });
    } catch (err) {
      // Lost the create race to a concurrent request with the SAME
      // idempotencyKey (see function-level comment). This transaction never
      // reached the wallet debit, so nothing was reserved on this side —
      // just hand back the winner's row as an idempotent replay. Never
      // retried — a duplicate key isn't a transient conflict.
      if (err.code === 'P2002' && err.meta?.target?.includes('idempotencyKey')) {
        // eslint-disable-next-line no-await-in-loop
        const winner = await prisma.payoutRequest.findUnique({ where: { idempotencyKey } });
        if (winner) {
          if (winner.sellerId !== sellerId) throw ApiError.conflict('کلید idempotency قبلاً برای درخواست دیگری استفاده شده است');
          return winner;
        }
      }
      // Serializable conflict (Prisma P2034) — this request lost a race with
      // another concurrent operation touching the same seller's wallet
      // and/or liabilities (another payout, a refund creating a new
      // liability, a settlement recovering one). RC-B: retry the WHOLE
      // transaction (next loop iteration, fresh state) up to
      // P2034_MAX_ATTEMPTS times before giving up. Any other error
      // (validation, insufficient balance, business-level) is thrown
      // immediately without retrying.
      if (err.code === 'P2034') {
        if (attempt < P2034_MAX_ATTEMPTS) continue; // eslint-disable-line no-continue
        // Final attempt still conflicted — same 409 convention as
        // refundDeliveredOrder's identical P2034 handling; safe to retry
        // at the HTTP level too.
        throw ApiError.conflict('درخواست دیگری هم‌زمان روی کیف پول یا بدهی این فروشنده در حال انجام است؛ لطفاً دوباره تلاش کنید');
      }
      throw err;
    }
  }
  // Unreachable: the loop above always either returns or throws.
  throw ApiError.conflict('درخواست دیگری هم‌زمان روی کیف پول یا بدهی این فروشنده در حال انجام است؛ لطفاً دوباره تلاش کنید');
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

  // Ledger — PAYOUT_RELEASE: mirrors the wallet credit above exactly, in
  // the SAME transaction. Shared by both rejectPayout and markFailed
  // since they both call this one function — no duplicate Ledger call in
  // either caller. eventId = the SAME PayoutRequest.id used at reserve
  // time (see ledger.service.js#postPayoutRelease's own doc).
  await postPayoutRelease(tx, {
    eventId: payoutRequest.id,
    actorId: null,
    sellerId: payoutRequest.sellerId,
    amount: payoutRequest.amount,
  });

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
 * Atomic claim (updateMany REQUESTED -> APPROVED): a second concurrent/
 * retried call for the same id sees claim.count === 0. Phase 5 Fix #3:
 * that miss is then resolved by
 * assertIdempotentOrThrowInvalidTransition — a duplicate retry on an
 * already-APPROVED row is a safe idempotent no-op (no double-fire of
 * approvedAt/approvedById), but any other current status (REJECTED/
 * PROCESSED/FAILED) is an invalid transition and raises an explicit error
 * instead of the old silent 200 no-op.
 */
async function approvePayout(id, actor) {
  const claimed = await prisma.payoutRequest.updateMany({
    where: { id, status: 'REQUESTED' },
    data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date() },
  });

  const payoutRequest = await prisma.payoutRequest.findUnique({ where: { id } });
  if (!payoutRequest) throw ApiError.notFound('درخواست برداشت یافت نشد');
  if (claimed.count === 0) {
    assertIdempotentOrThrowInvalidTransition(payoutRequest, 'APPROVED');
    return payoutRequest; // Idempotent replay — already APPROVED, no second side effect.
  }

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
 * Same atomic-claim convention as approvePayout — see there. Phase 5
 * Fix #3: a claim miss is resolved via
 * assertIdempotentOrThrowInvalidTransition, so the credit-back only ever
 * runs on the call that actually wins the REQUESTED -> REJECTED claim
 * (retried/duplicate reject on an already-REJECTED row is an idempotent
 * no-op, never a second credit) and any other current status (APPROVED/
 * PROCESSED/FAILED) raises an explicit invalid-transition error instead of
 * a silent 200.
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
    if (claimed.count === 0) {
      assertIdempotentOrThrowInvalidTransition(payoutRequest, 'REJECTED');
      return payoutRequest; // Idempotent replay — already REJECTED, no second credit.
    }

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
 * Same atomic-claim convention as approvePayout; a claim miss is resolved
 * via assertIdempotentOrThrowInvalidTransition (Phase 5 Fix #3).
 */
async function markProcessed(id, actor) {
  const payoutRequest = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payoutRequest.updateMany({
      where: { id, status: 'APPROVED' },
      data: { status: 'PROCESSED', processedById: actor.id, processedAt: new Date() },
    });

    const row = await tx.payoutRequest.findUnique({ where: { id } });
    if (!row) throw ApiError.notFound('درخواست برداشت یافت نشد');
    if (claimed.count === 0) {
      assertIdempotentOrThrowInvalidTransition(row, 'PROCESSED');
      return row; // Idempotent replay — already PROCESSED, no second side effect, no second Journal.
    }

    // Ledger — PAYOUT_PROCESSED: only posted when this call actually won
    // the APPROVED -> PROCESSED claim above, in the SAME transaction.
    // eventId = the SAME PayoutRequest.id used at reserve/release time.
    await postPayoutProcessed(tx, {
      eventId: row.id,
      actorId: null,
      sellerId: row.sellerId,
      amount: row.amount,
    });

    return row;
  });

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
 * there for the atomicity/idempotency rationale. A claim miss is resolved
 * via assertIdempotentOrThrowInvalidTransition (Phase 5 Fix #3): duplicate
 * retry on an already-FAILED row is idempotent (no second credit); any
 * other current status is an invalid transition and raises an explicit
 * error.
 *
 * RC-A: `failureReason` is optional at the route/validation layer (see
 * payouts.validation.js#markFailedPayoutSchema) so that a request with an
 * empty body can always reach this function instead of being stopped by
 * a 400 before the state machine ever runs. Two branches:
 *
 *  - A non-empty `failureReason` IS provided: attempt the real atomic
 *    claim (APPROVED -> FAILED), exactly as before — same claim/idempotent/
 *    invalid-transition handling as every other transition in this file.
 *  - No `failureReason` (or blank): NEVER attempt the claim/write — a
 *    missing reason must not silently transition the row. Instead, read
 *    the current status (no side effect either way) and let it decide:
 *      - APPROVED: this WOULD be a genuine transition, but the mandatory
 *        reason is missing -> 400, nothing is written.
 *      - anything else (FAILED / REJECTED / PROCESSED / REQUESTED): same
 *        idempotent-retry-or-invalid-transition resolution as the other
 *        branch would have produced (an empty-body FAILED->FAILED retry
 *        never needed to write failureReason again anyway, and an
 *        invalid-transition call was never going to reach the write).
 */
async function markFailed(id, failureReason, actor) {
  const hasReason = typeof failureReason === 'string' && failureReason.trim().length > 0;

  const result = await prisma.$transaction(async (tx) => {
    if (hasReason) {
      const claimed = await tx.payoutRequest.updateMany({
        where: { id, status: 'APPROVED' },
        data: { status: 'FAILED', failureReason },
      });

      const payoutRequest = await tx.payoutRequest.findUnique({ where: { id } });
      if (!payoutRequest) throw ApiError.notFound('درخواست برداشت یافت نشد');
      if (claimed.count === 0) {
        assertIdempotentOrThrowInvalidTransition(payoutRequest, 'FAILED');
        return payoutRequest; // Idempotent replay — already FAILED, no second credit.
      }

      await releaseReservation(tx, payoutRequest, `بازگشت وجه برداشت ناموفق ${payoutRequest.id}`);
      return payoutRequest;
    }

    // No reason provided — read-only, never claims/writes.
    const payoutRequest = await tx.payoutRequest.findUnique({ where: { id } });
    if (!payoutRequest) throw ApiError.notFound('درخواست برداشت یافت نشد');
    if (payoutRequest.status === 'APPROVED') {
      // Genuine APPROVED -> FAILED transition requested, but the
      // mandatory reason is missing. Nothing was written.
      throw ApiError.badRequest('دلیل شکست الزامی است');
    }
    // Either idempotent retry (already FAILED, 200/no-op) or invalid
    // transition (REJECTED/PROCESSED/REQUESTED, 409) — same helper as
    // every other transition, no wallet/ledger side effect in this branch.
    assertIdempotentOrThrowInvalidTransition(payoutRequest, 'FAILED');
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
