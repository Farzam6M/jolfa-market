/**
 * P2.4 Phase 2 — Ledger Posting Service.
 *
 * Standalone module: nothing here is imported by payments.service.js /
 * orders.service.js / payouts.service.js / payout-liabilities.service.js /
 * commission-rules, and this module imports none of them. Per the P2.2/P2.3
 * design decision block in schema.prisma ("Ledger — Double-Entry
 * Foundation"), Wallet.balance and WalletTransaction remain the live,
 * unchanged source of truth this phase does not touch. This module is dead/
 * unwired code except for its own tests until a future phase wires it in.
 *
 * Implements the two generic, business-semantics-free primitives the P2.4
 * Phase 2 spec calls for:
 *   - getOrCreateAccount: idempotent (ownerType, ownerId, currency) lookup.
 *   - postJournal: balanced, idempotent double-entry posting keyed on
 *     (eventType, eventId), which also maintains each touched Account's
 *     cached `balance` column (see postJournal's own comment below —
 *     schema.prisma's Account.balance doc calls this out explicitly as
 *     this phase's responsibility, independent of the still-undocumented
 *     per-event leg mapping).
 *
 * Five event wrappers are implemented so far: postPaymentConfirmed (using
 * the PAYMENT_GATEWAY_CLEARING -> PLATFORM_CASH mapping supplied directly
 * by the product owner, not repo-derived), postSettlement (using the
 * PLATFORM_CASH -> PLATFORM_REVENUE + SELLER_WALLET split, whose account
 * choice was supplied by the product owner but whose gross/commission/
 * sellerEarning formula matches orders.service.js#settleDeliveredOrder
 * exactly), postPayoutReserve / postPayoutRelease (P2.4 Phase 2 Step 4),
 * whose SELLER_WALLET <-> PAYOUT_CLEARING mapping IS fully repo-derived: it
 * mirrors payouts.service.js#createPayout's and #releaseReservation's real
 * Wallet.balance debit/credit exactly, and — added in P2.4 Phase 2 Step 5 —
 * postRefund (no-shortfall path only), whose CUSTOMER_WALLET/SELLER_WALLET/
 * PLATFORM_REVENUE mapping is likewise fully repo-derived: it mirrors
 * orders.service.js#refundDeliveredOrder's real customer-credit and
 * no-shortfall seller-wallet-decrement mutations exactly, and reverses
 * SETTLEMENT's own CREDIT PLATFORM_REVENUE leg (see ledger.constants.js's
 * EVENT_ACCOUNT_MAP comment for all of the above).
 *
 * Two wrappers remain NOT implemented: postPayoutProcessed and
 * postLiabilityRecovery. Both were audited in Step 4 and found genuinely
 * unresolvable from repo evidence — not merely "no design doc exists" but
 * a real structural ambiguity in each case (postPayoutProcessed: no real
 * Wallet.balance mutation to mirror, and two internally-consistent-but-
 * conflicting readings for whether/how PLATFORM_CASH moves;
 * postLiabilityRecovery: literally zero repo mentions of which PLATFORM_*
 * account, if any, receives a recovered amount). See ledger.constants.js's
 * EVENT_ACCOUNT_MAP comment and the Step 4 phase report for the full
 * reasoning on both. postRefund's own shortfall path (SellerPayoutLiability)
 * is also deliberately out of scope for this step — see postRefund's own
 * doc comment.
 */

const { Prisma } = require('@prisma/client');
const ApiError = require('../../utils/ApiError');
const { LEDGER_CURRENCY, PLATFORM_LEDGER_OWNER_ID, EVENT_ACCOUNT_MAP } = require('./ledger.constants');

// Prisma's generated unique-constraint name for Journal's compound unique
// index, per the 20260811000000_ledger_foundation migration:
//   CREATE UNIQUE INDEX "journals_eventType_eventId_key" ...
const JOURNAL_EVENT_UNIQUE_CONSTRAINT = 'journals_eventType_eventId_key';

/**
 * Look up an Account by (ownerType, ownerId, currency); create it if it
 * does not exist yet. Never opens its own transaction — `tx` must already
 * be an in-flight Prisma transaction client supplied by the caller, so the
 * lookup/create is atomic with whatever else the caller is doing in the
 * same transaction.
 *
 * Duplicate-create races are handled the same way as every other
 * findFirst-then-create flow in this codebase (payouts.service.js#
 * createPayout, products.service.js#findOrCreateProduct): the DB's
 * @@unique([ownerType, ownerId, currency]) constraint is the real guard,
 * not the pre-create read. If two concurrent callers both miss the initial
 * lookup and both attempt to create, the loser's create throws P2002 for
 * ledger_accounts_ownerType_ownerId_currency_key; that is caught here and
 * turned into a re-fetch of the winner's row, so this never returns two
 * different Account rows for the same (ownerType, ownerId, currency) and
 * never throws for a race it can resolve itself.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} ownerType - a LedgerAccountOwnerType value
 * @param {string} ownerId
 * @param {string} [currency]
 * @returns {Promise<object>} the Account row
 */
async function getOrCreateAccount(tx, ownerType, ownerId, currency = LEDGER_CURRENCY) {
  if (!tx) throw ApiError.internal('getOrCreateAccount requires an in-flight transaction client');
  if (!ownerType) throw ApiError.internal('getOrCreateAccount requires ownerType');
  if (!ownerId) throw ApiError.internal('getOrCreateAccount requires ownerId');

  const existing = await tx.account.findUnique({
    where: { ownerType_ownerId_currency: { ownerType, ownerId, currency } },
  });
  if (existing) return existing;

  try {
    return await tx.account.create({
      data: { ownerType, ownerId, currency },
    });
  } catch (err) {
    if (err.code === 'P2002' && err.meta?.target?.includes?.('ledger_accounts_ownerType_ownerId_currency_key')) {
      const winner = await tx.account.findUnique({
        where: { ownerType_ownerId_currency: { ownerType, ownerId, currency } },
      });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Sum a list of legs' amounts for a given direction using Prisma.Decimal —
 * never JavaScript Number/parseFloat — so no floating-point rounding can
 * enter the balance check.
 */
function sumByDirection(legs, direction) {
  return legs
    .filter((leg) => leg.direction === direction)
    .reduce((total, leg) => total.plus(new Prisma.Decimal(leg.amount)), new Prisma.Decimal(0));
}

/**
 * Post a balanced double-entry Journal plus its LedgerEntry legs,
 * idempotent on (eventType, eventId).
 *
 * `tx` must be an existing Prisma transaction client (same "operates
 * inside the caller's transaction" contract as getOrCreateAccount) — the
 * Journal and every LedgerEntry it creates are committed atomically from
 * the caller's perspective.
 *
 * Idempotency (design: journals_eventType_eventId_key is the real guard,
 * matching payouts.service.js#createPayout's established pattern):
 *   1. Pre-check for an existing Journal by (eventType, eventId); if
 *      found, return it as an idempotent replay — no new rows, and no
 *      balance re-application (see below).
 *   2. Otherwise attempt to create the Journal + its LedgerEntry rows.
 *   3. If a concurrent caller wins the race, this Journal.create throws
 *      P2002 for journals_eventType_eventId_key; that specific conflict is
 *      caught, the winning Journal is re-fetched and returned, and no
 *      duplicate entries or balance updates happen on this side.
 *
 * Balance requirement: SUM(DEBIT legs) must equal SUM(CREDIT legs),
 * computed with Prisma.Decimal (never Number/parseFloat). An unbalanced
 * journal throws before anything is written and nothing is committed.
 *
 * Cached balance maintenance: schema.prisma's Account.balance doc states
 * this column is "SUM(CREDIT) - SUM(DEBIT) of this account's LedgerEntry
 * rows" and explicitly defers writing it to "a later phase's posting
 * service..., the same atomic-cache-update discipline Wallet.balance
 * already uses" — i.e. this function. So each leg's Account.balance is
 * updated with a Prisma `increment`/`decrement` (CREDIT increments,
 * DEBIT decrements) in the same transaction as its LedgerEntry insert,
 * matching the exact convention payments.service.js#payWithWallet and
 * payouts.service.js already use for Wallet.balance. This is purely
 * mechanical bookkeeping for the generic engine — it does not depend on,
 * and does not resolve, the still-undocumented per-event leg mapping
 * (which accounts a given eventType touches, and in which direction, is
 * entirely up to the caller-supplied `legs`).
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventType - a LedgerEventType value
 * @param {string} params.eventId
 * @param {string|null} [params.actorId]
 * @param {string} [params.currency]
 * @param {Array<{accountId: string, direction: 'DEBIT'|'CREDIT', amount: string|number|Prisma.Decimal}>} params.legs
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postJournal(tx, {
  eventType, eventId, actorId = null, currency = LEDGER_CURRENCY, legs,
}) {
  if (!tx) throw ApiError.internal('postJournal requires an in-flight transaction client');
  if (!eventType) throw ApiError.badRequest('postJournal requires eventType');
  if (!eventId) throw ApiError.badRequest('postJournal requires eventId');
  if (!Array.isArray(legs) || legs.length < 2) {
    throw ApiError.badRequest('postJournal requires at least two legs');
  }
  for (const leg of legs) {
    if (!leg.accountId) throw ApiError.badRequest('every leg requires accountId');
    if (leg.direction !== 'DEBIT' && leg.direction !== 'CREDIT') {
      throw ApiError.badRequest('every leg requires direction DEBIT or CREDIT');
    }
    if (leg.amount === undefined || leg.amount === null) {
      throw ApiError.badRequest('every leg requires amount');
    }
    if (new Prisma.Decimal(leg.amount).lessThanOrEqualTo(0)) {
      throw ApiError.badRequest('every leg amount must be positive; sign comes from direction');
    }
  }

  // 1. Idempotent-replay pre-check.
  const existingJournal = await tx.journal.findUnique({
    where: { eventType_eventId: { eventType, eventId } },
  });
  if (existingJournal) {
    const entries = await tx.ledgerEntry.findMany({ where: { journalId: existingJournal.id } });
    return { journal: existingJournal, entries, idempotentReplay: true };
  }

  // Balance check — Prisma.Decimal only, no Number/parseFloat.
  const debitTotal = sumByDirection(legs, 'DEBIT');
  const creditTotal = sumByDirection(legs, 'CREDIT');
  if (!debitTotal.equals(creditTotal)) {
    throw ApiError.badRequest(
      `unbalanced journal for ${eventType}/${eventId}: DEBIT total ${debitTotal.toString()} !== CREDIT total ${creditTotal.toString()}`,
    );
  }

  try {
    const journal = await tx.journal.create({
      data: {
        eventType, eventId, actorId, currency,
      },
    });
    const entries = [];
    // Sequential, not Promise.all: keeps insert order deterministic and
    // avoids opening more concurrent statements than necessary on the
    // single transaction client, matching the sequential-await style
    // already used inside transactions elsewhere in this codebase
    // (payouts.service.js#createPayout).
    for (const leg of legs) {
      // eslint-disable-next-line no-await-in-loop
      const entry = await tx.ledgerEntry.create({
        data: {
          journalId: journal.id,
          accountId: leg.accountId,
          direction: leg.direction,
          amount: leg.amount,
          currency,
        },
      });
      entries.push(entry);
      // Keep Account.balance (SUM(CREDIT) - SUM(DEBIT)) in sync with this
      // leg, atomically, in the same transaction — see the function-level
      // comment above. CREDIT increments, DEBIT decrements.
      // eslint-disable-next-line no-await-in-loop
      await tx.account.update({
        where: { id: leg.accountId },
        data: {
          balance: leg.direction === 'CREDIT'
            ? { increment: leg.amount }
            : { decrement: leg.amount },
        },
      });
    }
    return { journal, entries, idempotentReplay: false };
  } catch (err) {
    if (err.code === 'P2002' && err.meta?.target?.includes?.(JOURNAL_EVENT_UNIQUE_CONSTRAINT)) {
      // Lost the create race to a concurrent request for the same
      // (eventType, eventId) — same pattern as payouts.service.js#
      // createPayout's idempotencyKey handling. This transaction never
      // reached the point of creating any LedgerEntry that could survive
      // (the Journal.create itself is what threw), so nothing is
      // committed on this side; hand back the winner's row instead.
      const winner = await tx.journal.findUnique({
        where: { eventType_eventId: { eventType, eventId } },
      });
      if (winner) {
        const entries = await tx.ledgerEntry.findMany({ where: { journalId: winner.id } });
        return { journal: winner, entries, idempotentReplay: true };
      }
    }
    throw err;
  }
}

/**
 * Thin semantic wrapper over postJournal for the PAYMENT_CONFIRMED event.
 * Posts DEBIT PAYMENT_GATEWAY_CLEARING / CREDIT PLATFORM_CASH for `amount`
 * — the mapping in ledger.constants.js's EVENT_ACCOUNT_MAP, supplied
 * directly by the product owner for this step (not repository-derived —
 * see that file's comment).
 *
 * Both accounts here are platform-owned (ownerId = PLATFORM_LEDGER_OWNER_ID
 * per schema.prisma's LedgerAccountOwnerType doc for PAYMENT_GATEWAY_CLEARING
 * and PLATFORM_CASH), so unlike a CUSTOMER_WALLET/SELLER_WALLET leg this
 * wrapper needs no caller-supplied ownerId for either side.
 *
 * Same "operates inside the caller's transaction, opens none of its own"
 * contract as getOrCreateAccount/postJournal. All idempotency (including
 * not double-applying the Account.balance update on replay) is handled by
 * postJournal itself via (eventType, eventId) — this wrapper adds no
 * idempotency logic of its own.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventId - the domain id this event represents (e.g. Payment.id)
 * @param {string|null} [params.actorId]
 * @param {string} [params.currency]
 * @param {string|number|Prisma.Decimal} params.amount
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postPaymentConfirmed(tx, {
  eventId, actorId = null, currency = LEDGER_CURRENCY, amount,
}) {
  const mapping = EVENT_ACCOUNT_MAP.PAYMENT_CONFIRMED;

  const debitAccount = await getOrCreateAccount(tx, mapping.debitOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);
  const creditAccount = await getOrCreateAccount(tx, mapping.creditOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);

  return postJournal(tx, {
    eventType: 'PAYMENT_CONFIRMED',
    eventId,
    actorId,
    currency,
    legs: [
      { accountId: debitAccount.id, direction: 'DEBIT', amount },
      { accountId: creditAccount.id, direction: 'CREDIT', amount },
    ],
  });
}

/**
 * Thin semantic wrapper over postJournal for the SETTLEMENT event.
 *
 * Mirrors orders.service.js#settleDeliveredOrder's own formula exactly
 * (that function's doc comment: gross = priceSnapshot * qty; commission =
 * round(gross * commissionRate / 100); sellerEarning = gross - commission
 * — the same three numbers it persists verbatim onto OrderItemSettlement's
 * grossAmount/commissionAmount/sellerEarning columns). This wrapper does
 * NOT recompute that formula; it takes the three already-computed amounts
 * as input and posts:
 *   DEBIT  PLATFORM_CASH             grossAmount
 *   CREDIT PLATFORM_REVENUE          commissionAmount
 *   CREDIT SELLER_WALLET (sellerId)  sellerEarning
 * per ledger.constants.js's EVENT_ACCOUNT_MAP.SETTLEMENT — see that
 * file's comment for what in this mapping is repo-derived (the formula)
 * vs. supplied directly by the product owner (which owner types
 * represent which leg).
 *
 * Zero-amount legs: postJournal rejects any leg with amount <= 0 (a
 * pre-existing, unmodified generic-engine invariant), but a real
 * commissionRate of 0% (a legitimate, explicitly allowed value — see
 * commission-rules.validation.js's `rate.min(0)`) makes commissionAmount
 * genuinely 0, and a 100% rate makes sellerEarning 0. Rather than pass a
 * zero-amount leg through to postJournal (which would throw) or weaken
 * postJournal's own validation (out of scope for this step), this
 * wrapper omits whichever of the PLATFORM_REVENUE / SELLER_WALLET legs
 * would be zero — the remaining legs still balance exactly, since
 * grossAmount === commissionAmount + sellerEarning by construction.
 *
 * Invalid split: if the caller passes amounts where grossAmount !==
 * commissionAmount + sellerEarning (a caller bug, not a 0%/100%-rate
 * edge case), this wrapper adds no extra check of its own — postJournal's
 * existing DEBIT-total === CREDIT-total validation already rejects it,
 * so no imbalanced Journal can ever commit.
 *
 * Both PLATFORM_CASH and PLATFORM_REVENUE are platform-owned (ownerId =
 * PLATFORM_LEDGER_OWNER_ID); SELLER_WALLET is owned by the seller's own
 * User.id (schema.prisma's LedgerAccountOwnerType doc: "SELLER_WALLET —
 * ownerId = User.id (== Store.sellerId)"), so the caller must supply
 * `sellerId` (settleDeliveredOrder resolves this via
 * `tx.store.findUnique({ where: { id: item.storeId } }).sellerId`).
 *
 * Same "operates inside the caller's transaction, opens none of its own"
 * contract as getOrCreateAccount/postJournal/postPaymentConfirmed. All
 * idempotency (including not double-applying the Account.balance update
 * on replay) is handled by postJournal itself via (eventType, eventId) —
 * this wrapper adds no idempotency logic of its own. `eventId` is
 * expected to be the per-item OrderItemSettlement.id (or equivalently
 * the OrderItem.id it's unique on) — settlement in this codebase is
 * per-OrderItem, not per-Order (see settleDeliveredOrder's per-item
 * loop) — matching the migration's own eventId doc ("Payment.id /
 * OrderItemSettlement.id / PaymentRefund.id / ... — see design doc §7's
 * per-event-type table").
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventId - OrderItemSettlement.id (or equivalent per-item id)
 * @param {string|null} [params.actorId]
 * @param {string} [params.currency]
 * @param {string} params.sellerId - the seller's User.id (== Store.sellerId)
 * @param {string|number|Prisma.Decimal} params.grossAmount
 * @param {string|number|Prisma.Decimal} params.commissionAmount
 * @param {string|number|Prisma.Decimal} params.sellerEarning
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postSettlement(tx, {
  eventId, actorId = null, currency = LEDGER_CURRENCY, sellerId, grossAmount, commissionAmount, sellerEarning,
}) {
  if (!sellerId) throw ApiError.internal('postSettlement requires sellerId');

  const mapping = EVENT_ACCOUNT_MAP.SETTLEMENT;

  const cashAccount = await getOrCreateAccount(tx, mapping.debitOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);

  const legs = [
    { accountId: cashAccount.id, direction: 'DEBIT', amount: grossAmount },
  ];

  if (new Prisma.Decimal(commissionAmount).greaterThan(0)) {
    const revenueAccount = await getOrCreateAccount(tx, mapping.creditRevenueOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);
    legs.push({ accountId: revenueAccount.id, direction: 'CREDIT', amount: commissionAmount });
  }

  if (new Prisma.Decimal(sellerEarning).greaterThan(0)) {
    const sellerAccount = await getOrCreateAccount(tx, mapping.creditSellerOwnerType, sellerId, currency);
    legs.push({ accountId: sellerAccount.id, direction: 'CREDIT', amount: sellerEarning });
  }

  return postJournal(tx, {
    eventType: 'SETTLEMENT',
    eventId,
    actorId,
    currency,
    legs,
  });
}

/**
 * Thin semantic wrapper over postJournal for the PAYOUT_RESERVE event —
 * the ledger-side mirror of payouts.service.js#createPayout's atomic
 * Wallet.balance debit at the REQUESTED step.
 *
 * Posts DEBIT SELLER_WALLET(sellerId) / CREDIT PAYOUT_CLEARING(PLATFORM)
 * for `amount`, per ledger.constants.js's EVENT_ACCOUNT_MAP.PAYOUT_RESERVE
 * — see that file's comment for why this mapping (unlike
 * PAYMENT_CONFIRMED/SETTLEMENT's account choice) is fully repo-derived
 * rather than supplied externally: it mirrors createPayout's real
 * `tx.wallet.updateMany({ data: { balance: { decrement: amount } } } })`
 * exactly, and PAYOUT_CLEARING's CREDIT (increase) is schema.prisma's own
 * "Reserved-but-not-yet-transferred seller payouts" doc comment for that
 * owner type.
 *
 * `eventId` is expected to be the PayoutRequest.id (schema.prisma's
 * Journal.eventId doc: PAYOUT_RESERVE/PAYOUT_RELEASE/PAYOUT_PROCESSED
 * deliberately share the same eventId across a payout's lifecycle).
 *
 * Same "operates inside the caller's transaction, opens none of its own"
 * contract as getOrCreateAccount/postJournal/the other wrappers. All
 * idempotency (including not double-applying the Account.balance update
 * on replay) is handled by postJournal itself via (eventType, eventId) —
 * this wrapper adds no idempotency logic of its own.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventId - PayoutRequest.id
 * @param {string|null} [params.actorId]
 * @param {string} [params.currency]
 * @param {string} params.sellerId - the seller's User.id
 * @param {string|number|Prisma.Decimal} params.amount
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postPayoutReserve(tx, {
  eventId, actorId = null, currency = LEDGER_CURRENCY, sellerId, amount,
}) {
  if (!sellerId) throw ApiError.internal('postPayoutReserve requires sellerId');

  const mapping = EVENT_ACCOUNT_MAP.PAYOUT_RESERVE;

  const sellerAccount = await getOrCreateAccount(tx, mapping.debitOwnerType, sellerId, currency);
  const clearingAccount = await getOrCreateAccount(tx, mapping.creditOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);

  return postJournal(tx, {
    eventType: 'PAYOUT_RESERVE',
    eventId,
    actorId,
    currency,
    legs: [
      { accountId: sellerAccount.id, direction: 'DEBIT', amount },
      { accountId: clearingAccount.id, direction: 'CREDIT', amount },
    ],
  });
}

/**
 * Thin semantic wrapper over postJournal for the PAYOUT_RELEASE event —
 * the ledger-side mirror of payouts.service.js#releaseReservation's
 * atomic Wallet.balance credit (called from both #rejectPayout's
 * REQUESTED -> REJECTED transition and #markFailed's APPROVED -> FAILED
 * transition — either way, a previously-reserved amount going back to the
 * seller without ever transferring).
 *
 * Posts DEBIT PAYOUT_CLEARING(PLATFORM) / CREDIT SELLER_WALLET(sellerId)
 * for `amount` — the exact reverse of postPayoutReserve's legs, per
 * ledger.constants.js's EVENT_ACCOUNT_MAP.PAYOUT_RELEASE. The
 * SELLER_WALLET CREDIT mirrors releaseReservation's real
 * `tx.wallet.updateMany({ data: { balance: { increment: amount } } } })`;
 * PAYOUT_CLEARING's DEBIT (decrease, back toward 0) is the arithmetic
 * consequence of a balanced 2-leg journal — see ledger.constants.js's
 * comment for the full reasoning.
 *
 * `eventId` is expected to be the SAME PayoutRequest.id used for that
 * payout's postPayoutReserve call (see that wrapper's doc and
 * schema.prisma's Journal.eventId doc) — this is a distinct eventType
 * (PAYOUT_RELEASE vs PAYOUT_RESERVE), so postJournal's
 * (eventType, eventId) idempotency key does not collide with the reserve
 * posting for the same PayoutRequest.
 *
 * Same "operates inside the caller's transaction, opens none of its own"
 * contract as the other wrappers. All idempotency (including not
 * double-applying the Account.balance update on replay) is handled by
 * postJournal itself via (eventType, eventId) — this wrapper adds no
 * idempotency logic of its own.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventId - PayoutRequest.id
 * @param {string|null} [params.actorId]
 * @param {string} [params.currency]
 * @param {string} params.sellerId - the seller's User.id
 * @param {string|number|Prisma.Decimal} params.amount
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postPayoutRelease(tx, {
  eventId, actorId = null, currency = LEDGER_CURRENCY, sellerId, amount,
}) {
  if (!sellerId) throw ApiError.internal('postPayoutRelease requires sellerId');

  const mapping = EVENT_ACCOUNT_MAP.PAYOUT_RELEASE;

  const clearingAccount = await getOrCreateAccount(tx, mapping.debitOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);
  const sellerAccount = await getOrCreateAccount(tx, mapping.creditOwnerType, sellerId, currency);

  return postJournal(tx, {
    eventType: 'PAYOUT_RELEASE',
    eventId,
    actorId,
    currency,
    legs: [
      { accountId: clearingAccount.id, direction: 'DEBIT', amount },
      { accountId: sellerAccount.id, direction: 'CREDIT', amount },
    ],
  });
}

/**
 * Thin semantic wrapper over postJournal for the REFUND event — the
 * NO-SHORTFALL path only.
 *
 * Posts:
 *   CREDIT CUSTOMER_WALLET (customerId)   customerAmount
 *   DEBIT  SELLER_WALLET (per sellerId)   sellerRefunds[].amount
 *   DEBIT  PLATFORM_REVENUE (PLATFORM)    commissionAmount
 * per ledger.constants.js's EVENT_ACCOUNT_MAP.REFUND — see that file's
 * comment for the full repo evidence behind each leg's direction
 * (CUSTOMER_WALLET's own "Funded by PaymentRefund credits" doc comment;
 * SELLER_WALLET's DEBIT mirroring refundDeliveredOrder's real
 * Wallet.balance decrement for the fast/no-shortfall path; PLATFORM_REVENUE
 * DEBIT reversing SETTLEMENT's own CREDIT for the same commissionAmount).
 * Balanced whenever customerAmount === sum(sellerRefunds[].amount) +
 * commissionAmount, by construction of refundDeliveredOrder's own
 * refundedGrossAmount = refundedCommissionAmount + refundedSellerEarning
 * split (mirrored, per-line, into sellerRefunds/commissionAmount here) —
 * postJournal's own DEBIT-total === CREDIT-total check is what actually
 * rejects an inconsistent split; this wrapper adds no extra check of its
 * own, same convention as postSettlement.
 *
 * SHORTFALL IS OUT OF SCOPE FOR THIS WRAPPER. refundDeliveredOrder's own
 * Pass 2 loop has a second branch — when a seller's Wallet can't cover the
 * full clawback, it collects whatever the wallet currently holds and
 * records the remainder as a SellerPayoutLiability row instead of the full
 * `amount` ever leaving SELLER_WALLET. This wrapper does NOT represent
 * that: `sellerRefunds[].amount` is posted to SELLER_WALLET as given,
 * unconditionally. Callers must only invoke this wrapper for the
 * no-shortfall case (i.e. pass the amount actually collected from the
 * seller's wallet, not the full clawback amount, if a shortfall occurred)
 * — this wrapper has no way to detect a shortfall itself, since it never
 * reads Wallet.balance (only Account.balance, a different, ledger-owned
 * number). Representing a shortfall's SellerPayoutLiability side in the
 * Ledger (whether as a liability owner type, which does not exist in the
 * current LedgerAccountOwnerType enum, or otherwise) is explicitly
 * deferred to a future step, not guessed here.
 *
 * Multiple sellers: `sellerRefunds` is an array of `{ sellerId, amount }`
 * (refundDeliveredOrder can refund items from more than one store/seller
 * in a single call — its `storeDebits` Map, one entry per storeId/sellerId
 * pair), so this wrapper posts one SELLER_WALLET DEBIT leg per entry
 * rather than assuming a single seller.
 *
 * Zero-amount legs: same convention as postSettlement — postJournal
 * rejects any leg with amount <= 0 (a pre-existing, unmodified
 * generic-engine invariant), so this wrapper omits the PLATFORM_REVENUE
 * leg when commissionAmount is 0, and omits any individual seller's leg
 * when that seller's refund amount is 0 (the 100%-commission edge case).
 * The remaining legs still balance exactly, by the same construction as
 * above.
 *
 * `eventId` is expected to be PaymentRefund.id (schema.prisma's
 * Journal.eventId doc: "... PaymentRefund.id ..." — refundDeliveredOrder
 * creates exactly one PaymentRefund row per call, covering however many
 * items/sellers were refunded, matching this wrapper's one-Journal-per-call
 * shape).
 *
 * Same "operates inside the caller's transaction, opens none of its own"
 * contract as getOrCreateAccount/postJournal/the other wrappers. All
 * idempotency (including not double-applying the Account.balance update
 * on replay) is handled by postJournal itself via (eventType, eventId) —
 * this wrapper adds no idempotency logic of its own.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventId - PaymentRefund.id
 * @param {string|null} [params.actorId]
 * @param {string} [params.currency]
 * @param {string} params.customerId - the customer's User.id
 * @param {string|number|Prisma.Decimal} params.customerAmount
 * @param {Array<{sellerId: string, amount: string|number|Prisma.Decimal}>} params.sellerRefunds
 * @param {string|number|Prisma.Decimal} params.commissionAmount
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postRefund(tx, {
  eventId, actorId = null, currency = LEDGER_CURRENCY, customerId, customerAmount, sellerRefunds, commissionAmount,
}) {
  if (!customerId) throw ApiError.internal('postRefund requires customerId');
  if (!Array.isArray(sellerRefunds) || sellerRefunds.length === 0) {
    throw ApiError.internal('postRefund requires a non-empty sellerRefunds array');
  }

  const mapping = EVENT_ACCOUNT_MAP.REFUND;

  const customerAccount = await getOrCreateAccount(tx, mapping.creditCustomerOwnerType, customerId, currency);

  const legs = [
    { accountId: customerAccount.id, direction: 'CREDIT', amount: customerAmount },
  ];

  // eslint-disable-next-line no-restricted-syntax
  for (const { sellerId, amount } of sellerRefunds) {
    if (!sellerId) throw ApiError.internal('postRefund requires sellerId for every sellerRefunds entry');
    if (new Prisma.Decimal(amount).greaterThan(0)) {
      // eslint-disable-next-line no-await-in-loop
      const sellerAccount = await getOrCreateAccount(tx, mapping.debitSellerOwnerType, sellerId, currency);
      legs.push({ accountId: sellerAccount.id, direction: 'DEBIT', amount });
    }
  }

  if (new Prisma.Decimal(commissionAmount).greaterThan(0)) {
    const revenueAccount = await getOrCreateAccount(tx, mapping.debitRevenueOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);
    legs.push({ accountId: revenueAccount.id, direction: 'DEBIT', amount: commissionAmount });
  }

  return postJournal(tx, {
    eventType: 'REFUND',
    eventId,
    actorId,
    currency,
    legs,
  });
}

module.exports = {
  getOrCreateAccount,
  postJournal,
  postPaymentConfirmed,
  postSettlement,
  postPayoutReserve,
  postPayoutRelease,
  postRefund,
};
