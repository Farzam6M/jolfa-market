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
 * These tests exercise the two generic primitives (getOrCreateAccount and
 * postJournal: leg balance validation, idempotency, and — per
 * schema.prisma's Account.balance doc — the cached per-account balance
 * this posting service maintains) plus the one event wrapper implemented
 * so far, postPaymentConfirmed. The other six wrappers (postSettlement,
 * postRefund, postPayoutReserve, postPayoutRelease, postPayoutProcessed,
 * postLiabilityRecovery) are not implemented yet — see the P2.4 Phase 2
 * report — so there is no coverage for them here.
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
const { getOrCreateAccount, postJournal, postPaymentConfirmed } = require('../../src/modules/ledger/ledger.service');
const { PLATFORM_LEDGER_OWNER_ID } = require('../../src/modules/ledger/ledger.constants');

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

  test('posting a journal updates each leg account\'s cached balance (CREDIT +, DEBIT -)', async () => {
    const eventId = crypto.randomUUID();
    createdEventIds.push(['PAYMENT_CONFIRMED', eventId]);

    const { accA, accB } = await withTx(async (tx) => {
      const a = await makeAccount(tx, 'CUSTOMER_WALLET', crypto.randomUUID());
      const b = await makeAccount(tx, 'PLATFORM_CASH', crypto.randomUUID());
      await postJournal(tx, {
        eventType: 'PAYMENT_CONFIRMED',
        eventId,
        currency: 'TMN',
        legs: [
          { accountId: a.id, direction: 'DEBIT', amount: '400' },
          { accountId: b.id, direction: 'CREDIT', amount: '400' },
        ],
      });
      return { accA: a, accB: b };
    });

    const refreshedA = await prisma.account.findUnique({ where: { id: accA.id } });
    const refreshedB = await prisma.account.findUnique({ where: { id: accB.id } });
    expect(new Prisma.Decimal(refreshedA.balance).equals(new Prisma.Decimal('-400'))).toBe(true);
    expect(new Prisma.Decimal(refreshedB.balance).equals(new Prisma.Decimal('400'))).toBe(true);
  });

  test('idempotent replay does not re-apply the balance update a second time', async () => {
    const eventId = crypto.randomUUID();
    createdEventIds.push(['SETTLEMENT', eventId]);

    const { accA, accB } = await withTx(async (tx) => {
      const a = await makeAccount(tx, 'CUSTOMER_WALLET', crypto.randomUUID());
      const b = await makeAccount(tx, 'PLATFORM_CASH', crypto.randomUUID());
      await postJournal(tx, {
        eventType: 'SETTLEMENT',
        eventId,
        currency: 'TMN',
        legs: [
          { accountId: a.id, direction: 'DEBIT', amount: '250' },
          { accountId: b.id, direction: 'CREDIT', amount: '250' },
        ],
      });
      return { accA: a, accB: b };
    });

    // Replay with the same (eventType, eventId) — postJournal short-circuits
    // to the idempotent-replay path before touching any Account row.
    const replay = await withTx((tx) => postJournal(tx, {
      eventType: 'SETTLEMENT',
      eventId,
      currency: 'TMN',
      legs: [
        { accountId: accA.id, direction: 'DEBIT', amount: '250' },
        { accountId: accB.id, direction: 'CREDIT', amount: '250' },
      ],
    }));
    expect(replay.idempotentReplay).toBe(true);

    const refreshedA = await prisma.account.findUnique({ where: { id: accA.id } });
    const refreshedB = await prisma.account.findUnique({ where: { id: accB.id } });
    expect(new Prisma.Decimal(refreshedA.balance).equals(new Prisma.Decimal('-250'))).toBe(true);
    expect(new Prisma.Decimal(refreshedB.balance).equals(new Prisma.Decimal('250'))).toBe(true);
  });

  test('an unbalanced journal leaves every account balance untouched', async () => {
    const { accA, accB } = await withTx(async (tx) => {
      const a = await makeAccount(tx, 'CUSTOMER_WALLET', crypto.randomUUID());
      const b = await makeAccount(tx, 'PLATFORM_CASH', crypto.randomUUID());
      return { accA: a, accB: b };
    });

    await expect(withTx((tx) => postJournal(tx, {
      eventType: 'PAYMENT_CONFIRMED',
      eventId: crypto.randomUUID(),
      currency: 'TMN',
      legs: [
        { accountId: accA.id, direction: 'DEBIT', amount: '100' },
        { accountId: accB.id, direction: 'CREDIT', amount: '90' },
      ],
    }))).rejects.toMatchObject({ statusCode: 400 });

    const refreshedA = await prisma.account.findUnique({ where: { id: accA.id } });
    const refreshedB = await prisma.account.findUnique({ where: { id: accB.id } });
    expect(new Prisma.Decimal(refreshedA.balance).equals(new Prisma.Decimal('0'))).toBe(true);
    expect(new Prisma.Decimal(refreshedB.balance).equals(new Prisma.Decimal('0'))).toBe(true);
  });
});

describe('postPaymentConfirmed', () => {
  // PAYMENT_GATEWAY_CLEARING and PLATFORM_CASH are both platform-owned
  // (ownerId = PLATFORM_LEDGER_OWNER_ID) — track them for cleanup the same
  // way makeAccount does for the generic-engine tests above, since
  // postPaymentConfirmed creates/reuses them internally rather than via
  // the makeAccount test helper.
  async function trackPlatformAccounts(currency = 'TMN') {
    const clearing = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'PAYMENT_GATEWAY_CLEARING', ownerId: PLATFORM_LEDGER_OWNER_ID, currency } },
    });
    const cash = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'PLATFORM_CASH', ownerId: PLATFORM_LEDGER_OWNER_ID, currency } },
    });
    if (clearing) createdAccountIds.push(clearing.id);
    if (cash) createdAccountIds.push(cash.id);
    return { clearing, cash };
  }

  test('successful posting: one Journal, two correctly-directed LedgerEntry rows, correct eventType/accounts/amount', async () => {
    const eventId = crypto.randomUUID();
    createdEventIds.push(['PAYMENT_CONFIRMED', eventId]);

    const result = await withTx((tx) => postPaymentConfirmed(tx, {
      eventId, actorId: null, currency: 'TMN', amount: '1500',
    }));
    await trackPlatformAccounts();

    expect(result.idempotentReplay).toBe(false);
    expect(result.entries).toHaveLength(1 * 2);

    const journalRow = await prisma.journal.findUnique({ where: { id: result.journal.id } });
    expect(journalRow.eventType).toBe('PAYMENT_CONFIRMED');
    expect(journalRow.eventId).toBe(eventId);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(2);

    const debitEntry = entryRows.find((e) => e.direction === 'DEBIT');
    const creditEntry = entryRows.find((e) => e.direction === 'CREDIT');
    expect(debitEntry.account.ownerType).toBe('PAYMENT_GATEWAY_CLEARING');
    expect(debitEntry.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(creditEntry.account.ownerType).toBe('PLATFORM_CASH');
    expect(creditEntry.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(new Prisma.Decimal(debitEntry.amount).equals(new Prisma.Decimal('1500'))).toBe(true);
    expect(new Prisma.Decimal(creditEntry.amount).equals(new Prisma.Decimal('1500'))).toBe(true);
  });

  test('creates PAYMENT_GATEWAY_CLEARING and PLATFORM_CASH accounts on first use, reuses them on second use', async () => {
    const firstEventId = crypto.randomUUID();
    const secondEventId = crypto.randomUUID();
    createdEventIds.push(['PAYMENT_CONFIRMED', firstEventId], ['PAYMENT_CONFIRMED', secondEventId]);

    await withTx((tx) => postPaymentConfirmed(tx, {
      eventId: firstEventId, currency: 'TMN', amount: '200',
    }));
    const { clearing: clearingFirst, cash: cashFirst } = await trackPlatformAccounts();

    await withTx((tx) => postPaymentConfirmed(tx, {
      eventId: secondEventId, currency: 'TMN', amount: '300',
    }));
    const { clearing: clearingSecond, cash: cashSecond } = await trackPlatformAccounts();

    expect(clearingSecond.id).toBe(clearingFirst.id);
    expect(cashSecond.id).toBe(cashFirst.id);

    const clearingRows = await prisma.account.findMany({
      where: { ownerType: 'PAYMENT_GATEWAY_CLEARING', ownerId: PLATFORM_LEDGER_OWNER_ID, currency: 'TMN' },
    });
    const cashRows = await prisma.account.findMany({
      where: { ownerType: 'PLATFORM_CASH', ownerId: PLATFORM_LEDGER_OWNER_ID, currency: 'TMN' },
    });
    expect(clearingRows).toHaveLength(1);
    expect(cashRows).toHaveLength(1);
  });

  test('idempotent: same eventId does not create a second Journal, duplicate entries, or double-apply balance', async () => {
    const eventId = crypto.randomUUID();
    createdEventIds.push(['PAYMENT_CONFIRMED', eventId]);

    const first = await withTx((tx) => postPaymentConfirmed(tx, {
      eventId, currency: 'TMN', amount: '750',
    }));
    const { clearing, cash } = await trackPlatformAccounts();
    expect(first.idempotentReplay).toBe(false);

    const balanceAfterFirst = {
      clearing: (await prisma.account.findUnique({ where: { id: clearing.id } })).balance,
      cash: (await prisma.account.findUnique({ where: { id: cash.id } })).balance,
    };

    const second = await withTx((tx) => postPaymentConfirmed(tx, {
      eventId, currency: 'TMN', amount: '750',
    }));
    expect(second.idempotentReplay).toBe(true);
    expect(second.journal.id).toBe(first.journal.id);

    const journalRows = await prisma.journal.findMany({ where: { eventType: 'PAYMENT_CONFIRMED', eventId } });
    expect(journalRows).toHaveLength(1);
    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: first.journal.id } });
    expect(entryRows).toHaveLength(2); // not 4

    const balanceAfterSecond = {
      clearing: (await prisma.account.findUnique({ where: { id: clearing.id } })).balance,
      cash: (await prisma.account.findUnique({ where: { id: cash.id } })).balance,
    };
    expect(new Prisma.Decimal(balanceAfterSecond.clearing).equals(new Prisma.Decimal(balanceAfterFirst.clearing))).toBe(true);
    expect(new Prisma.Decimal(balanceAfterSecond.cash).equals(new Prisma.Decimal(balanceAfterFirst.cash))).toBe(true);
  });

  test('preserves exact Decimal precision for the supplied amount', async () => {
    const eventId = crypto.randomUUID();
    createdEventIds.push(['PAYMENT_CONFIRMED', eventId]);

    const result = await withTx((tx) => postPaymentConfirmed(tx, {
      eventId, currency: 'TMN', amount: '999999999999',
    }));
    await trackPlatformAccounts();

    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: result.journal.id } });
    entryRows.forEach((entry) => {
      expect(new Prisma.Decimal(entry.amount).equals(new Prisma.Decimal('999999999999'))).toBe(true);
    });
  });
});
