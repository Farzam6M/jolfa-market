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
 *     (eventType, eventId).
 *
 * Event wrapper functions (postPaymentConfirmed, postSettlement, ...) are
 * NOT implemented in this phase — see the accompanying phase report for
 * why (the design document schema.prisma repeatedly cites for the exact
 * per-event debit/credit legs does not exist anywhere in this repository).
 */

const { Prisma } = require('@prisma/client');
const ApiError = require('../../utils/ApiError');
const { LEDGER_CURRENCY } = require('./ledger.constants');

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
 *      found, return it as an idempotent replay — no new rows.
 *   2. Otherwise attempt to create the Journal + its LedgerEntry rows.
 *   3. If a concurrent caller wins the race, this Journal.create throws
 *      P2002 for journals_eventType_eventId_key; that specific conflict is
 *      caught, the winning Journal is re-fetched and returned, and no
 *      duplicate entries are created on this side.
 *
 * Balance requirement: SUM(DEBIT legs) must equal SUM(CREDIT legs),
 * computed with Prisma.Decimal (never Number/parseFloat). An unbalanced
 * journal throws before anything is written and nothing is committed.
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

module.exports = {
  getOrCreateAccount,
  postJournal,
};
