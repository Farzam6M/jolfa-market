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
 * removes the LedgerEntry/Journal/Account rows this file created, by
 * tracked id, routed through the P2.6 Step 2F maintenance client (see
 * tests/helpers/maintenance-client.js) since jolfa_app intentionally has
 * no DELETE on those tables.
 *
 * P2.6 Step 2F correction: this file's Order/User fixtures are
 * DELIBERATELY NOT deleted in `afterAll` (createdOrderIds/createdUserIds
 * are still tracked, for clarity/possible future use, but nothing
 * iterates them for deletion). `orders.userId` is `ON DELETE RESTRICT`
 * (see the 20260716222658_init migration), so a created User cannot be
 * removed while its Order still exists; and no role — not jolfa_app, not
 * jolfa_maintenance — is granted DELETE on `orders` (a deliberate
 * least-privilege boundary: `orders` is a real business table with no
 * production `src/` code path that deletes a row from it, so no test
 * role is widened just for cleanup convenience). Leaving these rows
 * behind matches the convention already used by every other test suite
 * in this repo that creates Order rows (e.g. order-refund.test.js,
 * order-settlement.test.js, admin-sellers-deletion.test.js,
 * chat-notifications-socket.test.js) — none of them delete their Order
 * or owning User fixtures either. Each fixture here has a unique random
 * suffix, so leftover rows never collide with or affect later runs.
 *
 * PLATFORM_CASH is shared/singleton (ownerType='PLATFORM_CASH', ownerId=
 * PLATFORM_LEDGER_OWNER_ID) and every postOpeningBalance/postJournal call
 * in this file mutates its cached Account.balance column as a DEBIT leg —
 * deleting only the LedgerEntry/Journal rows this file created (as above)
 * would leave that cached balance permanently drifted by this file's own
 * posted amounts, since postJournal's balance increment/decrement is
 * independent of the LedgerEntry row itself. `beforeAll` snapshots
 * PLATFORM_CASH's pre-test { id, balance } (or records that it did not yet
 * exist); `afterAll` then either restores that exact balance (if it
 * pre-existed — this file never touches its prior Journal/LedgerEntry
 * rows, only its own tracked ones, so only the cached column needs
 * correcting) or removes the account entirely (if this file created it
 * fresh and no foreign LedgerEntry rows remain on it afterward). Net
 * effect either way: PLATFORM_CASH is left in exactly the state this file
 * found it in.
 *
 * Requires a real Postgres database (DATABASE_URL), migrated:
 *   NODE_ENV=test npx jest tests/ledger/p2_5-opening-balance.test.js --runInBand
 */
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../../src/config/database');
const { getMaintenanceClient, disconnectMaintenanceClient } = require('../helpers/maintenance-client');
const { postJournal, getOrCreateAccount } = require('../../src/modules/ledger/ledger.service');
const { PLATFORM_LEDGER_OWNER_ID, LEDGER_CURRENCY } = require('../../src/modules/ledger/ledger.constants');
const {
  classifyOwnerType,
  postOpeningBalanceForWallet,
} = require('../../scripts/p2_5-opening-balance-migration');

let roles;
// Captured in `beforeAll`, before this file posts anything — either the
// pre-existing PLATFORM_CASH Account row's { id, balance }, or `null` if
// no PLATFORM_CASH account existed yet. Used by `afterAll` to leave
// PLATFORM_CASH in EXACTLY the state this file found it in: restore the
// original cached balance if the account pre-existed (its own prior
// Journal/LedgerEntry rows are never touched by this file's cleanup, only
// its own tracked ones are, so only the cached balance column needs
// correcting), or remove the account entirely if this file created it.
let platformCashSnapshot;

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
  // P2.6 Step 2F: journals/ledger_entries/ledger_accounts DELETE requires
  // the jolfa_maintenance role — the shared `prisma` client (jolfa_app)
  // is used below only for read-only lookups. See
  // tests/helpers/maintenance-client.js.
  const maintenance = getMaintenanceClient();

  // Children first (FK onDelete: Restrict on ledger_entries ->
  // journals/ledger_accounts), same convention as ledger.service.test.js.
  const journalWhere = { OR: createdEventIds.map(([eventType, eventId]) => ({ eventType, eventId })) };
  if (createdEventIds.length > 0) {
    const journals = await prisma.journal.findMany({ where: journalWhere, select: { id: true } });
    const journalIds = journals.map((j) => j.id);
    if (journalIds.length > 0) {
      await maintenance.ledgerEntry.deleteMany({ where: { journalId: { in: journalIds } } });
    }
    await maintenance.journal.deleteMany({ where: journalWhere });
  }
  if (createdAccountIds.length > 0) {
    // Never includes the shared PLATFORM_CASH account id — only the
    // per-test CUSTOMER_WALLET/SELLER_WALLET accounts this file created.
    await maintenance.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  }

  // P2.6 Step 2F: Order/User fixtures (createdOrderIds/createdUserIds)
  // are intentionally NOT deleted here — see the file-level doc comment
  // above ("orders.userId is ON DELETE RESTRICT, and no role is granted
  // DELETE on orders") for why, and why leaving them is safe.

  // Leave PLATFORM_CASH in exactly the state this file found it in.
  // Must run AFTER the LedgerEntry/Journal cleanup above, so the "any
  // entries left on it?" check below reflects only rows outside this
  // file's own tracked events.
  const platformCashNow = await prisma.account.findUnique({
    where: {
      ownerType_ownerId_currency: { ownerType: 'PLATFORM_CASH', ownerId: PLATFORM_LEDGER_OWNER_ID, currency: LEDGER_CURRENCY },
    },
  });
  if (platformCashNow) {
    if (platformCashSnapshot) {
      // Pre-existed this file's run: this file never deleted its prior
      // Journal/LedgerEntry rows (only its own tracked ones), so the only
      // thing this file could have thrown off is the cached balance
      // column — restore it to the exact pre-test value. A direct set
      // (not a computed increment/decrement) so this is correct
      // regardless of how many postings this file made. This is a plain
      // UPDATE on ledger_accounts, which jolfa_app is already granted, so
      // it stays on the shared `prisma` client, not the maintenance one.
      await prisma.account.update({
        where: { id: platformCashNow.id },
        data: { balance: platformCashSnapshot.balance },
      });
    } else {
      // Did not exist before this file ran, so this file itself created
      // it (via getOrCreateAccount inside postOpeningBalance/postJournal).
      // Only remove it if no LedgerEntry rows remain on it — if any do,
      // something outside this file's own tracked events touched it
      // concurrently, and deleting it would be unsafe. A DELETE on
      // ledger_accounts, so this goes through the maintenance client.
      const remainingEntries = await prisma.ledgerEntry.count({ where: { accountId: platformCashNow.id } });
      if (remainingEntries === 0) {
        await maintenance.account.delete({ where: { id: platformCashNow.id } });
      }
    }
  }

  await disconnectMaintenanceClient();
  await prisma.$disconnect();
});

beforeAll(async () => {
  const roleRows = await prisma.role.findMany();
  roles = Object.fromEntries(roleRows.map((r) => [r.key, r]));
  if (!roles.CUSTOMER || !roles.SELLER) {
    throw new Error('P2.5 tests require CUSTOMER and SELLER roles to be seeded (run prisma/seed.js)');
  }

  // Snapshot PLATFORM_CASH's state BEFORE this file posts anything, so
  // afterAll can restore it exactly (see platformCashSnapshot's doc
  // comment above).
  const existingPlatformCash = await prisma.account.findUnique({
    where: {
      ownerType_ownerId_currency: { ownerType: 'PLATFORM_CASH', ownerId: PLATFORM_LEDGER_OWNER_ID, currency: LEDGER_CURRENCY },
    },
  });
  platformCashSnapshot = existingPlatformCash
    ? { id: existingPlatformCash.id, balance: existingPlatformCash.balance.toString() }
    : null;
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
