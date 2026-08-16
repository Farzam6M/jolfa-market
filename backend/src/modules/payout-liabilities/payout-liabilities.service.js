const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { postLiabilityRecovery } = require('../ledger/ledger.service');

/**
 * Phase 6 — Seller Payout Liability Recovery & Visibility.
 *
 * Phase 5 (see prisma/schema.prisma's SellerPayoutLiability doc and
 * orders.service.js#refundDeliveredOrder) already CREATES an OUTSTANDING
 * liability whenever a refund clawback can't be fully collected from a
 * seller's wallet. Nothing read or recovered it. This module closes that
 * loop:
 *
 *   - recoverSellerLiabilities(tx, sellerId, earningAmount): called from
 *     INSIDE orders.service.js#settleDeliveredOrder's own transaction, on
 *     every future settlement earning for that seller, BEFORE any wallet
 *     credit happens for that earning.
 *   - getOutstandingLiabilityTotal(tx, sellerId): called from INSIDE
 *     payouts.service.js#createPayout's transaction, so a seller can never
 *     withdraw money that is still needed to cover an outstanding
 *     liability.
 *   - listLiabilities: read-only admin listing (GET
 *     /admin/payout-liabilities).
 *
 * No manual recovery is implemented anywhere in this module by design —
 * see recoverSellerLiabilities' own comment.
 */

/**
 * Recovers as much of `earningAmount` as possible against `sellerId`'s
 * OUTSTANDING liabilities, FIFO (createdAt ASC, id ASC tie-break), and
 * returns whatever remains for the caller to actually credit to the
 * wallet.
 *
 * MUST be called from inside the same `tx` as the settlement that
 * produced `earningAmount` — recovery and the earning it comes from are
 * one atomic unit (financial invariant #5). The caller (settleDeliveredOrder)
 * is deliberately the one that performs the final wallet CREDIT of
 * `remainingSellerEarning`, not this function — see the "no gross
 * credit-then-debit" note below.
 *
 * Design: `SellerPayoutLiability.amount` IS the remaining outstanding
 * amount (see schema doc) rather than a fixed original amount tracked
 * alongside a separate "recovered so far" counter. Recovering `x` from a
 * liability is therefore a plain decrement of `amount`, exactly like a
 * Wallet.balance debit. Every actual recovery is applied with an atomic
 * conditional updateMany keyed on the row's id AND the exact `amount`
 * value just read (a compare-and-swap on that value, the same pattern
 * used everywhere else in this codebase for balance-like fields — see
 * payouts.service.js#createPayout's wallet debit / orders.service.js's
 * refund clawback). Under Postgres, a second writer touching the SAME row
 * concurrently (another settlement recovering into the same liability)
 * blocks on that row's lock and, once unblocked, re-evaluates the WHERE
 * clause against the now-current `amount` — so a stale compare-and-swap
 * always loses (count 0) rather than silently over-recovering. On a
 * miss, this throws and the whole calling transaction rolls back
 * (settlement included), which is safe and retryable — mirrors
 * orders.service.js#refundDeliveredOrder's own "a genuine concurrent-
 * modification race still throws and rolls back the whole transaction"
 * convention, just via a targeted per-row CAS here instead of Serializable
 * isolation (FIFO's sequential read-then-write-per-row loop is exactly
 * the shape a single-row CAS protects; see createPayout for the other
 * shape — a plain aggregate read — which needs Serializable instead).
 *
 * Every actual recovery (recoverable > 0) also writes exactly one
 * WalletTransaction DEBIT row (existing `reason`/`refId` fields, refId =
 * the liability's id) as the audit trail for that recovery. This row is
 * intentionally NOT paired with a Wallet.balance mutation: the approved
 * design credits the wallet only the FINAL remainder after recovery
 * (never the gross earning followed by a separate debit), so there is no
 * temporary "inflate then claw back" balance movement to record — the
 * DEBIT row's existence is itself the durable record of "this much of
 * this earning went to liability, not to the wallet".
 */
async function recoverSellerLiabilities(tx, sellerId, earningAmount, orderItemSettlementId) {
  const earning = Number(earningAmount) || 0;
  if (earning <= 0) {
    return { totalRecovered: 0, remainingSellerEarning: earning };
  }

  const liabilities = await tx.sellerPayoutLiability.findMany({
    where: { sellerId, status: 'OUTSTANDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  let remaining = earning;
  let totalRecovered = 0;

  // eslint-disable-next-line no-restricted-syntax
  for (const liability of liabilities) {
    if (remaining <= 0) break;

    const liabilityRemaining = Number(liability.amount);
    if (liabilityRemaining <= 0) continue; // defensive: shouldn't exist on an OUTSTANDING row

    const recoverable = Math.min(remaining, liabilityRemaining);
    const fullyRecovered = recoverable >= liabilityRemaining;

    // eslint-disable-next-line no-await-in-loop
    const claimed = await tx.sellerPayoutLiability.updateMany({
      where: { id: liability.id, status: 'OUTSTANDING', amount: liability.amount },
      data: {
        amount: { decrement: recoverable },
        ...(fullyRecovered ? { status: 'RECOVERED', recoveredAt: new Date() } : {}),
      },
    });
    if (claimed.count !== 1) {
      // Lost a race to a concurrent recovery/modification of this exact
      // liability row (see function comment). Abort — never guess at a
      // stale value. Safe to retry the whole settlement from scratch.
      throw ApiError.conflict('بازیابی بدهی فروشنده هم‌زمان با عملیات دیگری در حال انجام است؛ لطفاً دوباره تلاش کنید');
    }

    // eslint-disable-next-line no-await-in-loop
    const wallet = await tx.wallet.findUnique({ where: { userId: sellerId } });
    if (!wallet) throw ApiError.internal('کیف پول فروشنده برای بازیابی بدهی یافت نشد');

    // eslint-disable-next-line no-await-in-loop
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'DEBIT',
        amount: recoverable,
        reason: `بازیابی خودکار بدهی فروشنده (بدهی ${liability.id}) از محل تسویه سفارش`,
        refId: liability.id,
      },
    });

    // Ledger — LIABILITY_RECOVERY: an additional accounting record, not a
    // replacement for the WalletTransaction row above. eventId is the
    // deterministic composite `${orderItemSettlementId}:${liability.id}`
    // (never liability.id alone), since a single liability may be
    // partially recovered across multiple future settlements. Posted in
    // the SAME transaction as the recovery/decrement above.
    //
    // [P2.9 — Model C, P2.8 Finding A] `receivableBacked` selects
    // postLiabilityRecovery's CREDIT target: a liability whose REFUND
    // Journal posted a PLATFORM_RECEIVABLE claim for it
    // (ledgerReceivableEntryId != null) recovers back into
    // PLATFORM_RECEIVABLE, reducing that specific outstanding claim;
    // every other liability (ledgerReceivableEntryId == NULL — legacy,
    // pre-P2.9, or otherwise never receivable-backed) keeps crediting
    // PLATFORM_CASH exactly as before P2.9, permanently, not just during a
    // transition window (historical liabilities are never retroactively
    // backfilled with a receivable leg — see that column's own
    // schema.prisma doc comment). Read from the SAME `liability` row this
    // loop already fetched above (findMany at the top of this function),
    // not re-queried.
    // eslint-disable-next-line no-await-in-loop
    await postLiabilityRecovery(tx, {
      eventId: `${orderItemSettlementId}:${liability.id}`,
      actorId: null,
      sellerId,
      amount: recoverable,
      receivableBacked: liability.ledgerReceivableEntryId != null,
    });

    remaining -= recoverable;
    totalRecovered += recoverable;
  }

  return { totalRecovered, remainingSellerEarning: remaining };
}

/**
 * Sum of a seller's currently OUTSTANDING liabilities — the amount that
 * MUST stay reserved in their wallet and can never be paid out. Must be
 * read from inside the same (Serializable, per createPayout) transaction
 * as the payout's wallet reservation — see that function's own comment
 * for why a plain aggregate read needs Serializable rather than a
 * single-row CAS.
 */
async function getOutstandingLiabilityTotal(tx, sellerId) {
  const aggregate = await tx.sellerPayoutLiability.aggregate({
    where: { sellerId, status: 'OUTSTANDING' },
    _sum: { amount: true },
  });
  return Number(aggregate._sum.amount || 0);
}

/**
 * Admin-only read listing (GET /admin/payout-liabilities). Read-only,
 * no side effects — mirrors payouts.service.js#listAll /
 * commission-report.service.js#report's pagination + include convention.
 */
async function listLiabilities({
  status, sellerId, page = 1, pageSize = 20,
} = {}) {
  const where = {
    ...(status ? { status } : {}),
    ...(sellerId ? { sellerId } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.sellerPayoutLiability.findMany({
      where,
      include: {
        seller: { select: { id: true, name: true, mobile: true } },
        order: { select: { id: true, orderNumber: true } },
        store: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.sellerPayoutLiability.count({ where }),
  ]);

  return {
    items, total, page, pageSize,
  };
}

module.exports = {
  recoverSellerLiabilities,
  getOutstandingLiabilityTotal,
  listLiabilities,
};
