/**
 * P2.4 Phase 2 — Ledger Posting Service.
 *
 * [P2.3 correction: this module is NOT standalone/unwired — see below.]
 * This module IS imported by real business logic: payments.service.js
 * (postPaymentConfirmed), orders.service.js (postSettlement, postRefund),
 * payouts.service.js (postPayoutReserve, postPayoutRelease,
 * postPayoutProcessed), and payout-liabilities.service.js
 * (postLiabilityRecovery). Per the P2.2/P2.3 design decision block in
 * schema.prisma ("Ledger — Double-Entry Foundation"), Wallet.balance and
 * WalletTransaction remain the live, unchanged operational source of
 * truth — the Ledger has not been converted into (and does not yet
 * replace) Wallet.balance.
 *
 * [P2.4 correction: the two gaps below are CLOSED as of P2.4.] WALLET
 * payments now post PAYMENT_CONFIRMED via postWalletPaymentConfirmed, and
 * pre-delivery cancellation refunds now post PAYMENT_REVERSED via
 * postPaymentReversed (immediately for WALLET, deferred to
 * markGatewayRefundProcessed's successful REQUESTED->PROCESSED claim for
 * GATEWAY — see those wrappers' own doc comments). A PaymentRefund whose
 * `origin`/`ledgerStatus` are NULL (created before P2.4) is still treated
 * as a legacy row and deliberately skipped by automated Ledger posting —
 * see orders.service.js#markGatewayRefundProcessed's legacy-row branch —
 * so the Ledger is complete going forward but not retroactively for rows
 * that predate these two columns.
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
 * Seven event wrappers are implemented so far: postPaymentConfirmed (using
 * the PAYMENT_GATEWAY_CLEARING -> PLATFORM_CASH mapping supplied directly
 * by the product owner, not repo-derived), postSettlement (using the
 * PLATFORM_CASH -> PLATFORM_REVENUE + SELLER_WALLET split, whose account
 * choice was supplied by the product owner but whose gross/commission/
 * sellerEarning formula matches orders.service.js#settleDeliveredOrder
 * exactly), postPayoutReserve / postPayoutRelease (P2.4 Phase 2 Step 4),
 * whose SELLER_WALLET <-> PAYOUT_CLEARING mapping IS fully repo-derived: it
 * mirrors payouts.service.js#createPayout's and #releaseReservation's real
 * Wallet.balance debit/credit exactly, postRefund (P2.4 Phase 2 Step 5;
 * [P2.9 correction: no longer no-shortfall-only] — P2.9/Model C extended
 * this wrapper with a DEBIT PLATFORM_RECEIVABLE leg for whatever a
 * seller's wallet couldn't cover, removing the anyShortfall gate that used
 * to suppress the entire REFUND Journal on any shortfall — see postRefund's
 * own doc comment and ledger.constants.js's EVENT_ACCOUNT_MAP comment),
 * whose CUSTOMER_WALLET/SELLER_WALLET/PLATFORM_REVENUE mapping is likewise
 * fully repo-derived: it mirrors orders.service.js#refundDeliveredOrder's
 * real customer-credit and seller-wallet-decrement mutations exactly, and
 * reverses SETTLEMENT's own CREDIT PLATFORM_REVENUE leg, postPayoutProcessed (P2.4
 * Phase 2 Step 7), using the PAYOUT_CLEARING -> PLATFORM_CASH mapping
 * supplied directly by the product owner for that step (Step 4 audited
 * this event and found it genuinely unresolvable from repo evidence
 * alone; see ledger.constants.js's EVENT_ACCOUNT_MAP comment), and — added
 * in P2.4 Phase 2 Step 10 — postLiabilityRecovery, using the SELLER_WALLET
 * -> PLATFORM_CASH mapping approved in the Step 9 design reconciliation
 * (the previously open PLATFORM_CASH-vs-PLATFORM_REVENUE question is now
 * resolved; see ledger.constants.js's EVENT_ACCOUNT_MAP comment).
 *
 * [P2.3 correction: postLiabilityRecovery IS wired.] It is called from
 * payout-liabilities.service.js#recoverSellerLiabilities in the same
 * transaction as that function's liability decrement and WalletTransaction
 * write, and — as of P2.9 — now selects its CREDIT leg (PLATFORM_RECEIVABLE
 * vs PLATFORM_CASH) per liability; see postLiabilityRecovery's own doc
 * comment. [P2.9 correction: postRefund's shortfall path is no longer out
 * of scope] — see postRefund's own doc comment for the current behavior.
 *
 * P2.4 adds two more wrappers: postWalletPaymentConfirmed (WALLET-payment
 * counterpart to postPaymentConfirmed, wired into payments.service.js#
 * payWithWallet) and postPaymentReversed (WALLET/GATEWAY-branching
 * PRE_DELIVERY_CANCELLATION reversal, wired into orders.service.js's
 * CANCELLED transition and markGatewayRefundProcessed). As of P2.4,
 * postRefund's own GATEWAY-refund posting is also deferred from refund-
 * request time to markGatewayRefundProcessed's successful claim — see that
 * function's own doc comment.
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
 * @param {Date} [params.createdAt] - P2.5 Part B addition. Explicit Journal
 *   timestamp override; defaults to the column's own `@default(now())` when
 *   omitted, so every pre-P2.5 caller is unaffected. Added solely so the
 *   opening-balance migration can stamp every Journal in one batch with the
 *   same fixed cutover instant (P2.5 spec §8.5) instead of each call's own
 *   real `now()` — no other caller in this codebase passes it.
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postJournal(tx, {
  eventType, eventId, actorId = null, currency = LEDGER_CURRENCY, legs, createdAt,
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
        eventType,
        eventId,
        actorId,
        currency,
        ...(createdAt ? { createdAt } : {}),
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
 * Thin semantic wrapper over postJournal for the PAYOUT_PROCESSED event —
 * the terminal APPROVED -> PROCESSED step of a payout's lifecycle
 * (payouts.service.js#markProcessed).
 *
 * Posts DEBIT PAYOUT_CLEARING(PLATFORM) / CREDIT PLATFORM_CASH(PLATFORM)
 * for `amount`, per ledger.constants.js's EVENT_ACCOUNT_MAP.PAYOUT_PROCESSED
 * — see that file's comment for why this mapping (like PAYMENT_CONFIRMED/
 * SETTLEMENT's account choice, and unlike PAYOUT_RESERVE/PAYOUT_RELEASE/
 * REFUND) was supplied directly by the product owner rather than derived
 * from repo evidence: markProcessed's own doc comment states there is no
 * real Wallet.balance mutation at this step ("the money already left the
 * seller's wallet at REQUESTED time"), so unlike PAYOUT_RESERVE/
 * PAYOUT_RELEASE there is nothing for this wrapper's legs to mirror
 * directly.
 *
 * The seller's Wallet/SELLER_WALLET account is deliberately NOT touched
 * here — the reserved amount already left SELLER_WALLET (and entered
 * PAYOUT_CLEARING) at the postPayoutReserve step; this wrapper only closes
 * PAYOUT_CLEARING back out once the off-platform transfer is confirmed, so
 * `sellerId` is accepted for eventId/traceability symmetry with the other
 * payout wrappers but is not used to resolve any account here — both legs
 * of this journal are platform-owned (ownerId = PLATFORM_LEDGER_OWNER_ID).
 *
 * `eventId` is expected to be the SAME PayoutRequest.id used for that
 * payout's postPayoutReserve/postPayoutRelease calls (schema.prisma's
 * Journal.eventId doc: PAYOUT_RESERVE/PAYOUT_RELEASE/PAYOUT_PROCESSED
 * deliberately share the same eventId across a payout's lifecycle) — this
 * is a distinct eventType from either, so postJournal's
 * (eventType, eventId) idempotency key does not collide with them.
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
 * @param {string} params.sellerId - the seller's User.id (accepted for traceability symmetry with the other payout wrappers; not used to resolve an account, since both legs here are platform-owned)
 * @param {string|number|Prisma.Decimal} params.amount
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postPayoutProcessed(tx, {
  eventId, actorId = null, currency = LEDGER_CURRENCY, sellerId, amount,
}) {
  if (!sellerId) throw ApiError.internal('postPayoutProcessed requires sellerId');

  const mapping = EVENT_ACCOUNT_MAP.PAYOUT_PROCESSED;

  const clearingAccount = await getOrCreateAccount(tx, mapping.debitOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);
  const cashAccount = await getOrCreateAccount(tx, mapping.creditOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);

  return postJournal(tx, {
    eventType: 'PAYOUT_PROCESSED',
    eventId,
    actorId,
    currency,
    legs: [
      { accountId: clearingAccount.id, direction: 'DEBIT', amount },
      { accountId: cashAccount.id, direction: 'CREDIT', amount },
    ],
  });
}

/**
 * Thin semantic wrapper over postJournal for the REFUND event.
 *
 * [P2.9 — Model C, P2.8 Finding A] Previously this wrapper only implemented
 * the no-shortfall path — a delivered-order refund whose seller-wallet
 * clawback couldn't be fully collected suppressed the ENTIRE REFUND
 * Journal (an aggregate `anyShortfall` gate in refundDeliveredOrder),
 * losing Ledger coverage for the clean legs too. P2.9 removes that gate:
 * this wrapper now ALWAYS represents whatever was actually collected from
 * each seller/store, plus whatever wasn't, as a genuine platform
 * receivable claim — no new LedgerEventType, same REFUND event, same
 * one-Journal-per-PaymentRefund shape.
 *
 * Posts, per ledger.constants.js's EVENT_ACCOUNT_MAP.REFUND:
 *   CREDIT CUSTOMER_WALLET (customerId)      customerAmount
 *   DEBIT  SELLER_WALLET (per store)         sellerRefunds[].collectedAmount
 *   DEBIT  PLATFORM_REVENUE (PLATFORM)       commissionAmount
 *   DEBIT  PLATFORM_RECEIVABLE (PLATFORM)    sellerRefunds[].shortfallAmount
 * Balanced whenever, per store, collectedAmount + shortfallAmount equals
 * that store's originally requested clawback, and
 * customerAmount == sum(collectedAmount) + commissionAmount + sum(shortfallAmount)
 * overall — postJournal's own DEBIT-total === CREDIT-total check is what
 * actually rejects an inconsistent split; this wrapper adds no extra check
 * of its own, same convention as postSettlement.
 *
 * PLATFORM_RECEIVABLE is a SINGLETON platform account (ownerId =
 * PLATFORM_LEDGER_OWNER_ID) — every shortfalling store/seller in one
 * refund shares the same Account row, so a multi-shortfall refund can post
 * several DEBIT PLATFORM_RECEIVABLE legs against that one account inside
 * the same Journal. Per-liability traceability (which specific
 * PLATFORM_RECEIVABLE LedgerEntry belongs to which store's
 * SellerPayoutLiability) is therefore resolved and returned by THIS
 * wrapper as `receivableEntryByStoreId`, not left to the caller to infer —
 * see that return field's own comment below for why (a Journal-level
 * reference alone cannot disambiguate two same-amount shortfalls in one
 * refund; SellerPayoutLiability.ledgerReceivableEntryId is a LedgerEntry
 * reference for exactly this reason).
 *
 * Multiple sellers/stores: `sellerRefunds` is an array of
 * `{ storeId, sellerId, collectedAmount, shortfallAmount }` — one entry
 * per store (refundDeliveredOrder's `storeDebits` Map, one entry per
 * storeId/sellerId pair; the same seller can appear more than once here if
 * they own multiple stores refunded in this call, each with its own
 * independent collected/shortfall split). This wrapper posts at most one
 * SELLER_WALLET DEBIT leg and at most one PLATFORM_RECEIVABLE DEBIT leg
 * per entry, not one per seller — the SELLER_WALLET account itself is
 * still per-seller (getOrCreateAccount dedupes by ownerId), so two stores
 * for the same seller correctly land as two separate LedgerEntry rows
 * against the SAME Account, summing correctly in that Account's cached
 * balance either way.
 *
 * Zero-amount legs: same convention as postSettlement/the pre-P2.9 version
 * of this wrapper — postJournal rejects any leg with amount <= 0 (a
 * pre-existing, unmodified generic-engine invariant), so this wrapper
 * omits the PLATFORM_REVENUE leg when commissionAmount is 0, omits a
 * store's SELLER_WALLET leg when collectedAmount is 0 (full shortfall) or
 * its PLATFORM_RECEIVABLE leg when shortfallAmount is 0 (no shortfall for
 * that store) — this is how a fully-clean, all-sellers-collected refund
 * ends up with zero PLATFORM_RECEIVABLE legs at all, identical to the
 * pre-P2.9 output shape.
 *
 * `eventId` is expected to be PaymentRefund.id (unchanged from pre-P2.9 —
 * schema.prisma's Journal.eventId doc: "... PaymentRefund.id ..." —
 * refundDeliveredOrder creates exactly one PaymentRefund row per call,
 * covering however many items/sellers/stores were refunded, matching this
 * wrapper's one-Journal-per-call shape). Idempotency
 * (postJournal via (eventType, eventId)) is unchanged by P2.9.
 *
 * Same "operates inside the caller's transaction, opens none of its own"
 * contract as getOrCreateAccount/postJournal/the other wrappers.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventId - PaymentRefund.id
 * @param {string|null} [params.actorId]
 * @param {string} [params.currency]
 * @param {string} params.customerId - the customer's User.id
 * @param {string|number|Prisma.Decimal} params.customerAmount
 * @param {Array<{storeId: string, sellerId: string, collectedAmount?: string|number|Prisma.Decimal, shortfallAmount?: string|number|Prisma.Decimal}>} params.sellerRefunds
 * @param {string|number|Prisma.Decimal} params.commissionAmount
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean, receivableEntryByStoreId: Map<string, object>}>}
 *   `receivableEntryByStoreId` maps each shortfalling store's storeId to
 *   the exact LedgerEntry row for its PLATFORM_RECEIVABLE DEBIT leg — the
 *   caller (refundDeliveredOrder / markGatewayRefundProcessed) uses this
 *   to set SellerPayoutLiability.ledgerReceivableEntryId precisely, never
 *   by guessing from Journal id + amount. Empty Map when no store had a
 *   shortfall.
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

  // P2.9 — resolved lazily, at most once: PLATFORM_RECEIVABLE is a
  // singleton platform account, shared by every shortfalling store in
  // this refund (same lazy-resolve-once pattern as PLATFORM_REVENUE
  // below).
  let receivableAccount = null;
  // storeId -> the leg object just pushed for that store's shortfall
  // (object identity, not value) — used below to recover which persisted
  // LedgerEntry corresponds to which store once postJournal returns.
  const receivableLegByStoreId = new Map();

  // eslint-disable-next-line no-restricted-syntax
  for (const {
    storeId, sellerId, collectedAmount = 0, shortfallAmount = 0,
  } of sellerRefunds) {
    if (!sellerId) throw ApiError.internal('postRefund requires sellerId for every sellerRefunds entry');
    if (!storeId) throw ApiError.internal('postRefund requires storeId for every sellerRefunds entry');

    if (new Prisma.Decimal(collectedAmount).greaterThan(0)) {
      // eslint-disable-next-line no-await-in-loop
      const sellerAccount = await getOrCreateAccount(tx, mapping.debitSellerOwnerType, sellerId, currency);
      legs.push({ accountId: sellerAccount.id, direction: 'DEBIT', amount: collectedAmount });
    }

    if (new Prisma.Decimal(shortfallAmount).greaterThan(0)) {
      if (!receivableAccount) {
        // eslint-disable-next-line no-await-in-loop
        receivableAccount = await getOrCreateAccount(tx, mapping.debitReceivableOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);
      }
      const receivableLeg = { accountId: receivableAccount.id, direction: 'DEBIT', amount: shortfallAmount };
      legs.push(receivableLeg);
      receivableLegByStoreId.set(storeId, receivableLeg);
    }
  }

  if (new Prisma.Decimal(commissionAmount).greaterThan(0)) {
    const revenueAccount = await getOrCreateAccount(tx, mapping.debitRevenueOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);
    legs.push({ accountId: revenueAccount.id, direction: 'DEBIT', amount: commissionAmount });
  }

  const result = await postJournal(tx, {
    eventType: 'REFUND',
    eventId,
    actorId,
    currency,
    legs,
  });

  // P2.9 — resolve each shortfalling store's own PLATFORM_RECEIVABLE
  // LedgerEntry. Matched by (accountId, direction, amount) against
  // `result.entries` rather than by array position: on a fresh post,
  // postJournal's `entries` are guaranteed to be in the same order as
  // `legs` (built by a plain sequential push in its own for-loop), but on
  // an idempotent replay `entries` comes from a plain findMany with no
  // explicit ORDER BY, so position is not a safe assumption there. Each
  // candidate entry is consumed at most once (splice), so N shortfall legs
  // of the SAME amount in the SAME journal still pair up one-to-one with
  // N liabilities. The only residual ambiguity is which SPECIFIC row a
  // given liability ends up pointing at when two shortfalls in this same
  // refund share the exact same amount — the aggregate accounting is
  // identical either way (each liability's own originalAmount still
  // matches whichever row it's paired with), so this is a traceability
  // nicety, not a correctness gap.
  const receivableEntryByStoreId = new Map();
  if (receivableLegByStoreId.size > 0) {
    const candidateEntries = result.entries.filter(
      (entry) => entry.accountId === receivableAccount.id && entry.direction === 'DEBIT',
    );
    // eslint-disable-next-line no-restricted-syntax
    for (const [storeId, leg] of receivableLegByStoreId) {
      const idx = candidateEntries.findIndex(
        (entry) => new Prisma.Decimal(entry.amount).equals(new Prisma.Decimal(leg.amount)),
      );
      if (idx === -1) {
        // Should be unreachable: postJournal guarantees every leg this
        // call supplied was persisted (or, on replay, was already
        // persisted identically). A miss here means the persisted
        // journal's legs no longer match what this call computed — a
        // genuine data-integrity problem worth failing loudly on rather
        // than silently leaving a liability unlinked.
        throw ApiError.internal(`postRefund could not resolve a PLATFORM_RECEIVABLE LedgerEntry for store ${storeId} in journal ${result.journal.id}`);
      }
      const [entry] = candidateEntries.splice(idx, 1);
      receivableEntryByStoreId.set(storeId, entry);
    }
  }

  return { ...result, receivableEntryByStoreId };
}

/**
 * Thin semantic wrapper over postJournal for the LIABILITY_RECOVERY event.
 *
 * A separate Ledger event with its own Journal — deliberately NOT folded
 * into postSettlement (see this function's own contract below and
 * postSettlement's unchanged doc comment above). Per the approved P2.4
 * Phase 2 Step 9 design reconciliation, the existing business-level
 * SellerPayoutLiability model and its recovery logic
 * (payout-liabilities.service.js#recoverSellerLiabilities) are unchanged
 * by this wrapper — this step adds no new Ledger account type such as a
 * SELLER_PAYOUT_LIABILITY owner type, and this wrapper is not called from
 * that business logic yet (deferred to a future wiring phase).
 *
 * Posts:
 *   DEBIT  SELLER_WALLET (sellerId)                                amount
 *   CREDIT PLATFORM_CASH or PLATFORM_RECEIVABLE (PLATFORM)         amount
 * per ledger.constants.js's EVENT_ACCOUNT_MAP.LIABILITY_RECOVERY /
 * LIABILITY_RECOVERY_RECEIVABLE_BACKED. The DEBIT SELLER_WALLET side is
 * unchanged from the original P2.4 Phase 2 Step 9 design (the seller's
 * outstanding liability is being recovered from a future seller earning,
 * so the recovered amount reduces the seller's effective wallet position).
 *
 * [P2.9 — Model C, P2.8 Finding A] The CREDIT side now has two mappings,
 * selected by the caller via `receivableBacked`:
 *   - receivableBacked = false (default, unchanged pre-P2.9 behavior):
 *     CREDIT PLATFORM_CASH — the original P2.4 resolution for a liability
 *     with no corresponding PLATFORM_RECEIVABLE claim to reduce (every
 *     liability, before P2.9). This remains the PERMANENT branch for
 *     legacy liabilities (SellerPayoutLiability.ledgerReceivableEntryId ==
 *     NULL) — not a transitional default, since historical liabilities are
 *     never retroactively backfilled with a receivable leg.
 *   - receivableBacked = true: CREDIT PLATFORM_RECEIVABLE — this recovery
 *     is reducing money the platform is already carrying as an outstanding
 *     PLATFORM_RECEIVABLE claim against this exact seller (posted by
 *     postRefund at REFUND time — see that wrapper's own doc comment), so
 *     the credit lands back on PLATFORM_RECEIVABLE, moving its (negative)
 *     balance toward zero, rather than being recognized as PLATFORM_CASH a
 *     second time.
 * The caller (payout-liabilities.service.js#recoverSellerLiabilities)
 * decides which branch applies per liability, based on that liability's
 * own persisted `ledgerReceivableEntryId` — this wrapper does not look up
 * SellerPayoutLiability itself (same "business-level bookkeeping stays in
 * the business layer" boundary as the rest of this comment).
 *
 * This wrapper does not compute or look up the liability amount itself —
 * it simply posts whatever `amount` the caller supplies (e.g. a partial
 * recovery of a larger SellerPayoutLiability across multiple settlements).
 * Any liability-balance bookkeeping remains entirely the business layer's
 * responsibility (SellerPayoutLiability, untouched by this step).
 *
 * `eventId` is expected to be the deterministic composite
 * `${orderItemSettlement.id}:${liability.id}` — NOT liability.id alone —
 * since a single SellerPayoutLiability can be partially recovered across
 * multiple settlements, and each (settlement, liability) recovery
 * occurrence needs its own idempotency key. Unchanged by P2.9.
 *
 * Same "operates inside the caller's transaction, opens none of its own"
 * contract as getOrCreateAccount/postJournal/the other wrappers. All
 * idempotency (including not double-applying the Account.balance update
 * on replay) is handled by postJournal itself via (eventType, eventId) —
 * this wrapper adds no idempotency logic of its own.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventId - `${orderItemSettlement.id}:${liability.id}`
 * @param {string|null} [params.actorId]
 * @param {string} [params.currency]
 * @param {string} params.sellerId - the seller's User.id (== Store.sellerId)
 * @param {string|number|Prisma.Decimal} params.amount - the recoveredAmount for this occurrence
 * @param {boolean} [params.receivableBacked] - true credits PLATFORM_RECEIVABLE (this liability has a ledgerReceivableEntryId), false (default) credits PLATFORM_CASH (legacy liability)
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postLiabilityRecovery(tx, {
  eventId, actorId = null, currency = LEDGER_CURRENCY, sellerId, amount, receivableBacked = false,
}) {
  if (!sellerId) throw ApiError.internal('postLiabilityRecovery requires sellerId');

  const mapping = receivableBacked
    ? EVENT_ACCOUNT_MAP.LIABILITY_RECOVERY_RECEIVABLE_BACKED
    : EVENT_ACCOUNT_MAP.LIABILITY_RECOVERY;

  const sellerAccount = await getOrCreateAccount(tx, mapping.debitOwnerType, sellerId, currency);
  const creditAccount = await getOrCreateAccount(tx, mapping.creditOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);

  return postJournal(tx, {
    eventType: 'LIABILITY_RECOVERY',
    eventId,
    actorId,
    currency,
    legs: [
      { accountId: sellerAccount.id, direction: 'DEBIT', amount },
      { accountId: creditAccount.id, direction: 'CREDIT', amount },
    ],
  });
}

/**
 * Thin semantic wrapper over postJournal for the PAYMENT_CONFIRMED event —
 * the WALLET-payment counterpart to postPaymentConfirmed above.
 *
 * Posts DEBIT CUSTOMER_WALLET(customerId) / CREDIT PLATFORM_CASH for
 * `amount`, per ledger.constants.js's EVENT_ACCOUNT_MAP.PAYMENT_CONFIRMED_WALLET
 * — see that file's comment for why this is a separate, fully repo-derived
 * mapping from postPaymentConfirmed's GATEWAY-only one, not a variant of it.
 *
 * Called from payments.service.js#payWithWallet, inside the SAME transaction
 * as that function's atomic Wallet.balance debit and Payment.create — never
 * from confirmGateway (which remains postPaymentConfirmed-only).
 *
 * Same "operates inside the caller's transaction, opens none of its own"
 * contract as the other wrappers. All idempotency (including not
 * double-applying the Account.balance update on replay) is handled by
 * postJournal itself via (eventType, eventId) — this wrapper adds no
 * idempotency logic of its own. `eventId` is expected to be Payment.id
 * (the WALLET Payment row payWithWallet just created).
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventId - Payment.id
 * @param {string|null} [params.actorId]
 * @param {string} [params.currency]
 * @param {string} params.customerId - the paying customer's User.id
 * @param {string|number|Prisma.Decimal} params.amount
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postWalletPaymentConfirmed(tx, {
  eventId, actorId = null, currency = LEDGER_CURRENCY, customerId, amount,
}) {
  if (!customerId) throw ApiError.internal('postWalletPaymentConfirmed requires customerId');

  const mapping = EVENT_ACCOUNT_MAP.PAYMENT_CONFIRMED_WALLET;

  const customerAccount = await getOrCreateAccount(tx, mapping.debitOwnerType, customerId, currency);
  const cashAccount = await getOrCreateAccount(tx, mapping.creditOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);

  return postJournal(tx, {
    eventType: 'PAYMENT_CONFIRMED',
    eventId,
    actorId,
    currency,
    legs: [
      { accountId: customerAccount.id, direction: 'DEBIT', amount },
      { accountId: cashAccount.id, direction: 'CREDIT', amount },
    ],
  });
}

/**
 * Thin semantic wrapper over postJournal for the PAYMENT_REVERSED event —
 * a payment reversed before any settlement ever happened (origin
 * PRE_DELIVERY_CANCELLATION only — see payments.service.js#refundWallet/
 * refundGateway's required `origin` parameter and
 * orders.service.js#markGatewayRefundProcessed's origin-based branching).
 * Never used for a delivered-order refund — that remains postRefund/REFUND.
 *
 * `method` selects which of ledger.constants.js's
 * EVENT_ACCOUNT_MAP.PAYMENT_REVERSED.{WALLET,GATEWAY} sub-mappings applies
 * (see that file's comment for the reasoning behind each):
 *   WALLET:  DEBIT PLATFORM_CASH / CREDIT CUSTOMER_WALLET(customerId) —
 *            `customerId` is REQUIRED for this method (thrown loudly if
 *            missing, same "fail loud rather than silently mis-post"
 *            philosophy as refundWallet/refundGateway's required `origin`).
 *   GATEWAY: DEBIT PLATFORM_CASH / CREDIT PAYMENT_GATEWAY_CLEARING — both
 *            legs platform-owned; `customerId` is not needed and ignored.
 *
 * Called from two places, both inside the same transaction as the real
 * money movement / status claim they mirror:
 *   - orders.service.js#updateStatus's CANCELLED branch, WALLET-payment
 *     path — immediately after refundWallet, same transaction (Ledger
 *     posting is not deferred for WALLET, since the wallet credit is
 *     immediate).
 *   - orders.service.js#markGatewayRefundProcessed's Case A (origin
 *     PRE_DELIVERY_CANCELLATION) — only after that function's own atomic
 *     REQUESTED -> PROCESSED claim succeeds, since a GATEWAY reversal is
 *     never posted at cancellation-request time (no real gateway reversal
 *     has happened yet).
 *
 * Same "operates inside the caller's transaction, opens none of its own"
 * contract as the other wrappers. All idempotency (including not
 * double-applying the Account.balance update on replay) is handled by
 * postJournal itself via (eventType, eventId) — this wrapper adds no
 * idempotency logic of its own. `eventId` is expected to be Payment.id —
 * a cancelled order's succeeded payment is refunded in full, exactly once,
 * so (PAYMENT_REVERSED, Payment.id) is a safe, non-colliding idempotency key.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventId - Payment.id
 * @param {string|null} [params.actorId]
 * @param {string} [params.currency]
 * @param {'WALLET'|'GATEWAY'} params.method
 * @param {string|null} [params.customerId] - required when method is WALLET
 * @param {string|number|Prisma.Decimal} params.amount
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postPaymentReversed(tx, {
  eventId, actorId = null, currency = LEDGER_CURRENCY, method, customerId = null, amount,
}) {
  if (method !== 'WALLET' && method !== 'GATEWAY') {
    throw ApiError.internal('postPaymentReversed requires method WALLET or GATEWAY');
  }
  if (method === 'WALLET' && !customerId) {
    throw ApiError.internal('postPaymentReversed requires customerId when method is WALLET');
  }

  const mapping = EVENT_ACCOUNT_MAP.PAYMENT_REVERSED[method];

  const debitAccount = await getOrCreateAccount(tx, mapping.debitOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);
  const creditAccount = method === 'WALLET'
    ? await getOrCreateAccount(tx, mapping.creditOwnerType, customerId, currency)
    : await getOrCreateAccount(tx, mapping.creditOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);

  return postJournal(tx, {
    eventType: 'PAYMENT_REVERSED',
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
 * Thin semantic wrapper over postJournal for the P2.5 Part B OPENING_BALANCE
 * event. Posts CREDIT <ownerType>(ownerId) / DEBIT PLATFORM_CASH for
 * `amount` — the mapping in ledger.constants.js's
 * EVENT_ACCOUNT_MAP.OPENING_BALANCE, approved for the P2.5 opening-balance
 * migration only (Decision Gate 3). This is NOT a reconstruction of any real
 * historical payment/settlement/refund/payout event — it is a one-time
 * accounting initialization of a CUSTOMER_WALLET or SELLER_WALLET account
 * from Wallet.balance at a fixed migration cutover instant. Never called
 * from any live runtime financial code path — only from
 * scripts/p2_5-opening-balance-migration.js.
 *
 * [P2.5 Part B correction] The wallet leg is CREDIT (not DEBIT — a prior
 * revision of this wrapper copied the DEBIT/CREDIT wording from the P2.5
 * spec's illustrative example literally, without checking it against this
 * codebase's own established Account.balance convention). postJournal's
 * balance-update code increments Account.balance on CREDIT and decrements
 * it on DEBIT, and every other wired wrapper in this file that adds money
 * to a CUSTOMER_WALLET/SELLER_WALLET follows that same convention:
 * postSettlement and postRefund both CREDIT the wallet they're crediting;
 * postWalletPaymentConfirmed and postLiabilityRecovery both DEBIT the
 * wallet when money leaves it. A DEBIT here would have decreased a
 * freshly-created (zero-balance) wallet account into negative territory
 * for a positive opening amount — the opposite of what "initialize this
 * account's balance to match Wallet.balance" requires. CREDIT wallet /
 * DEBIT PLATFORM_CASH is the correct direction under this codebase's
 * convention, matching every other event that adds funds to a wallet.
 *
 * `ownerType` is caller-supplied (CUSTOMER_WALLET or SELLER_WALLET) since a
 * single migration run initializes accounts of both owner types; unlike
 * every other wrapper in this file, OPENING_BALANCE's credited side is not
 * fixed to one owner type in EVENT_ACCOUNT_MAP.
 *
 * `eventId` MUST be `OPENING_BALANCE:${account.id}` (P2.5 spec §8.1) — the
 * caller (the migration script) is responsible for constructing it from the
 * account row already resolved via getOrCreateAccount, so this wrapper
 * accepts it as-is rather than re-deriving it, keeping the eventId
 * convention visible and auditable at the call site.
 *
 * Same "operates inside the caller's transaction, opens none of its own"
 * contract as the other wrappers. All idempotency (including not
 * double-applying the Account.balance update on replay) is handled by
 * postJournal itself via (eventType, eventId) — this wrapper adds no
 * idempotency logic of its own.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.eventId - `OPENING_BALANCE:${accountId}`
 * @param {'CUSTOMER_WALLET'|'SELLER_WALLET'} params.ownerType
 * @param {string} params.accountId - the already-resolved wallet Account.id
 * @param {string|number|Prisma.Decimal} params.amount - Wallet.balance at the fixed cutover instant; must be > 0
 * @param {Date} params.cutoverAt - the single fixed cutover timestamp for the whole migration batch (P2.5 spec §8.5)
 * @param {string} [params.currency]
 * @returns {Promise<{journal: object, entries: object[], idempotentReplay: boolean}>}
 */
async function postOpeningBalance(tx, {
  eventId, ownerType, accountId, amount, cutoverAt, currency = LEDGER_CURRENCY,
}) {
  if (ownerType !== 'CUSTOMER_WALLET' && ownerType !== 'SELLER_WALLET') {
    throw ApiError.internal('postOpeningBalance requires ownerType CUSTOMER_WALLET or SELLER_WALLET');
  }
  if (!accountId) throw ApiError.internal('postOpeningBalance requires accountId');
  if (!cutoverAt) throw ApiError.internal('postOpeningBalance requires cutoverAt');

  const mapping = EVENT_ACCOUNT_MAP.OPENING_BALANCE;
  const cashAccount = await getOrCreateAccount(tx, mapping.debitOwnerType, PLATFORM_LEDGER_OWNER_ID, currency);

  return postJournal(tx, {
    eventType: 'OPENING_BALANCE',
    eventId,
    actorId: null,
    currency,
    createdAt: cutoverAt,
    legs: [
      { accountId, direction: 'CREDIT', amount },
      { accountId: cashAccount.id, direction: 'DEBIT', amount },
    ],
  });
}

module.exports = {
  getOrCreateAccount,
  postJournal,
  postPaymentConfirmed,
  postWalletPaymentConfirmed,
  postSettlement,
  postOpeningBalance,
  postPayoutReserve,
  postPayoutRelease,
  postPayoutProcessed,
  postRefund,
  postPaymentReversed,
  postLiabilityRecovery,
};
