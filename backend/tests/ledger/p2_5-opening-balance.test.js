/**
 * Dedicated tests for P2.5 — Pre-Migration Ledger Compatibility
 * Verification (scripts/p2_5-opening-balance-migration.js).
 *
 * Scope note: this file exercises the two exported, directly-testable
 * pieces of the migration — classifyOwnerType (pure function) and
 * postOpeningBalanceForWallet (Phase B's per-account posting unit) —
 * against a real Postgres database and the real Ledger posting service
 * (getOrCreateAccount/postJournal/postOpeningBalance), the same way
 * ledger.service.test.js exercises the posting service directly: no HTTP
 * layer, no auth, real `prisma` calls and real transactions.
 *
 * It deliberately does NOT call runMigration() itself. Several locked
 * behaviors (zero-balance skip, negative-balance refusal, AMBIGUOUS skip,
 * NO_SIGNAL skip) live inline in runMigration's per-wallet loop, not in
 * postOpeningBalanceForWallet — exercising them would mean either running
 * the real migration end-to-end (against every Wallet row in the test
 * database, forbidden by the P2.5 task's test-execution policy) or
 * duplicating runMigration's loop logic inside the test (forbidden by the
 * "do not reimplement" instruction). Those behaviors are therefore left
 * as documented gaps below — see "Remaining Test Gaps" in the task report,
 * not silently assumed to be covered.
 *
 * postOpeningBalanceForWallet itself is exported for testing via a
 * minimal export-only change to the migration script's `module.exports`
 * (no other change to that file) — see p2_5-opening-balance-migration.js.
 *
 * Test fixtures create real User/Wallet/Store/Order rows (classification
 * signals are real Store/Order existence, not mockable), each with a
 * unique suffix so tests never collide with each other or with other
 * suites, and never depend on execution order. Cleanup in `afterAll`
 * removes only rows this file created — LedgerEntry/Journal/Account by
 * tracked id, Order by tracked id, User by tracked id (Wallet/Store cascade
 * from User deletion; Order does not, so it is deleted first) — the shared
 * PLATFORM_CASH account itself is never deleted, only reused (same
 * convention as ledger.service.test.js's own PLATFORM_CASH handling).
 *
 * Requires a real Postgres database (DATABASE_URL), migrated:
 *   NODE_ENV=test npx jest tests/ledger/p2_5-opening-balance.test.js --runInBand
 */
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../../src/config/database');
const { postJournal, getOrCreateAccount } = require('../../src/modules/ledger/ledger.service');
const { PLATFORM_LEDGER_OWNER_ID, LEDGER_CURRENCY } = require('../../src/modules/ledger/ledger.constants');
const {
  classifyOwnerType,
  postOpeningBalanceForWallet,
} = require('../../scripts/p2_5-opening-balance-migration');

let roles;

const createdUserIds = [];
const createdOrderIds = [];
const createdAccountIds = [];
const createdEventIds = []; // [eventType, eventId]

function uniqueSuffix() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function makeUser(roleKey) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      name: `P2.5 Test ${roleKey} ${suffix}`,
      mobile: `P25${suffix}`,
      passwordHash: 'not-used-in-this-suite',
      roleId: roles[roleKey].id,
      status: 'ACTIVE',
    },
  });
  createdUserIds.push(user.id);
  return user;
}

/** Real Wallet.balance seed, via the same by-hand upsert convention every other Ledger-adjacent test suite uses (see user-wallet-atomicity.test.js's doc comment). Wallet cascades from User deletion, so it is not tracked separately. */
async function makeWallet(userId, balance) {
  return prisma.wallet.upsert({
    where: { userId },
    update: { balance },
    create: { userId, balance },
  });
}

/** Real Store row so a seller has a provable hasStore signal. Cascades from User deletion (Store.seller relation is onDelete: Cascade), not tracked separately. */
async function makeStore(sellerId) {
  const suffix = uniqueSuffix();
  return prisma.store.create({
    data: {
      sellerId,
      name: `P2.5 Test Store ${suffix}`,
      slug: `p25-test-store-${suffix}`,
      status: 'APPROVED',
    },
  });
}

/** Real Order row so a customer has a provable hasCustomerOrder signal. Does NOT cascade from User deletion (Order.user has no onDelete: Cascade), so it is tracked and deleted before its User in afterAll. */
async function makeOrder(userId, total = '1000') {
  const order = await prisma.order.create({
    data: {
      orderNumber: `P25-${uniqueSuffix()}`,
      userId,
      status: 'DELIVERED',
      subtotal: total,
      shippingFee: '0',
      total,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

afterAll(async () => {
  // Children first (FK onDelete: Restrict on ledger_entries ->
  // journals/ledger_accounts), same convention as ledger.service.test.js.
  const journalWhere = { OR: createdEventIds.map(([eventType, eventId]) => ({ eventType, eventId })) };
  if (createdEventIds.length > 0) {
    const journals = await prisma.journal.findMany({ where: journalWhere, select: { id: true } });
    const journalIds = journals.map((j) => j.id);
    if (journalIds.length > 0) {
      await prisma.ledgerEntry.deleteMany({ where: { journalId: { in: journalIds } } });
    }
    await prisma.journal.deleteMany({ where: journalWhere });
  }
  if (createdAccountIds.length > 0) {
    // Never includes the shared PLATFORM_CASH account id — only the
    // per-test CUSTOMER_WALLET/SELLER_WALLET accounts this file created.
    await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  }
  if (createdOrderIds.length > 0) {
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (createdUserIds.length > 0) {
    // Cascades Wallet + Store.
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

beforeAll(async () => {
  const roleRows = await prisma.role.findMany();
  roles = Object.fromEntries(roleRows.map((r) => [r.key, r]));
  if (!roles.CUSTOMER || !roles.SELLER) {
    throw new Error('P2.5 tests require CUSTOMER and SELLER roles to be seeded (run prisma/seed.js)');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GROUP 1 — classifyOwnerType
// ─────────────────────────────────────────────────────────────────────────
describe('classifyOwnerType', () => {
  test('customer-only signal -> CUSTOMER_WALLET', () => {
    const userId = crypto.randomUUID();
    const sellerUserIds = new Set([crypto.randomUUID()]); // someone else
    const customerUserIds = new Set([userId]);
    expect(classifyOwnerType(userId, sellerUserIds, customerUserIds)).toBe('CUSTOMER_WALLET');
  });

  test('seller-only signal -> SELLER_WALLET', () => {
    const userId = crypto.randomUUID();
    const sellerUserIds = new Set([userId]);
    const customerUserIds = new Set([crypto.randomUUID()]); // someone else
    expect(classifyOwnerType(userId, sellerUserIds, customerUserIds)).toBe('SELLER_WALLET');
  });

  test('both signals -> AMBIGUOUS', () => {
    const userId = crypto.randomUUID();
    const sellerUserIds = new Set([userId]);
    const customerUserIds = new Set([userId]);
    expect(classifyOwnerType(userId, sellerUserIds, customerUserIds)).toBe('AMBIGUOUS');
  });

  test('neither signal -> NO_SIGNAL', () => {
    const userId = crypto.randomUUID();
    const sellerUserIds = new Set([crypto.randomUUID()]);
    const customerUserIds = new Set([crypto.randomUUID()]);
    expect(classifyOwnerType(userId, sellerUserIds, customerUserIds)).toBe('NO_SIGNAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GROUP 2 — postOpeningBalanceForWallet (posting layer)
// ─────────────────────────────────────────────────────────────────────────
describe('postOpeningBalanceForWallet — posting a fresh opening balance', () => {
  test('CUSTOMER_WALLET: real OPENING_BALANCE Journal, correct legs, correct Account.balance, Wallet.balance untouched', async () => {
    const customer = await makeUser('CUSTOMER');
    await makeOrder(customer.id); // real hasCustomerOrder signal, for fixture realism
    const seededWalletBalance = '15000';
    await makeWallet(customer.id, seededWalletBalance);
    const cutoverAt = new Date();
    const amount = new Prisma.Decimal('15000');

    const result = await postOpeningBalanceForWallet({
      userId: customer.id, ownerType: 'CUSTOMER_WALLET', amount, cutoverAt,
    });
    createdAccountIds.push(result.account.id);
    createdEventIds.push(['OPENING_BALANCE', `OPENING_BALANCE:${result.account.id}`]);

    expect(result.alreadyPosted).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.accountWasCreated).toBe(true);

    const account = await prisma.account.findUnique({ where: { id: result.account.id } });
    expect(account.ownerType).toBe('CUSTOMER_WALLET');
    expect(account.ownerId).toBe(customer.id);
    expect(account.currency).toBe(LEDGER_CURRENCY);
    expect(new Prisma.Decimal(account.balance).equals(amount)).toBe(true);

    const journal = await prisma.journal.findUnique({
      where: {
        eventType_eventId: { eventType: 'OPENING_BALANCE', eventId: `OPENING_BALANCE:${account.id}` },
      },
    });
    expect(journal).not.toBeNull();
    expect(journal.currency).toBe(LEDGER_CURRENCY);
    expect(journal.createdAt.toISOString()).toBe(cutoverAt.toISOString());

    const entries = await prisma.ledgerEntry.findMany({ where: { journalId: journal.id } });
    expect(entries).toHaveLength(2);
    const walletLeg = entries.find((e) => e.accountId === account.id);
    const cashLeg = entries.find((e) => e.accountId !== account.id);
    expect(walletLeg.direction).toBe('CREDIT');
    expect(new Prisma.Decimal(walletLeg.amount).equals(amount)).toBe(true);
    expect(cashLeg.direction).toBe('DEBIT');
    expect(new Prisma.Decimal(cashLeg.amount).equals(amount)).toBe(true);

    const cashAccount = await prisma.account.findUnique({ where: { id: cashLeg.accountId } });
    expect(cashAccount.ownerType).toBe('PLATFORM_CASH');
    expect(cashAccount.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);

    // Wallet.balance (the live operational source of truth) must remain
    // exactly as seeded — this posting only ever touches Ledger Account
    // rows, never the Wallet table.
    const wallet = await prisma.wallet.findUnique({ where: { userId: customer.id } });
    expect(new Prisma.Decimal(wallet.balance).equals(new Prisma.Decimal(seededWalletBalance))).toBe(true);
  });

  test('SELLER_WALLET: real OPENING_BALANCE Journal, correct legs, correct Account.balance, Wallet.balance untouched', async () => {
    const seller = await makeUser('SELLER');
    await makeStore(seller.id); // real hasStore signal, for fixture realism
    const seededWalletBalance = '42000';
    await makeWallet(seller.id, seededWalletBalance);
    const cutoverAt = new Date();
    const amount = new Prisma.Decimal('42000');

    const result = await postOpeningBalanceForWallet({
      userId: seller.id, ownerType: 'SELLER_WALLET', amount, cutoverAt,
    });
    createdAccountIds.push(result.account.id);
    createdEventIds.push(['OPENING_BALANCE', `OPENING_BALANCE:${result.account.id}`]);

    expect(result.alreadyPosted).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.accountWasCreated).toBe(true);

    const account = await prisma.account.findUnique({ where: { id: result.account.id } });
    expect(account.ownerType).toBe('SELLER_WALLET');
    expect(account.ownerId).toBe(seller.id);
    expect(new Prisma.Decimal(account.balance).equals(amount)).toBe(true);

    const journal = await prisma.journal.findUnique({
      where: {
        eventType_eventId: { eventType: 'OPENING_BALANCE', eventId: `OPENING_BALANCE:${account.id}` },
      },
    });
    expect(journal).not.toBeNull();

    const entries = await prisma.ledgerEntry.findMany({ where: { journalId: journal.id } });
    expect(entries).toHaveLength(2);
    const walletLeg = entries.find((e) => e.accountId === account.id);
    const cashLeg = entries.find((e) => e.accountId !== account.id);
    expect(walletLeg.direction).toBe('CREDIT');
    expect(new Prisma.Decimal(walletLeg.amount).equals(amount)).toBe(true);
    expect(cashLeg.direction).toBe('DEBIT');
    expect(new Prisma.Decimal(cashLeg.amount).equals(amount)).toBe(true);

    const wallet = await prisma.wallet.findUnique({ where: { userId: seller.id } });
    expect(new Prisma.Decimal(wallet.balance).equals(new Prisma.Decimal(seededWalletBalance))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GROUP 3 — Idempotency
// ─────────────────────────────────────────────────────────────────────────
describe('postOpeningBalanceForWallet — idempotency', () => {
  test('calling twice for the same account posts exactly once; the second call is recognized as an already-posted replay', async () => {
    const customer = await makeUser('CUSTOMER');
    await makeOrder(customer.id);
    await makeWallet(customer.id, '7000');
    const cutoverAt = new Date();
    const amount = new Prisma.Decimal('7000');

    const first = await postOpeningBalanceForWallet({
      userId: customer.id, ownerType: 'CUSTOMER_WALLET', amount, cutoverAt,
    });
    createdAccountIds.push(first.account.id);
    createdEventIds.push(['OPENING_BALANCE', `OPENING_BALANCE:${first.account.id}`]);
    expect(first.alreadyPosted).toBe(false);
    expect(first.accountWasCreated).toBe(true);

    const second = await postOpeningBalanceForWallet({
      userId: customer.id, ownerType: 'CUSTOMER_WALLET', amount, cutoverAt,
    });
    expect(second.alreadyPosted).toBe(true);
    expect(second.skipped).toBe(false);
    expect(second.accountWasCreated).toBe(false);
    expect(second.account.id).toBe(first.account.id);

    const journals = await prisma.journal.findMany({
      where: { eventType: 'OPENING_BALANCE', eventId: `OPENING_BALANCE:${first.account.id}` },
    });
    expect(journals).toHaveLength(1);

    const entries = await prisma.ledgerEntry.findMany({ where: { journalId: journals[0].id } });
    expect(entries).toHaveLength(2); // not 4 — the second call did not re-post

    const account = await prisma.account.findUnique({ where: { id: first.account.id } });
    expect(new Prisma.Decimal(account.balance).equals(amount)).toBe(true); // not doubled
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GROUP 4 — EXISTING_LEDGER_ACTIVITY safety check
// ─────────────────────────────────────────────────────────────────────────
describe('postOpeningBalanceForWallet — existing non-OPENING_BALANCE Ledger activity is skipped, not double-posted', () => {
  test('an account with real prior PAYMENT_CONFIRMED activity is skipped and reported, and its existing journal/entry are left untouched', async () => {
    const customer = await makeUser('CUSTOMER');
    await makeOrder(customer.id); // real ownership signal, for fixture realism
    await makeWallet(customer.id, '5000');

    // Real pre-existing Ledger activity on the SAME (CUSTOMER_WALLET,
    // customer.id) account, posted via the real postJournal mechanism —
    // exactly the "live P2.4-wired activity" this safety check guards
    // against, with a non-OPENING_BALANCE eventType.
    const priorEventId = crypto.randomUUID();
    createdEventIds.push(['PAYMENT_CONFIRMED', priorEventId]);
    const priorAmount = '5000';
    const {
      journal: priorJournal, entries: priorEntries, account: walletAccount,
    } = await prisma.$transaction(async (tx) => {
      const account = await getOrCreateAccount(tx, 'CUSTOMER_WALLET', customer.id, LEDGER_CURRENCY);
      const cashAccount = await getOrCreateAccount(tx, 'PLATFORM_CASH', PLATFORM_LEDGER_OWNER_ID, LEDGER_CURRENCY);
      const posted = await postJournal(tx, {
        eventType: 'PAYMENT_CONFIRMED',
        eventId: priorEventId,
        currency: LEDGER_CURRENCY,
        legs: [
          { accountId: account.id, direction: 'CREDIT', amount: priorAmount },
          { accountId: cashAccount.id, direction: 'DEBIT', amount: priorAmount },
        ],
      });
      return { ...posted, account };
    });
    createdAccountIds.push(walletAccount.id);

    const priorEntrySnapshot = priorEntries.map((e) => ({
      id: e.id, direction: e.direction, amount: e.amount.toString(), accountId: e.accountId,
    }));

    const result = await postOpeningBalanceForWallet({
      userId: customer.id,
      ownerType: 'CUSTOMER_WALLET',
      amount: new Prisma.Decimal('5000'),
      cutoverAt: new Date(),
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('EXISTING_LEDGER_ACTIVITY');
    expect(result.alreadyPosted).toBe(false);
    expect(result.priorActivityCount).toBe(1);
    expect(result.accountWasCreated).toBe(false);

    // No OPENING_BALANCE Journal was created for this account.
    const openingJournal = await prisma.journal.findUnique({
      where: {
        eventType_eventId: { eventType: 'OPENING_BALANCE', eventId: `OPENING_BALANCE:${walletAccount.id}` },
      },
    });
    expect(openingJournal).toBeNull();

    // Wallet.balance is untouched.
    const wallet = await prisma.wallet.findUnique({ where: { userId: customer.id } });
    expect(new Prisma.Decimal(wallet.balance).equals(new Prisma.Decimal('5000'))).toBe(true);

    // The pre-existing journal and its entries are exactly as they were.
    const journalAfter = await prisma.journal.findUnique({ where: { id: priorJournal.id } });
    expect(journalAfter.eventType).toBe('PAYMENT_CONFIRMED');
    expect(journalAfter.eventId).toBe(priorEventId);

    const entriesAfter = await prisma.ledgerEntry.findMany({ where: { journalId: priorJournal.id } });
    expect(entriesAfter).toHaveLength(priorEntrySnapshot.length);
    entriesAfter.forEach((e) => {
      const before = priorEntrySnapshot.find((p) => p.id === e.id);
      expect(before).toBeDefined();
      expect(e.direction).toBe(before.direction);
      expect(e.amount.toString()).toBe(before.amount);
      expect(e.accountId).toBe(before.accountId);
    });

    // The account's cached balance still reflects only the prior activity
    // (5000 credited), not doubled by any skipped-but-partially-applied
    // opening balance.
    const accountAfter = await prisma.account.findUnique({ where: { id: walletAccount.id } });
    expect(new Prisma.Decimal(accountAfter.balance).equals(new Prisma.Decimal('5000'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GROUP 5 — No Category-B side effects
// ─────────────────────────────────────────────────────────────────────────
describe('postOpeningBalanceForWallet — no Category-B side effects', () => {
  test('posting a CUSTOMER_WALLET opening balance creates/modifies no Payment, OrderItemSettlement, or PaymentRefund row for that order', async () => {
    const customer = await makeUser('CUSTOMER');
    const order = await makeOrder(customer.id);
    await makeWallet(customer.id, '3000');

    const beforePayments = await prisma.payment.count({ where: { orderId: order.id } });
    const beforeSettlements = await prisma.orderItemSettlement.count({ where: { orderId: order.id } });
    const beforeRefunds = await prisma.paymentRefund.count({ where: { orderId: order.id } });
    expect(beforePayments).toBe(0);
    expect(beforeSettlements).toBe(0);
    expect(beforeRefunds).toBe(0);

    const result = await postOpeningBalanceForWallet({
      userId: customer.id,
      ownerType: 'CUSTOMER_WALLET',
      amount: new Prisma.Decimal('3000'),
      cutoverAt: new Date(),
    });
    createdAccountIds.push(result.account.id);
    createdEventIds.push(['OPENING_BALANCE', `OPENING_BALANCE:${result.account.id}`]);

    const afterPayments = await prisma.payment.count({ where: { orderId: order.id } });
    const afterSettlements = await prisma.orderItemSettlement.count({ where: { orderId: order.id } });
    const afterRefunds = await prisma.paymentRefund.count({ where: { orderId: order.id } });
    expect(afterPayments).toBe(0);
    expect(afterSettlements).toBe(0);
    expect(afterRefunds).toBe(0);
  });

  test('posting a SELLER_WALLET opening balance creates/modifies no PayoutRequest or SellerPayoutLiability row for that seller', async () => {
    const seller = await makeUser('SELLER');
    await makeStore(seller.id);
    await makeWallet(seller.id, '9000');

    const beforePayouts = await prisma.payoutRequest.count({ where: { sellerId: seller.id } });
    const beforeLiabilities = await prisma.sellerPayoutLiability.count({ where: { sellerId: seller.id } });
    expect(beforePayouts).toBe(0);
    expect(beforeLiabilities).toBe(0);

    const result = await postOpeningBalanceForWallet({
      userId: seller.id,
      ownerType: 'SELLER_WALLET',
      amount: new Prisma.Decimal('9000'),
      cutoverAt: new Date(),
    });
    createdAccountIds.push(result.account.id);
    createdEventIds.push(['OPENING_BALANCE', `OPENING_BALANCE:${result.account.id}`]);

    const afterPayouts = await prisma.payoutRequest.count({ where: { sellerId: seller.id } });
    const afterLiabilities = await prisma.sellerPayoutLiability.count({ where: { sellerId: seller.id } });
    expect(afterPayouts).toBe(0);
    expect(afterLiabilities).toBe(0);
  });
});
