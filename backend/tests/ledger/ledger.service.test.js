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
 * this posting service maintains) plus the seven event wrappers
 * implemented so far: postPaymentConfirmed, postSettlement,
 * postPayoutReserve / postPayoutRelease (P2.4 Phase 2 Step 4), postRefund
 * (P2.4 Phase 2 Step 5, no-shortfall path only), postPayoutProcessed
 * (P2.4 Phase 2 Step 7), and — added in P2.4 Phase 2 Step 10 —
 * postLiabilityRecovery. This step only tests the standalone Ledger
 * wrapper itself; postLiabilityRecovery is not yet wired into
 * payout-liabilities.service.js#recoverSellerLiabilities (deferred to a
 * future phase), so there is no business-flow coverage for that wiring
 * here.
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
const {
  getOrCreateAccount, postJournal, postPaymentConfirmed, postSettlement, postPayoutReserve, postPayoutRelease, postPayoutProcessed, postRefund, postLiabilityRecovery,
} = require('../../src/modules/ledger/ledger.service');
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

describe('postSettlement', () => {
  // PLATFORM_CASH and PLATFORM_REVENUE are platform-owned (shared with the
  // generic-engine / postPaymentConfirmed tests above), so track them for
  // cleanup the same way trackPlatformAccounts() does there. SELLER_WALLET
  // is per-seller — tracked per test via its own sellerId.
  async function trackAccounts(sellerId, currency = 'TMN') {
    const cash = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'PLATFORM_CASH', ownerId: PLATFORM_LEDGER_OWNER_ID, currency } },
    });
    const revenue = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'PLATFORM_REVENUE', ownerId: PLATFORM_LEDGER_OWNER_ID, currency } },
    });
    const seller = sellerId ? await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'SELLER_WALLET', ownerId: sellerId, currency } },
    }) : null;
    if (cash) createdAccountIds.push(cash.id);
    if (revenue) createdAccountIds.push(revenue.id);
    if (seller) createdAccountIds.push(seller.id);
    return { cash, revenue, seller };
  }

  test('successful settlement: one Journal, 3 entries, correct eventType/eventId/accounts/directions/amounts', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['SETTLEMENT', eventId]);

    // gross = 10000, rate 10% -> commission = 1000, sellerEarning = 9000
    // (mirrors settleDeliveredOrder's own formula exactly).
    const result = await withTx((tx) => postSettlement(tx, {
      eventId, actorId: null, currency: 'TMN', sellerId, grossAmount: '10000', commissionAmount: '1000', sellerEarning: '9000',
    }));
    await trackAccounts(sellerId);

    expect(result.idempotentReplay).toBe(false);

    const journalRow = await prisma.journal.findUnique({ where: { id: result.journal.id } });
    expect(journalRow.eventType).toBe('SETTLEMENT');
    expect(journalRow.eventId).toBe(eventId);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(3);

    const debitEntry = entryRows.find((e) => e.direction === 'DEBIT');
    const creditEntries = entryRows.filter((e) => e.direction === 'CREDIT');
    expect(debitEntry.account.ownerType).toBe('PLATFORM_CASH');
    expect(debitEntry.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(new Prisma.Decimal(debitEntry.amount).equals(new Prisma.Decimal('10000'))).toBe(true);

    const revenueEntry = creditEntries.find((e) => e.account.ownerType === 'PLATFORM_REVENUE');
    const sellerEntry = creditEntries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    expect(revenueEntry).toBeDefined();
    expect(revenueEntry.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(new Prisma.Decimal(revenueEntry.amount).equals(new Prisma.Decimal('1000'))).toBe(true);
    expect(sellerEntry).toBeDefined();
    expect(sellerEntry.account.ownerId).toBe(sellerId);
    expect(new Prisma.Decimal(sellerEntry.amount).equals(new Prisma.Decimal('9000'))).toBe(true);
  });

  test('platform accounts are not duplicated across settlements; seller account is reused across the same seller\'s settlements', async () => {
    const sellerId = crypto.randomUUID();
    const firstEventId = crypto.randomUUID();
    const secondEventId = crypto.randomUUID();
    createdEventIds.push(['SETTLEMENT', firstEventId], ['SETTLEMENT', secondEventId]);

    await withTx((tx) => postSettlement(tx, {
      eventId: firstEventId, currency: 'TMN', sellerId, grossAmount: '2000', commissionAmount: '200', sellerEarning: '1800',
    }));
    const first = await trackAccounts(sellerId);

    await withTx((tx) => postSettlement(tx, {
      eventId: secondEventId, currency: 'TMN', sellerId, grossAmount: '3000', commissionAmount: '300', sellerEarning: '2700',
    }));
    const second = await trackAccounts(sellerId);

    expect(second.cash.id).toBe(first.cash.id);
    expect(second.revenue.id).toBe(first.revenue.id);
    expect(second.seller.id).toBe(first.seller.id);

    const sellerRows = await prisma.account.findMany({
      where: { ownerType: 'SELLER_WALLET', ownerId: sellerId, currency: 'TMN' },
    });
    expect(sellerRows).toHaveLength(1);
  });

  test('idempotent: same eventId twice leaves exactly one Journal, three entries, and does not double-apply balance', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['SETTLEMENT', eventId]);

    const args = {
      eventId, currency: 'TMN', sellerId, grossAmount: '5000', commissionAmount: '500', sellerEarning: '4500',
    };

    const first = await withTx((tx) => postSettlement(tx, args));
    const { cash, revenue, seller } = await trackAccounts(sellerId);
    expect(first.idempotentReplay).toBe(false);

    const balancesAfterFirst = {
      cash: (await prisma.account.findUnique({ where: { id: cash.id } })).balance,
      revenue: (await prisma.account.findUnique({ where: { id: revenue.id } })).balance,
      seller: (await prisma.account.findUnique({ where: { id: seller.id } })).balance,
    };

    const second = await withTx((tx) => postSettlement(tx, args));
    expect(second.idempotentReplay).toBe(true);
    expect(second.journal.id).toBe(first.journal.id);

    const journalRows = await prisma.journal.findMany({ where: { eventType: 'SETTLEMENT', eventId } });
    expect(journalRows).toHaveLength(1);
    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: first.journal.id } });
    expect(entryRows).toHaveLength(3); // not 6

    const balancesAfterSecond = {
      cash: (await prisma.account.findUnique({ where: { id: cash.id } })).balance,
      revenue: (await prisma.account.findUnique({ where: { id: revenue.id } })).balance,
      seller: (await prisma.account.findUnique({ where: { id: seller.id } })).balance,
    };
    expect(new Prisma.Decimal(balancesAfterSecond.cash).equals(new Prisma.Decimal(balancesAfterFirst.cash))).toBe(true);
    expect(new Prisma.Decimal(balancesAfterSecond.revenue).equals(new Prisma.Decimal(balancesAfterFirst.revenue))).toBe(true);
    expect(new Prisma.Decimal(balancesAfterSecond.seller).equals(new Prisma.Decimal(balancesAfterFirst.seller))).toBe(true);
  });

  test('preserves exact Decimal precision for large settlement amounts', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['SETTLEMENT', eventId]);

    // gross = 999999999999, commission (10%) = 99999999999, seller = 900000000000
    const result = await withTx((tx) => postSettlement(tx, {
      eventId,
      currency: 'TMN',
      sellerId,
      grossAmount: '999999999999',
      commissionAmount: '99999999999',
      sellerEarning: '900000000000',
    }));
    await trackAccounts(sellerId);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    const debit = entryRows.find((e) => e.direction === 'DEBIT');
    const revenue = entryRows.find((e) => e.account.ownerType === 'PLATFORM_REVENUE');
    const seller = entryRows.find((e) => e.account.ownerType === 'SELLER_WALLET');
    expect(new Prisma.Decimal(debit.amount).equals(new Prisma.Decimal('999999999999'))).toBe(true);
    expect(new Prisma.Decimal(revenue.amount).equals(new Prisma.Decimal('99999999999'))).toBe(true);
    expect(new Prisma.Decimal(seller.amount).equals(new Prisma.Decimal('900000000000'))).toBe(true);
  });

  test('an inconsistent split (gross !== commission + sellerEarning) is rejected, not silently posted unbalanced', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();

    // gross 10000 but commission(1000) + sellerEarning(8000) = 9000 != 10000
    await expect(withTx((tx) => postSettlement(tx, {
      eventId, currency: 'TMN', sellerId, grossAmount: '10000', commissionAmount: '1000', sellerEarning: '8000',
    }))).rejects.toMatchObject({ statusCode: 400 });

    const journalRow = await prisma.journal.findUnique({
      where: { eventType_eventId: { eventType: 'SETTLEMENT', eventId } },
    });
    expect(journalRow).toBeNull();
    await trackAccounts(sellerId); // still track for cleanup — accounts may have been created before the rejection
  });

  test('0% commission omits the PLATFORM_REVENUE leg but still posts a balanced 2-leg journal', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['SETTLEMENT', eventId]);

    const result = await withTx((tx) => postSettlement(tx, {
      eventId, currency: 'TMN', sellerId, grossAmount: '4000', commissionAmount: '0', sellerEarning: '4000',
    }));
    await trackAccounts(sellerId);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(2);
    expect(entryRows.some((e) => e.account.ownerType === 'PLATFORM_REVENUE')).toBe(false);
    expect(entryRows.some((e) => e.account.ownerType === 'SELLER_WALLET')).toBe(true);
  });
});

describe('postPayoutReserve', () => {
  // PAYOUT_CLEARING is platform-owned (shared across every reserve/release
  // in this suite); SELLER_WALLET is per-seller — tracked per test via its
  // own sellerId, same convention as postSettlement's trackAccounts above.
  async function trackAccounts(sellerId, currency = 'TMN') {
    const clearing = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'PAYOUT_CLEARING', ownerId: PLATFORM_LEDGER_OWNER_ID, currency } },
    });
    const seller = sellerId ? await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'SELLER_WALLET', ownerId: sellerId, currency } },
    }) : null;
    if (clearing) createdAccountIds.push(clearing.id);
    if (seller) createdAccountIds.push(seller.id);
    return { clearing, seller };
  }

  test('successful reserve: one Journal, 2 entries, correct eventType/eventId/accounts/directions/amount', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RESERVE', eventId]);

    const result = await withTx((tx) => postPayoutReserve(tx, {
      eventId, actorId: null, currency: 'TMN', sellerId, amount: '5000',
    }));
    await trackAccounts(sellerId);

    expect(result.idempotentReplay).toBe(false);

    const journalRow = await prisma.journal.findUnique({ where: { id: result.journal.id } });
    expect(journalRow.eventType).toBe('PAYOUT_RESERVE');
    expect(journalRow.eventId).toBe(eventId);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(2);

    const debitEntry = entryRows.find((e) => e.direction === 'DEBIT');
    const creditEntry = entryRows.find((e) => e.direction === 'CREDIT');
    expect(debitEntry.account.ownerType).toBe('SELLER_WALLET');
    expect(debitEntry.account.ownerId).toBe(sellerId);
    expect(creditEntry.account.ownerType).toBe('PAYOUT_CLEARING');
    expect(creditEntry.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(new Prisma.Decimal(debitEntry.amount).equals(new Prisma.Decimal('5000'))).toBe(true);
    expect(new Prisma.Decimal(creditEntry.amount).equals(new Prisma.Decimal('5000'))).toBe(true);
  });

  test('PAYOUT_CLEARING is not duplicated across reserves; each seller\'s own SELLER_WALLET is reused', async () => {
    const sellerId = crypto.randomUUID();
    const firstEventId = crypto.randomUUID();
    const secondEventId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RESERVE', firstEventId], ['PAYOUT_RESERVE', secondEventId]);

    await withTx((tx) => postPayoutReserve(tx, {
      eventId: firstEventId, currency: 'TMN', sellerId, amount: '1000',
    }));
    const first = await trackAccounts(sellerId);

    await withTx((tx) => postPayoutReserve(tx, {
      eventId: secondEventId, currency: 'TMN', sellerId, amount: '2000',
    }));
    const second = await trackAccounts(sellerId);

    expect(second.clearing.id).toBe(first.clearing.id);
    expect(second.seller.id).toBe(first.seller.id);

    const clearingRows = await prisma.account.findMany({
      where: { ownerType: 'PAYOUT_CLEARING', ownerId: PLATFORM_LEDGER_OWNER_ID, currency: 'TMN' },
    });
    expect(clearingRows).toHaveLength(1);
  });

  test('idempotent: same eventId twice leaves exactly one Journal, two entries, and does not double-apply balance', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RESERVE', eventId]);

    const args = {
      eventId, currency: 'TMN', sellerId, amount: '3000',
    };

    const first = await withTx((tx) => postPayoutReserve(tx, args));
    const { clearing, seller } = await trackAccounts(sellerId);
    expect(first.idempotentReplay).toBe(false);

    const balancesAfterFirst = {
      clearing: (await prisma.account.findUnique({ where: { id: clearing.id } })).balance,
      seller: (await prisma.account.findUnique({ where: { id: seller.id } })).balance,
    };

    const second = await withTx((tx) => postPayoutReserve(tx, args));
    expect(second.idempotentReplay).toBe(true);
    expect(second.journal.id).toBe(first.journal.id);

    const journalRows = await prisma.journal.findMany({ where: { eventType: 'PAYOUT_RESERVE', eventId } });
    expect(journalRows).toHaveLength(1);
    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: first.journal.id } });
    expect(entryRows).toHaveLength(2); // not 4

    const balancesAfterSecond = {
      clearing: (await prisma.account.findUnique({ where: { id: clearing.id } })).balance,
      seller: (await prisma.account.findUnique({ where: { id: seller.id } })).balance,
    };
    expect(new Prisma.Decimal(balancesAfterSecond.clearing).equals(new Prisma.Decimal(balancesAfterFirst.clearing))).toBe(true);
    expect(new Prisma.Decimal(balancesAfterSecond.seller).equals(new Prisma.Decimal(balancesAfterFirst.seller))).toBe(true);
  });

  test('preserves exact Decimal precision for large reserve amounts', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RESERVE', eventId]);

    const result = await withTx((tx) => postPayoutReserve(tx, {
      eventId, currency: 'TMN', sellerId, amount: '999999999999',
    }));
    await trackAccounts(sellerId);

    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: result.journal.id } });
    entryRows.forEach((entry) => {
      expect(new Prisma.Decimal(entry.amount).equals(new Prisma.Decimal('999999999999'))).toBe(true);
    });
  });

  test('reserve moves the cached balance: SELLER_WALLET decreases, PAYOUT_CLEARING increases by the same amount', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RESERVE', eventId]);

    // PAYOUT_CLEARING is a platform-wide singleton shared with every other
    // test in this describe block (and with postPayoutRelease/
    // postPayoutProcessed below), so — same reasoning/pattern as
    // postPayoutProcessed's "processing moves the cached balance" test —
    // this asserts a relative delta (before -> after) rather than an
    // absolute balance. SELLER_WALLET is per-seller with a fresh
    // crypto.randomUUID() each test, so it legitimately starts at 0 and an
    // absolute assertion is fine for it.
    const { clearing: clearingBeforeAccount } = await trackAccounts(sellerId);
    const clearingBefore = clearingBeforeAccount
      ? new Prisma.Decimal((await prisma.account.findUnique({ where: { id: clearingBeforeAccount.id } })).balance)
      : new Prisma.Decimal(0);

    await withTx((tx) => postPayoutReserve(tx, {
      eventId, currency: 'TMN', sellerId, amount: '1200',
    }));
    const { clearing, seller } = await trackAccounts(sellerId);

    const refreshedClearing = await prisma.account.findUnique({ where: { id: clearing.id } });
    const refreshedSeller = await prisma.account.findUnique({ where: { id: seller.id } });
    expect(new Prisma.Decimal(refreshedSeller.balance).equals(new Prisma.Decimal('-1200'))).toBe(true);
    expect(new Prisma.Decimal(refreshedClearing.balance).equals(clearingBefore.plus('1200'))).toBe(true);
  });
});

describe('postPayoutRelease', () => {
  // Same platform/seller account-tracking convention as postPayoutReserve
  // above.
  async function trackAccounts(sellerId, currency = 'TMN') {
    const clearing = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'PAYOUT_CLEARING', ownerId: PLATFORM_LEDGER_OWNER_ID, currency } },
    });
    const seller = sellerId ? await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'SELLER_WALLET', ownerId: sellerId, currency } },
    }) : null;
    if (clearing) createdAccountIds.push(clearing.id);
    if (seller) createdAccountIds.push(seller.id);
    return { clearing, seller };
  }

  test('successful release: one Journal, 2 entries, correct eventType/eventId/accounts/directions/amount', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RELEASE', eventId]);

    const result = await withTx((tx) => postPayoutRelease(tx, {
      eventId, actorId: null, currency: 'TMN', sellerId, amount: '4000',
    }));
    await trackAccounts(sellerId);

    expect(result.idempotentReplay).toBe(false);

    const journalRow = await prisma.journal.findUnique({ where: { id: result.journal.id } });
    expect(journalRow.eventType).toBe('PAYOUT_RELEASE');
    expect(journalRow.eventId).toBe(eventId);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(2);

    const debitEntry = entryRows.find((e) => e.direction === 'DEBIT');
    const creditEntry = entryRows.find((e) => e.direction === 'CREDIT');
    expect(debitEntry.account.ownerType).toBe('PAYOUT_CLEARING');
    expect(debitEntry.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(creditEntry.account.ownerType).toBe('SELLER_WALLET');
    expect(creditEntry.account.ownerId).toBe(sellerId);
    expect(new Prisma.Decimal(debitEntry.amount).equals(new Prisma.Decimal('4000'))).toBe(true);
    expect(new Prisma.Decimal(creditEntry.amount).equals(new Prisma.Decimal('4000'))).toBe(true);
  });

  test('PAYOUT_CLEARING is not duplicated across releases; each seller\'s own SELLER_WALLET is reused', async () => {
    const sellerId = crypto.randomUUID();
    const firstEventId = crypto.randomUUID();
    const secondEventId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RELEASE', firstEventId], ['PAYOUT_RELEASE', secondEventId]);

    await withTx((tx) => postPayoutRelease(tx, {
      eventId: firstEventId, currency: 'TMN', sellerId, amount: '600',
    }));
    const first = await trackAccounts(sellerId);

    await withTx((tx) => postPayoutRelease(tx, {
      eventId: secondEventId, currency: 'TMN', sellerId, amount: '900',
    }));
    const second = await trackAccounts(sellerId);

    expect(second.clearing.id).toBe(first.clearing.id);
    expect(second.seller.id).toBe(first.seller.id);

    const clearingRows = await prisma.account.findMany({
      where: { ownerType: 'PAYOUT_CLEARING', ownerId: PLATFORM_LEDGER_OWNER_ID, currency: 'TMN' },
    });
    expect(clearingRows).toHaveLength(1);
  });

  test('idempotent: same eventId twice leaves exactly one Journal, two entries, and does not double-apply balance', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RELEASE', eventId]);

    const args = {
      eventId, currency: 'TMN', sellerId, amount: '2500',
    };

    const first = await withTx((tx) => postPayoutRelease(tx, args));
    const { clearing, seller } = await trackAccounts(sellerId);
    expect(first.idempotentReplay).toBe(false);

    const balancesAfterFirst = {
      clearing: (await prisma.account.findUnique({ where: { id: clearing.id } })).balance,
      seller: (await prisma.account.findUnique({ where: { id: seller.id } })).balance,
    };

    const second = await withTx((tx) => postPayoutRelease(tx, args));
    expect(second.idempotentReplay).toBe(true);
    expect(second.journal.id).toBe(first.journal.id);

    const journalRows = await prisma.journal.findMany({ where: { eventType: 'PAYOUT_RELEASE', eventId } });
    expect(journalRows).toHaveLength(1);
    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: first.journal.id } });
    expect(entryRows).toHaveLength(2); // not 4

    const balancesAfterSecond = {
      clearing: (await prisma.account.findUnique({ where: { id: clearing.id } })).balance,
      seller: (await prisma.account.findUnique({ where: { id: seller.id } })).balance,
    };
    expect(new Prisma.Decimal(balancesAfterSecond.clearing).equals(new Prisma.Decimal(balancesAfterFirst.clearing))).toBe(true);
    expect(new Prisma.Decimal(balancesAfterSecond.seller).equals(new Prisma.Decimal(balancesAfterFirst.seller))).toBe(true);
  });

  test('preserves exact Decimal precision for large release amounts', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RELEASE', eventId]);

    const result = await withTx((tx) => postPayoutRelease(tx, {
      eventId, currency: 'TMN', sellerId, amount: '999999999999',
    }));
    await trackAccounts(sellerId);

    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: result.journal.id } });
    entryRows.forEach((entry) => {
      expect(new Prisma.Decimal(entry.amount).equals(new Prisma.Decimal('999999999999'))).toBe(true);
    });
  });

  test('release moves the cached balance: PAYOUT_CLEARING decreases, SELLER_WALLET increases by the same amount', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RELEASE', eventId]);

    // PAYOUT_CLEARING is a platform-wide singleton shared with every other
    // test in this file that touches it (postPayoutReserve above,
    // postPayoutProcessed below), so — same delta pattern as
    // postPayoutProcessed's "processing moves the cached balance" test —
    // this asserts relative to its balance immediately before this test's
    // own posting, not an absolute value. SELLER_WALLET is per-seller with
    // a fresh crypto.randomUUID() each test and legitimately starts at 0.
    const { clearing: clearingBeforeAccount } = await trackAccounts(sellerId);
    const clearingBefore = clearingBeforeAccount
      ? new Prisma.Decimal((await prisma.account.findUnique({ where: { id: clearingBeforeAccount.id } })).balance)
      : new Prisma.Decimal(0);

    await withTx((tx) => postPayoutRelease(tx, {
      eventId, currency: 'TMN', sellerId, amount: '800',
    }));
    const { clearing, seller } = await trackAccounts(sellerId);

    const refreshedClearing = await prisma.account.findUnique({ where: { id: clearing.id } });
    const refreshedSeller = await prisma.account.findUnique({ where: { id: seller.id } });
    expect(new Prisma.Decimal(refreshedClearing.balance).equals(clearingBefore.minus('800'))).toBe(true);
    expect(new Prisma.Decimal(refreshedSeller.balance).equals(new Prisma.Decimal('800'))).toBe(true);
  });

  test('a full reserve-then-release round trip nets both accounts back to zero', async () => {
    const sellerId = crypto.randomUUID();
    const reserveEventId = crypto.randomUUID();
    const releaseEventId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RESERVE', reserveEventId], ['PAYOUT_RELEASE', releaseEventId]);

    // PAYOUT_CLEARING is a platform-wide singleton shared with every other
    // test in this file that touches it, so — same delta pattern as
    // postPayoutProcessed's "a full reserve-then-processed flow returns
    // PAYOUT_CLEARING to its balance before the reserve" test — a full
    // reserve+release round trip on the SAME amount must return it to
    // whatever it was immediately before this test, not to literal 0.
    // SELLER_WALLET is per-seller with a fresh crypto.randomUUID() each
    // test, so a literal 0 is correct for it (starts at 0, nets to 0).
    const { clearing: clearingBeforeAccount } = await trackAccounts(sellerId);
    const clearingBefore = clearingBeforeAccount
      ? new Prisma.Decimal((await prisma.account.findUnique({ where: { id: clearingBeforeAccount.id } })).balance)
      : new Prisma.Decimal(0);

    await withTx((tx) => postPayoutReserve(tx, {
      eventId: reserveEventId, currency: 'TMN', sellerId, amount: '3300',
    }));
    await withTx((tx) => postPayoutRelease(tx, {
      eventId: releaseEventId, currency: 'TMN', sellerId, amount: '3300',
    }));
    const { clearing, seller } = await trackAccounts(sellerId);

    const refreshedClearing = await prisma.account.findUnique({ where: { id: clearing.id } });
    const refreshedSeller = await prisma.account.findUnique({ where: { id: seller.id } });
    expect(new Prisma.Decimal(refreshedClearing.balance).equals(clearingBefore)).toBe(true);
    expect(new Prisma.Decimal(refreshedSeller.balance).equals(new Prisma.Decimal('0'))).toBe(true);
  });
});

describe('postPayoutProcessed', () => {
  // Both legs are platform-owned (PAYOUT_CLEARING and PLATFORM_CASH), so —
  // unlike postPayoutReserve/postPayoutRelease's trackAccounts — there is
  // no per-seller account to track here; sellerId is only used as a
  // wrapper input, never to resolve an account.
  async function trackAccounts(currency = 'TMN') {
    const clearing = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'PAYOUT_CLEARING', ownerId: PLATFORM_LEDGER_OWNER_ID, currency } },
    });
    const cash = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'PLATFORM_CASH', ownerId: PLATFORM_LEDGER_OWNER_ID, currency } },
    });
    if (clearing) createdAccountIds.push(clearing.id);
    if (cash) createdAccountIds.push(cash.id);
    return { clearing, cash };
  }

  test('successful posting: one Journal, 2 entries, correct eventType/eventId/accounts/directions/amount', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_PROCESSED', eventId]);

    const result = await withTx((tx) => postPayoutProcessed(tx, {
      eventId, actorId: null, currency: 'TMN', sellerId, amount: '7000',
    }));
    await trackAccounts();

    expect(result.idempotentReplay).toBe(false);

    const journalRow = await prisma.journal.findUnique({ where: { id: result.journal.id } });
    expect(journalRow.eventType).toBe('PAYOUT_PROCESSED');
    expect(journalRow.eventId).toBe(eventId);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(2);

    const debitEntry = entryRows.find((e) => e.direction === 'DEBIT');
    const creditEntry = entryRows.find((e) => e.direction === 'CREDIT');
    expect(debitEntry.account.ownerType).toBe('PAYOUT_CLEARING');
    expect(debitEntry.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(creditEntry.account.ownerType).toBe('PLATFORM_CASH');
    expect(creditEntry.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(new Prisma.Decimal(debitEntry.amount).equals(new Prisma.Decimal('7000'))).toBe(true);
    expect(new Prisma.Decimal(creditEntry.amount).equals(new Prisma.Decimal('7000'))).toBe(true);
  });

  test('PAYOUT_CLEARING and PLATFORM_CASH are not duplicated across multiple processed payouts', async () => {
    const firstEventId = crypto.randomUUID();
    const secondEventId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_PROCESSED', firstEventId], ['PAYOUT_PROCESSED', secondEventId]);

    await withTx((tx) => postPayoutProcessed(tx, {
      eventId: firstEventId, currency: 'TMN', sellerId: crypto.randomUUID(), amount: '1500',
    }));
    const first = await trackAccounts();

    await withTx((tx) => postPayoutProcessed(tx, {
      eventId: secondEventId, currency: 'TMN', sellerId: crypto.randomUUID(), amount: '2500',
    }));
    const second = await trackAccounts();

    expect(second.clearing.id).toBe(first.clearing.id);
    expect(second.cash.id).toBe(first.cash.id);

    const clearingRows = await prisma.account.findMany({
      where: { ownerType: 'PAYOUT_CLEARING', ownerId: PLATFORM_LEDGER_OWNER_ID, currency: 'TMN' },
    });
    expect(clearingRows).toHaveLength(1);
    const cashRows = await prisma.account.findMany({
      where: { ownerType: 'PLATFORM_CASH', ownerId: PLATFORM_LEDGER_OWNER_ID, currency: 'TMN' },
    });
    expect(cashRows).toHaveLength(1);
  });

  test('idempotent: same eventId twice leaves exactly one Journal, two entries, and does not double-apply balance', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_PROCESSED', eventId]);

    const args = {
      eventId, currency: 'TMN', sellerId, amount: '4200',
    };

    const first = await withTx((tx) => postPayoutProcessed(tx, args));
    const { clearing, cash } = await trackAccounts();
    expect(first.idempotentReplay).toBe(false);

    const balancesAfterFirst = {
      clearing: (await prisma.account.findUnique({ where: { id: clearing.id } })).balance,
      cash: (await prisma.account.findUnique({ where: { id: cash.id } })).balance,
    };

    const second = await withTx((tx) => postPayoutProcessed(tx, args));
    expect(second.idempotentReplay).toBe(true);
    expect(second.journal.id).toBe(first.journal.id);

    const journalRows = await prisma.journal.findMany({ where: { eventType: 'PAYOUT_PROCESSED', eventId } });
    expect(journalRows).toHaveLength(1);
    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: first.journal.id } });
    expect(entryRows).toHaveLength(2); // not 4

    const balancesAfterSecond = {
      clearing: (await prisma.account.findUnique({ where: { id: clearing.id } })).balance,
      cash: (await prisma.account.findUnique({ where: { id: cash.id } })).balance,
    };
    expect(new Prisma.Decimal(balancesAfterSecond.clearing).equals(new Prisma.Decimal(balancesAfterFirst.clearing))).toBe(true);
    expect(new Prisma.Decimal(balancesAfterSecond.cash).equals(new Prisma.Decimal(balancesAfterFirst.cash))).toBe(true);
  });

  test('preserves exact Decimal precision for large processed amounts', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_PROCESSED', eventId]);

    const result = await withTx((tx) => postPayoutProcessed(tx, {
      eventId, currency: 'TMN', sellerId, amount: '999999999999',
    }));
    await trackAccounts();

    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: result.journal.id } });
    entryRows.forEach((entry) => {
      expect(new Prisma.Decimal(entry.amount).equals(new Prisma.Decimal('999999999999'))).toBe(true);
    });
  });

  test('processing moves the cached balance: PAYOUT_CLEARING decreases, PLATFORM_CASH increases by the same amount', async () => {
    const eventId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_PROCESSED', eventId]);

    // PAYOUT_CLEARING/PLATFORM_CASH are platform-wide singletons shared
    // with the postPayoutReserve/postPayoutRelease suites above, so this
    // asserts a relative delta (before -> after) rather than an absolute
    // balance, same reasoning as the reserve-then-processed flow test below.
    const { clearing: clearingBeforeAccount, cash: cashBeforeAccount } = await trackAccounts();
    const clearingBefore = clearingBeforeAccount
      ? new Prisma.Decimal((await prisma.account.findUnique({ where: { id: clearingBeforeAccount.id } })).balance)
      : new Prisma.Decimal(0);
    const cashBefore = cashBeforeAccount
      ? new Prisma.Decimal((await prisma.account.findUnique({ where: { id: cashBeforeAccount.id } })).balance)
      : new Prisma.Decimal(0);

    await withTx((tx) => postPayoutProcessed(tx, {
      eventId, currency: 'TMN', sellerId, amount: '900',
    }));
    const { clearing, cash } = await trackAccounts();

    const refreshedClearing = await prisma.account.findUnique({ where: { id: clearing.id } });
    const refreshedCash = await prisma.account.findUnique({ where: { id: cash.id } });
    expect(new Prisma.Decimal(refreshedClearing.balance).equals(clearingBefore.minus('900'))).toBe(true);
    expect(new Prisma.Decimal(refreshedCash.balance).equals(cashBefore.plus('900'))).toBe(true);
  });

  test('a full reserve-then-processed flow returns PAYOUT_CLEARING to its balance before the reserve', async () => {
    const sellerId = crypto.randomUUID();
    const reserveEventId = crypto.randomUUID();
    const processedEventId = crypto.randomUUID();
    createdEventIds.push(['PAYOUT_RESERVE', reserveEventId], ['PAYOUT_PROCESSED', processedEventId]);

    const { clearing: clearingBeforeAccount } = await trackAccounts();
    const clearingBefore = clearingBeforeAccount
      ? new Prisma.Decimal((await prisma.account.findUnique({ where: { id: clearingBeforeAccount.id } })).balance)
      : new Prisma.Decimal(0);

    await withTx((tx) => postPayoutReserve(tx, {
      eventId: reserveEventId, currency: 'TMN', sellerId, amount: '5500',
    }));
    await withTx((tx) => postPayoutProcessed(tx, {
      eventId: processedEventId, currency: 'TMN', sellerId, amount: '5500',
    }));
    const { clearing } = await trackAccounts();

    const refreshedClearing = await prisma.account.findUnique({ where: { id: clearing.id } });
    expect(new Prisma.Decimal(refreshedClearing.balance).equals(clearingBefore)).toBe(true);
  });
});

describe('postRefund', () => {
  // CUSTOMER_WALLET is per-customer, SELLER_WALLET per-seller, and
  // PLATFORM_REVENUE is platform-owned (shared with the postSettlement
  // tests above) — track each the same targeted way trackAccounts() does
  // there, so afterAll's cleanup only removes rows this suite created.
  async function trackAccounts(customerId, sellerIds = [], currency = 'TMN') {
    const customer = customerId ? await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'CUSTOMER_WALLET', ownerId: customerId, currency } },
    }) : null;
    const revenue = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'PLATFORM_REVENUE', ownerId: PLATFORM_LEDGER_OWNER_ID, currency } },
    });
    const sellers = {};
    // eslint-disable-next-line no-restricted-syntax
    for (const sellerId of sellerIds) {
      // eslint-disable-next-line no-await-in-loop
      sellers[sellerId] = await prisma.account.findUnique({
        where: { ownerType_ownerId_currency: { ownerType: 'SELLER_WALLET', ownerId: sellerId, currency } },
      });
    }
    if (customer) createdAccountIds.push(customer.id);
    if (revenue) createdAccountIds.push(revenue.id);
    Object.values(sellers).forEach((s) => { if (s) createdAccountIds.push(s.id); });
    return { customer, revenue, sellers };
  }

  test('successful no-shortfall refund: one Journal, 3 entries, correct eventType/eventId/accounts/directions/amounts', async () => {
    const eventId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['REFUND', eventId]);

    // customerAmount 10000 = sellerRefund 9000 + commission 1000.
    const result = await withTx((tx) => postRefund(tx, {
      eventId,
      actorId: null,
      currency: 'TMN',
      customerId,
      customerAmount: '10000',
      sellerRefunds: [{ sellerId, amount: '9000' }],
      commissionAmount: '1000',
    }));
    await trackAccounts(customerId, [sellerId]);

    expect(result.idempotentReplay).toBe(false);

    const journalRow = await prisma.journal.findUnique({ where: { id: result.journal.id } });
    expect(journalRow.eventType).toBe('REFUND');
    expect(journalRow.eventId).toBe(eventId);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(3);

    const creditEntry = entryRows.find((e) => e.direction === 'CREDIT');
    const debitEntries = entryRows.filter((e) => e.direction === 'DEBIT');
    expect(creditEntry.account.ownerType).toBe('CUSTOMER_WALLET');
    expect(creditEntry.account.ownerId).toBe(customerId);
    expect(new Prisma.Decimal(creditEntry.amount).equals(new Prisma.Decimal('10000'))).toBe(true);

    const revenueEntry = debitEntries.find((e) => e.account.ownerType === 'PLATFORM_REVENUE');
    const sellerEntry = debitEntries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    expect(revenueEntry).toBeDefined();
    expect(revenueEntry.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(new Prisma.Decimal(revenueEntry.amount).equals(new Prisma.Decimal('1000'))).toBe(true);
    expect(sellerEntry).toBeDefined();
    expect(sellerEntry.account.ownerId).toBe(sellerId);
    expect(new Prisma.Decimal(sellerEntry.amount).equals(new Prisma.Decimal('9000'))).toBe(true);
  });

  test('multiple sellers: each gets its own SELLER_WALLET DEBIT leg', async () => {
    const eventId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    const sellerA = crypto.randomUUID();
    const sellerB = crypto.randomUUID();
    createdEventIds.push(['REFUND', eventId]);

    // customerAmount 10000 = sellerA 4000 + sellerB 5000 + commission 1000.
    const result = await withTx((tx) => postRefund(tx, {
      eventId,
      currency: 'TMN',
      customerId,
      customerAmount: '10000',
      sellerRefunds: [
        { sellerId: sellerA, amount: '4000' },
        { sellerId: sellerB, amount: '5000' },
      ],
      commissionAmount: '1000',
    }));
    await trackAccounts(customerId, [sellerA, sellerB]);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(4);

    const sellerEntryA = entryRows.find((e) => e.account.ownerType === 'SELLER_WALLET' && e.account.ownerId === sellerA);
    const sellerEntryB = entryRows.find((e) => e.account.ownerType === 'SELLER_WALLET' && e.account.ownerId === sellerB);
    expect(sellerEntryA).toBeDefined();
    expect(sellerEntryA.direction).toBe('DEBIT');
    expect(new Prisma.Decimal(sellerEntryA.amount).equals(new Prisma.Decimal('4000'))).toBe(true);
    expect(sellerEntryB).toBeDefined();
    expect(sellerEntryB.direction).toBe('DEBIT');
    expect(new Prisma.Decimal(sellerEntryB.amount).equals(new Prisma.Decimal('5000'))).toBe(true);
  });

  test('accounts are not duplicated across repeated refunds for the same customer/seller', async () => {
    const customerId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    const firstEventId = crypto.randomUUID();
    const secondEventId = crypto.randomUUID();
    createdEventIds.push(['REFUND', firstEventId], ['REFUND', secondEventId]);

    await withTx((tx) => postRefund(tx, {
      eventId: firstEventId, currency: 'TMN', customerId, customerAmount: '2000', sellerRefunds: [{ sellerId, amount: '1800' }], commissionAmount: '200',
    }));
    const first = await trackAccounts(customerId, [sellerId]);

    await withTx((tx) => postRefund(tx, {
      eventId: secondEventId, currency: 'TMN', customerId, customerAmount: '3000', sellerRefunds: [{ sellerId, amount: '2700' }], commissionAmount: '300',
    }));
    const second = await trackAccounts(customerId, [sellerId]);

    expect(second.customer.id).toBe(first.customer.id);
    expect(second.revenue.id).toBe(first.revenue.id);
    expect(second.sellers[sellerId].id).toBe(first.sellers[sellerId].id);

    const customerRows = await prisma.account.findMany({
      where: { ownerType: 'CUSTOMER_WALLET', ownerId: customerId, currency: 'TMN' },
    });
    expect(customerRows).toHaveLength(1);
  });

  test('idempotent: same eventId twice leaves exactly one Journal, three entries, and does not double-apply balance', async () => {
    const eventId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['REFUND', eventId]);

    const args = {
      eventId, currency: 'TMN', customerId, customerAmount: '5000', sellerRefunds: [{ sellerId, amount: '4500' }], commissionAmount: '500',
    };

    const first = await withTx((tx) => postRefund(tx, args));
    const { customer, revenue, sellers } = await trackAccounts(customerId, [sellerId]);
    expect(first.idempotentReplay).toBe(false);

    const balancesAfterFirst = {
      customer: (await prisma.account.findUnique({ where: { id: customer.id } })).balance,
      revenue: (await prisma.account.findUnique({ where: { id: revenue.id } })).balance,
      seller: (await prisma.account.findUnique({ where: { id: sellers[sellerId].id } })).balance,
    };

    const second = await withTx((tx) => postRefund(tx, args));
    expect(second.idempotentReplay).toBe(true);
    expect(second.journal.id).toBe(first.journal.id);

    const journalRows = await prisma.journal.findMany({ where: { eventType: 'REFUND', eventId } });
    expect(journalRows).toHaveLength(1);
    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: first.journal.id } });
    expect(entryRows).toHaveLength(3); // not 6

    const balancesAfterSecond = {
      customer: (await prisma.account.findUnique({ where: { id: customer.id } })).balance,
      revenue: (await prisma.account.findUnique({ where: { id: revenue.id } })).balance,
      seller: (await prisma.account.findUnique({ where: { id: sellers[sellerId].id } })).balance,
    };
    expect(new Prisma.Decimal(balancesAfterSecond.customer).equals(new Prisma.Decimal(balancesAfterFirst.customer))).toBe(true);
    expect(new Prisma.Decimal(balancesAfterSecond.revenue).equals(new Prisma.Decimal(balancesAfterFirst.revenue))).toBe(true);
    expect(new Prisma.Decimal(balancesAfterSecond.seller).equals(new Prisma.Decimal(balancesAfterFirst.seller))).toBe(true);
  });

  test('preserves exact Decimal precision for large refund amounts', async () => {
    const eventId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['REFUND', eventId]);

    // customerAmount 999999999999 = seller 900000000000 + commission 99999999999.
    const result = await withTx((tx) => postRefund(tx, {
      eventId,
      currency: 'TMN',
      customerId,
      customerAmount: '999999999999',
      sellerRefunds: [{ sellerId, amount: '900000000000' }],
      commissionAmount: '99999999999',
    }));
    await trackAccounts(customerId, [sellerId]);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    const customerEntry = entryRows.find((e) => e.account.ownerType === 'CUSTOMER_WALLET');
    const revenueEntry = entryRows.find((e) => e.account.ownerType === 'PLATFORM_REVENUE');
    const sellerEntry = entryRows.find((e) => e.account.ownerType === 'SELLER_WALLET');
    expect(new Prisma.Decimal(customerEntry.amount).equals(new Prisma.Decimal('999999999999'))).toBe(true);
    expect(new Prisma.Decimal(revenueEntry.amount).equals(new Prisma.Decimal('99999999999'))).toBe(true);
    expect(new Prisma.Decimal(sellerEntry.amount).equals(new Prisma.Decimal('900000000000'))).toBe(true);
  });

  test('an inconsistent split (customerAmount !== sum(sellerRefunds) + commission) is rejected, not silently posted unbalanced', async () => {
    const eventId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();

    // customerAmount 10000 but seller(9000) + commission(500) = 9500 != 10000.
    await expect(withTx((tx) => postRefund(tx, {
      eventId, currency: 'TMN', customerId, customerAmount: '10000', sellerRefunds: [{ sellerId, amount: '9000' }], commissionAmount: '500',
    }))).rejects.toMatchObject({ statusCode: 400 });

    const journalRow = await prisma.journal.findUnique({
      where: { eventType_eventId: { eventType: 'REFUND', eventId } },
    });
    expect(journalRow).toBeNull();
    await trackAccounts(customerId, [sellerId]); // still track for cleanup — accounts may have been created before the rejection
  });

  test('0% commission omits the PLATFORM_REVENUE leg but still posts a balanced 2-leg journal', async () => {
    const eventId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['REFUND', eventId]);

    const result = await withTx((tx) => postRefund(tx, {
      eventId, currency: 'TMN', customerId, customerAmount: '4000', sellerRefunds: [{ sellerId, amount: '4000' }], commissionAmount: '0',
    }));
    await trackAccounts(customerId, [sellerId]);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(2);
    expect(entryRows.some((e) => e.account.ownerType === 'PLATFORM_REVENUE')).toBe(false);
    expect(entryRows.some((e) => e.account.ownerType === 'SELLER_WALLET')).toBe(true);
  });

  test('100% commission omits the zero-value SELLER_WALLET leg but still posts a balanced 2-leg journal', async () => {
    const eventId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    const sellerId = crypto.randomUUID();
    createdEventIds.push(['REFUND', eventId]);

    const result = await withTx((tx) => postRefund(tx, {
      eventId, currency: 'TMN', customerId, customerAmount: '4000', sellerRefunds: [{ sellerId, amount: '0' }], commissionAmount: '4000',
    }));
    await trackAccounts(customerId, [sellerId]);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(2);
    expect(entryRows.some((e) => e.account.ownerType === 'SELLER_WALLET')).toBe(false);
    expect(entryRows.some((e) => e.account.ownerType === 'PLATFORM_REVENUE')).toBe(true);
  });
});

describe('postLiabilityRecovery', () => {
  async function trackAccounts(sellerId, currency = 'TMN') {
    const seller = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'SELLER_WALLET', ownerId: sellerId, currency } },
    });
    const cash = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'PLATFORM_CASH', ownerId: PLATFORM_LEDGER_OWNER_ID, currency } },
    });
    if (seller) createdAccountIds.push(seller.id);
    if (cash) createdAccountIds.push(cash.id);
    return { seller, cash };
  }

  test('successful posting: one Journal, 2 entries, correct eventType/eventId/accounts/directions/amount', async () => {
    const sellerId = crypto.randomUUID();
    const eventId = `${crypto.randomUUID()}:${crypto.randomUUID()}`; // ${orderItemSettlement.id}:${liability.id}
    createdEventIds.push(['LIABILITY_RECOVERY', eventId]);

    const result = await withTx((tx) => postLiabilityRecovery(tx, {
      eventId, actorId: null, currency: 'TMN', sellerId, amount: '3000',
    }));
    await trackAccounts(sellerId);

    expect(result.idempotentReplay).toBe(false);

    const journalRow = await prisma.journal.findUnique({ where: { id: result.journal.id } });
    expect(journalRow.eventType).toBe('LIABILITY_RECOVERY');
    expect(journalRow.eventId).toBe(eventId);

    const entryRows = await prisma.ledgerEntry.findMany({
      where: { journalId: result.journal.id },
      include: { account: true },
    });
    expect(entryRows).toHaveLength(2);

    const debitEntry = entryRows.find((e) => e.direction === 'DEBIT');
    const creditEntry = entryRows.find((e) => e.direction === 'CREDIT');
    expect(debitEntry.account.ownerType).toBe('SELLER_WALLET');
    expect(debitEntry.account.ownerId).toBe(sellerId);
    expect(creditEntry.account.ownerType).toBe('PLATFORM_CASH');
    expect(creditEntry.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(new Prisma.Decimal(debitEntry.amount).equals(new Prisma.Decimal('3000'))).toBe(true);
    expect(new Prisma.Decimal(creditEntry.amount).equals(new Prisma.Decimal('3000'))).toBe(true);
  });

  test('SELLER_WALLET and PLATFORM_CASH are not duplicated across multiple recoveries with different eventIds', async () => {
    const sellerId = crypto.randomUUID();
    const firstEventId = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
    const secondEventId = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
    createdEventIds.push(['LIABILITY_RECOVERY', firstEventId], ['LIABILITY_RECOVERY', secondEventId]);

    await withTx((tx) => postLiabilityRecovery(tx, {
      eventId: firstEventId, currency: 'TMN', sellerId, amount: '500',
    }));
    const first = await trackAccounts(sellerId);

    await withTx((tx) => postLiabilityRecovery(tx, {
      eventId: secondEventId, currency: 'TMN', sellerId, amount: '750',
    }));
    const second = await trackAccounts(sellerId);

    expect(second.seller.id).toBe(first.seller.id);
    expect(second.cash.id).toBe(first.cash.id);

    const sellerRows = await prisma.account.findMany({
      where: { ownerType: 'SELLER_WALLET', ownerId: sellerId, currency: 'TMN' },
    });
    expect(sellerRows).toHaveLength(1);
    const cashRows = await prisma.account.findMany({
      where: { ownerType: 'PLATFORM_CASH', ownerId: PLATFORM_LEDGER_OWNER_ID, currency: 'TMN' },
    });
    expect(cashRows).toHaveLength(1);
  });

  test('idempotent: same eventId twice leaves exactly one Journal, two entries, and does not double-apply balance', async () => {
    const sellerId = crypto.randomUUID();
    const eventId = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
    createdEventIds.push(['LIABILITY_RECOVERY', eventId]);

    const args = {
      eventId, currency: 'TMN', sellerId, amount: '1200',
    };

    const first = await withTx((tx) => postLiabilityRecovery(tx, args));
    const { seller, cash } = await trackAccounts(sellerId);
    expect(first.idempotentReplay).toBe(false);

    const balancesAfterFirst = {
      seller: (await prisma.account.findUnique({ where: { id: seller.id } })).balance,
      cash: (await prisma.account.findUnique({ where: { id: cash.id } })).balance,
    };

    const second = await withTx((tx) => postLiabilityRecovery(tx, args));
    expect(second.idempotentReplay).toBe(true);
    expect(second.journal.id).toBe(first.journal.id);

    const journalRows = await prisma.journal.findMany({ where: { eventType: 'LIABILITY_RECOVERY', eventId } });
    expect(journalRows).toHaveLength(1);
    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: first.journal.id } });
    expect(entryRows).toHaveLength(2); // not 4

    const balancesAfterSecond = {
      seller: (await prisma.account.findUnique({ where: { id: seller.id } })).balance,
      cash: (await prisma.account.findUnique({ where: { id: cash.id } })).balance,
    };
    expect(new Prisma.Decimal(balancesAfterSecond.seller).equals(new Prisma.Decimal(balancesAfterFirst.seller))).toBe(true);
    expect(new Prisma.Decimal(balancesAfterSecond.cash).equals(new Prisma.Decimal(balancesAfterFirst.cash))).toBe(true);
  });

  test('preserves exact Decimal precision for a high-precision recovered amount', async () => {
    const sellerId = crypto.randomUUID();
    const eventId = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
    createdEventIds.push(['LIABILITY_RECOVERY', eventId]);

    const result = await withTx((tx) => postLiabilityRecovery(tx, {
      eventId, currency: 'TMN', sellerId, amount: '123456789012',
    }));
    await trackAccounts(sellerId);

    const entryRows = await prisma.ledgerEntry.findMany({ where: { journalId: result.journal.id } });
    entryRows.forEach((entry) => {
      expect(new Prisma.Decimal(entry.amount).equals(new Prisma.Decimal('123456789012'))).toBe(true);
    });
  });

  test('recovery moves the cached balance: SELLER_WALLET decreases, PLATFORM_CASH increases by the same amount', async () => {
    const sellerId = crypto.randomUUID();
    const eventId = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
    createdEventIds.push(['LIABILITY_RECOVERY', eventId]);

    // PLATFORM_CASH is a platform-wide singleton shared with the other
    // suites above, so this asserts a relative delta (before -> after)
    // rather than an absolute balance, same reasoning as
    // postPayoutProcessed's balance-movement test.
    const { seller: sellerBeforeAccount, cash: cashBeforeAccount } = await trackAccounts(sellerId);
    const sellerBefore = sellerBeforeAccount
      ? new Prisma.Decimal((await prisma.account.findUnique({ where: { id: sellerBeforeAccount.id } })).balance)
      : new Prisma.Decimal(0);
    const cashBefore = cashBeforeAccount
      ? new Prisma.Decimal((await prisma.account.findUnique({ where: { id: cashBeforeAccount.id } })).balance)
      : new Prisma.Decimal(0);

    await withTx((tx) => postLiabilityRecovery(tx, {
      eventId, currency: 'TMN', sellerId, amount: '600',
    }));
    const { seller, cash } = await trackAccounts(sellerId);

    const refreshedSeller = await prisma.account.findUnique({ where: { id: seller.id } });
    const refreshedCash = await prisma.account.findUnique({ where: { id: cash.id } });
    expect(new Prisma.Decimal(refreshedSeller.balance).equals(sellerBefore.minus('600'))).toBe(true);
    expect(new Prisma.Decimal(refreshedCash.balance).equals(cashBefore.plus('600'))).toBe(true);
  });

  test('partial recovery semantics: the wrapper posts exactly the supplied recoveredAmount, not the full liability', async () => {
    const sellerId = crypto.randomUUID();
    // Simulates a larger outstanding SellerPayoutLiability (e.g. 10000)
    // being partially recovered across two settlements — this wrapper
    // never computes or looks up the liability total itself, it only
    // posts whatever amount it is given for this one occurrence.
    const liabilityId = crypto.randomUUID();
    const firstSettlementId = crypto.randomUUID();
    const secondSettlementId = crypto.randomUUID();
    const firstEventId = `${firstSettlementId}:${liabilityId}`;
    const secondEventId = `${secondSettlementId}:${liabilityId}`;
    createdEventIds.push(['LIABILITY_RECOVERY', firstEventId], ['LIABILITY_RECOVERY', secondEventId]);

    const firstResult = await withTx((tx) => postLiabilityRecovery(tx, {
      eventId: firstEventId, currency: 'TMN', sellerId, amount: '4000',
    }));
    const secondResult = await withTx((tx) => postLiabilityRecovery(tx, {
      eventId: secondEventId, currency: 'TMN', sellerId, amount: '6000',
    }));
    await trackAccounts(sellerId);

    const firstEntries = await prisma.ledgerEntry.findMany({ where: { journalId: firstResult.journal.id } });
    const secondEntries = await prisma.ledgerEntry.findMany({ where: { journalId: secondResult.journal.id } });

    firstEntries.forEach((entry) => {
      expect(new Prisma.Decimal(entry.amount).equals(new Prisma.Decimal('4000'))).toBe(true);
    });
    secondEntries.forEach((entry) => {
      expect(new Prisma.Decimal(entry.amount).equals(new Prisma.Decimal('6000'))).toBe(true);
    });
    // Two distinct Journals — one per (settlement, liability) occurrence —
    // sharing the same liabilityId but not the same eventId.
    expect(firstResult.journal.id).not.toBe(secondResult.journal.id);
  });
});
