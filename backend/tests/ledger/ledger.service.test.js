/**
 * Tests for P2.4 Phase 2's standalone Ledger Posting Service
 * (src/modules/ledger/ledger.service.js).
 *
 * This module is intentionally unwired from every existing business flow
 * (see ledger.service.js's module-level comment), so — unlike
 * tests/payouts.test.js — these tests call getOrCreateAccount/postJournal
 * directly inside a real `prisma.$transaction`, with no HTTP layer, no
 * auth, and no seeded roles/users required.
 *
 * Only postPaymentConfirmed-style event wrapper coverage is out of scope
 * here: those wrappers are not implemented in this phase (see the P2.4
 * Phase 2 report — the design document schema.prisma cites for the exact
 * per-event debit/credit legs does not exist anywhere in this repository).
 * These tests exercise the two generic primitives the phase does
 * implement: getOrCreateAccount and postJournal (balance + idempotency).
 *
 * Uses random UUIDs for every ownerId/eventId so repeated runs never
 * collide, and cleans up exactly the rows it created in `afterAll` —
 * same targeted-deleteMany-by-id convention as
 * tests/commission-rules-governance.test.js#hardDelete, not a wrapped/
 * rolled-back transaction (no such convention exists elsewhere in this
 * test suite; tests/payouts.test.js and friends write real rows against a
 * real test database the same way).
 *
 * Requires a real Postgres database (DATABASE_URL), migrated:
 *   NODE_ENV=test npx jest tests/ledger/ledger.service.test.js --runInBand
 */
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../../src/config/database');
const { getOrCreateAccount, postJournal } = require('../../src/modules/ledger/ledger.service');

const createdAccountIds = [];
const createdEventIds = []; // [eventType, eventId]

async function withTx(fn) {
  return prisma.$transaction(async (tx) => fn(tx));
}

async function makeAccount(tx, ownerType, ownerId) {
  const account = await getOrCreateAccount(tx, ownerType, ownerId, 'TMN');
  createdAccountIds.push(account.id);
  return account;
}

afterAll(async () => {
  // Children first (FK onDelete: Restrict on ledger_entries -> journals/
  // ledger_accounts, per the 20260811000000_ledger_foundation migration).
  const journalWhere = {
    OR: createdEventIds.map(([eventType, eventId]) => ({ eventType, eventId })),
  };
  if (createdEventIds.length > 0) {
    const journals = await prisma.journal.findMany({ where: journalWhere, select: { id: true } });
    const journalIds = journals.map((j) => j.id);
    if (journalIds.length > 0) {
      await prisma.ledgerEntry.deleteMany({ where: { journalId: { in: journalIds } } });
    }
    await prisma.journal.deleteMany({ where: journalWhere });
  }
  if (createdAccountIds.length > 0) {
    await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  }
  await prisma.$disconnect();
});

describe('getOrCreateAccount', () => {
  test('creates an Account on first use, reuses it on second use — never duplicates', async () => {
    const ownerId = crypto.randomUUID();
    const first = await withTx((tx) => getOrCreateAccount(tx, 'SELLER_WALLET', ownerId, 'TMN'));
    createdAccountIds.push(first.id);
    const second = await withTx((tx) => getOrCreateAccount(tx, 'SELLER_WALLET', ownerId, 'TMN'));

    expect(second.id).toBe(first.id);
    const rows = await prisma.account.findMany({
      where: { ownerType: 'SELLER_WALLET', ownerId, currency: 'TMN' },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('postJournal', () => {
  test('a balanced journal creates the Journal and correct LedgerEntry rows', async () => {
    const eventId = crypto.randomUUID();
    createdEventIds.push(['PAYMENT_CONFIRMED', eventId]);

    const result = await withTx(async (tx) => {
      const accA = await makeAccount(tx, 'CUSTOMER_WALLET', crypto.randomUUID());
      const accB = await makeAccount(tx, 'PLATFORM_CASH', 'PLATFORM');
      return postJournal(tx, {
        eventType: 'PAYMENT_CONFIRMED',
        eventId,
        actorId: null,
        currency: 'TMN',
        legs: [
          { accountId: accA.id, direction: 'DEBIT', amount: '1000' },
          { accountId: accB.id, direction: 'CREDIT', amount: '1000' },
        ],
      });
    });

    expect(result.idempotentReplay).toBe(false);
    expect(result.entries).toHaveLength(2);

    const journalRow = await prisma.journal.findUnique({ where: { id: result.journal.id } });
    expect(journalRow).not.toBeNull();
    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: result.journal.id } });
    expect(entryRows).toHaveLength(2);

    const debitTotal = entryRows
      .filter((e) => e.direction === 'DEBIT')
      .reduce((sum, e) => sum.plus(e.amount), new Prisma.Decimal(0));
    const creditTotal = entryRows
      .filter((e) => e.direction === 'CREDIT')
      .reduce((sum, e) => sum.plus(e.amount), new Prisma.Decimal(0));
    expect(debitTotal.equals(creditTotal)).toBe(true);
  });

  test('an unbalanced journal is rejected and nothing is committed', async () => {
    const eventId = crypto.randomUUID();

    await expect(withTx(async (tx) => {
      const accA = await makeAccount(tx, 'CUSTOMER_WALLET', crypto.randomUUID());
      const accB = await makeAccount(tx, 'PLATFORM_CASH', 'PLATFORM');
      return postJournal(tx, {
        eventType: 'PAYMENT_CONFIRMED',
        eventId,
        currency: 'TMN',
        legs: [
          { accountId: accA.id, direction: 'DEBIT', amount: '100' },
          { accountId: accB.id, direction: 'CREDIT', amount: '90' },
        ],
      });
    })).rejects.toMatchObject({ statusCode: 400 });

    const journalRow = await prisma.journal.findUnique({
      where: { eventType_eventId: { eventType: 'PAYMENT_CONFIRMED', eventId } },
    });
    expect(journalRow).toBeNull();
    // The whole $transaction (including both makeAccount calls) rolled
    // back with the thrown error, so no orphaned entries either — nothing
    // to look up by journalId since no Journal was ever committed.
  });

  test('posting the same (eventType, eventId) twice is idempotent: no duplicate Journal or entries', async () => {
    const eventId = crypto.randomUUID();
    createdEventIds.push(['SETTLEMENT', eventId]);

    const legsFor = (accA, accB) => ([
      { accountId: accA.id, direction: 'DEBIT', amount: '500' },
      { accountId: accB.id, direction: 'CREDIT', amount: '500' },
    ]);

    const first = await withTx(async (tx) => {
      const accA = await makeAccount(tx, 'CUSTOMER_WALLET', crypto.randomUUID());
      const accB = await makeAccount(tx, 'PLATFORM_CASH', 'PLATFORM');
      return postJournal(tx, {
        eventType: 'SETTLEMENT', eventId, currency: 'TMN', legs: legsFor(accA, accB),
      });
    });
    expect(first.idempotentReplay).toBe(false);

    const second = await withTx(async (tx) => {
      // Re-derive accountB (getOrCreateAccount is itself idempotent) rather
      // than reusing a JS reference across transactions; accountA's id is
      // read straight off the first call's persisted entries below.
      const accB = await makeAccount(tx, 'PLATFORM_CASH', 'PLATFORM');
      return postJournal(tx, {
        eventType: 'SETTLEMENT',
        eventId,
        currency: 'TMN',
        legs: [
          { accountId: first.entries[0].accountId, direction: 'DEBIT', amount: '500' },
          { accountId: accB.id, direction: 'CREDIT', amount: '500' },
        ],
      });
    });

    expect(second.idempotentReplay).toBe(true);
    expect(second.journal.id).toBe(first.journal.id);

    const journalRows = await prisma.journal.findMany({
      where: { eventType: 'SETTLEMENT', eventId },
    });
    expect(journalRows).toHaveLength(1);
    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: first.journal.id } });
    expect(entryRows).toHaveLength(2); // not 4
  });

  test('Decimal precision: large exact amounts across multiple legs, no float coercion', async () => {
    const eventId = crypto.randomUUID();
    createdEventIds.push(['SETTLEMENT', eventId]);

    const result = await withTx(async (tx) => {
      const accA = await makeAccount(tx, 'CUSTOMER_WALLET', crypto.randomUUID());
      const accB = await makeAccount(tx, 'PLATFORM_CASH', 'PLATFORM');
      // Three credit legs that a naive Number sum could mis-round; Decimal
      // must reconcile them exactly against the single debit leg.
      return postJournal(tx, {
        eventType: 'SETTLEMENT',
        eventId,
        currency: 'TMN',
        legs: [
          { accountId: accA.id, direction: 'DEBIT', amount: '999999999999' },
          { accountId: accB.id, direction: 'CREDIT', amount: '333333333333' },
          { accountId: accB.id, direction: 'CREDIT', amount: '333333333333' },
          { accountId: accB.id, direction: 'CREDIT', amount: '333333333333' },
        ],
      });
    });

    expect(result.entries).toHaveLength(4);
    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: result.journal.id } });
    const creditTotal = entryRows
      .filter((e) => e.direction === 'CREDIT')
      .reduce((sum, e) => sum.plus(e.amount), new Prisma.Decimal(0));
    const debitTotal = entryRows
      .filter((e) => e.direction === 'DEBIT')
      .reduce((sum, e) => sum.plus(e.amount), new Prisma.Decimal(0));
    expect(creditTotal.equals(new Prisma.Decimal('999999999999'))).toBe(true);
    expect(creditTotal.equals(debitTotal)).toBe(true);
  });
});
