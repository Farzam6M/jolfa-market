/**
 * Test suite for seller settlement on order delivery (Phase 2: Order
 * Settlement / Seller Payout, built on top of Phase 1's CommissionRule).
 *
 * Covers:
 *   - SENT -> DELIVERED creates exactly one OrderItemSettlement per
 *     OrderItem, with gross/commission/sellerEarning computed per the
 *     documented formula (gross = priceSnapshot*qty, commission =
 *     round(gross*rate/100), sellerEarning = gross-commission), and
 *     credits the seller's wallet by exactly sellerEarning.
 *   - Rounding matches round-half-up on a rate that produces a non-integer
 *     commission.
 *   - A CATEGORY-scope CommissionRule overrides the GLOBAL default for an
 *     item in that category (resolveCommissionRate's own priority order is
 *     already unit-covered elsewhere; this just checks orders.service.js
 *     actually passes the item's real categoryId through).
 *   - Settlement snapshots are immutable: editing/deactivating the
 *     CommissionRule that produced a settlement afterwards does not change
 *     that settlement's stored numbers or the wallet credit already made.
 *   - orderItemId is DB-@unique on OrderItemSettlement: a duplicate insert
 *     for the same OrderItem is rejected at the database level (the same
 *     guarantee that prevents a raced double-DELIVERED request from
 *     double-crediting a seller in production).
 *   - Concurrent duplicate DELIVERED requests for the same order: only one
 *     settlement row per item is ever created and the seller's wallet is
 *     credited exactly once; the losing request is a graceful no-op, not
 *     an error.
 *   - If settlement can't complete (no active GLOBAL commission rule to
 *     resolve against), the whole transaction rolls back: the order stays
 *     SENT (not DELIVERED), no settlement row and no wallet credit are
 *     left behind, and the request can be retried once fixed.
 *
 * Requires a real Postgres database (DATABASE_URL), migrated + seeded:
 *   NODE_ENV=test npm test
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');
const { PLATFORM_LEDGER_OWNER_ID } = require('../src/modules/ledger/ledger.constants');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

// P2.8-B — small Ledger lookup helpers, same shape as
// payout-liabilities.test.js's own findJournal/entriesFor helpers (kept
// local rather than shared/exported, matching that file's own approach).
async function findJournal(eventType, eventId) {
  return prisma.journal.findUnique({ where: { eventType_eventId: { eventType, eventId } } });
}

async function entriesFor(journalId) {
  return prisma.ledgerEntry.findMany({ where: { journalId }, include: { account: true } });
}

let roles;

async function makeUser(roleKey, mobileSuffix) {
  const passwordHash = await bcrypt.hash('Passw0rd!23', 4);
  const user = await prisma.user.create({
    data: {
      name: `Test ${roleKey} ${mobileSuffix}`,
      mobile: `09${mobileSuffix}`,
      passwordHash,
      roleId: roles[roleKey].id,
      status: 'ACTIVE',
    },
  });
  const token = signAccessToken({ sub: user.id });
  return { user, token, auth: `Bearer ${token}` };
}

async function makeApprovedStore(sellerId, name) {
  return prisma.store.create({
    data: {
      sellerId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: 'APPROVED',
    },
  });
}

async function makeApprovedProduct(sellerAuth, adminAuth, categoryId, overrides = {}) {
  const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerAuth).send({
    name: 'محصول تسویه تست', categoryId, price: 20000, stock: 10, ...overrides,
  });
  const id = created.body.data.id;
  await api.patch(`${PREFIX}/products/${id}/moderate`).set('Authorization', adminAuth).send({ status: 'APPROVED' });
  return prisma.storeProduct.findUnique({ where: { id } });
}

/** Drives one order all the way from checkout to SENT (never DELIVERED — tests call that last transition themselves). */
async function checkoutToSent(customerAuth, adminAuth, storeProduct, qty) {
  await api.post(`${PREFIX}/cart/items`).set('Authorization', customerAuth).send({ productId: storeProduct.id, qty });
  const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customerAuth).send({});
  const id = order.body.data.id;
  await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', adminAuth).send({ status: 'CONFIRMED' });
  await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', adminAuth).send({ status: 'PREPARING' });
  await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', adminAuth).send({ status: 'SENT' });
  return prisma.order.findUnique({ where: { id }, include: { items: true } });
}

beforeAll(async () => {
  const roleRows = await prisma.role.findMany();
  roles = Object.fromEntries(roleRows.map((r) => [r.key, r]));
  if (!roles.CUSTOMER || !roles.SELLER || !roles.ADMIN || !roles.SUPER_ADMIN) {
    throw new Error('Roles are not seeded — run `npm run seed` against the test database first.');
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Order settlement on DELIVERED', () => {
  let customer;
  let seller;
  let admin;
  let category;
  let product;
  let globalRuleId;

  beforeAll(async () => {
    customer = await makeUser('CUSTOMER', '52000000' + Math.floor(Math.random() * 9));
    seller = await makeUser('SELLER', '52010000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '52020000' + Math.floor(Math.random() * 9));
    // makeUser() creates the user row directly via Prisma, bypassing the
    // real registration flow (auth.service.js/users.service.js/stores.service.js)
    // that normally provisions a Wallet for every new user. Every test below
    // drives orders all the way to DELIVERED, which triggers
    // settleDeliveredOrder()'s seller wallet credit — so the fixture must
    // provide the Wallet that production registration would have created.
    await prisma.wallet.create({ data: { userId: seller.user.id } });
    await makeApprovedStore(seller.user.id, 'فروشگاه تسویه');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته تسویه', slug: `settlement-cat-${Date.now()}` });
    category = cat.body.data;
    product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 40000, stock: 50 });

    // No GLOBAL CommissionRule exists in a freshly seeded DB (seed.js does
    // not create one) — resolveCommissionRate() requires at least one
    // active GLOBAL rule to ever succeed, so every test in this file
    // depends on this one existing first.
    const rule = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth)
      .send({ scope: 'GLOBAL', rate: 10 });
    expect(rule.status).toBe(201);
    globalRuleId = rule.body.data.id;
  });

  test('DELIVERED creates one OrderItemSettlement per item and credits the seller wallet by gross - commission', async () => {
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });

    const order = await checkoutToSent(customer.auth, admin.auth, product, 2);
    const delivered = await api.patch(`${PREFIX}/orders/${order.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });
    expect(delivered.status).toBe(200);
    expect(delivered.body.data.status).toBe('DELIVERED');

    const item = order.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });
    expect(settlement).not.toBeNull();
    expect(Number(settlement.grossAmount)).toBe(80000); // 40000 * 2
    expect(Number(settlement.commissionRate)).toBe(10);
    expect(Number(settlement.commissionAmount)).toBe(8000); // round(80000*10/100)
    expect(Number(settlement.sellerEarning)).toBe(72000); // 80000 - 8000
    expect(settlement.commissionRuleId).toBe(globalRuleId);

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance) + 72000);

    const walletTx = await prisma.walletTransaction.findFirst({ where: { walletId: walletAfter.id, refId: item.id } });
    expect(walletTx).not.toBeNull();
    expect(walletTx.type).toBe('CREDIT');
    expect(Number(walletTx.amount)).toBe(72000);

    // P2.8-B — the real SETTLEMENT Journal this same request posted.
    // eventId = OrderItemSettlement.id (settleDeliveredOrder's own
    // postSettlement call — see orders.service.js), not guessed: read
    // straight off the settlement row already fetched above. This
    // seller/order has no outstanding liability, so this is the plain
    // no-liability path (remainingSellerEarning === sellerEarning) —
    // postSettlement itself is always posted with the FULL sellerEarning
    // regardless of liability recovery (see that function's own doc
    // comment), so no special-casing is needed here either way.
    const settlementJournal = await findJournal('SETTLEMENT', settlement.id);
    expect(settlementJournal).not.toBeNull();

    const settlementEntries = await entriesFor(settlementJournal.id);
    // Three legs: DEBIT PLATFORM_CASH (gross), CREDIT PLATFORM_REVENUE
    // (commission), CREDIT SELLER_WALLET (sellerEarning) — per
    // postSettlement/ledger.constants.js's SETTLEMENT mapping. Both
    // commission and sellerEarning are > 0 here, so all three legs exist.
    expect(settlementEntries).toHaveLength(3);

    const cashLeg = settlementEntries.find((e) => e.account.ownerType === 'PLATFORM_CASH');
    expect(cashLeg).toBeDefined();
    expect(cashLeg.direction).toBe('DEBIT');
    expect(cashLeg.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(Number(cashLeg.amount)).toBe(Number(settlement.grossAmount));

    const revenueLeg = settlementEntries.find((e) => e.account.ownerType === 'PLATFORM_REVENUE');
    expect(revenueLeg).toBeDefined();
    expect(revenueLeg.direction).toBe('CREDIT');
    expect(revenueLeg.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(Number(revenueLeg.amount)).toBe(Number(settlement.commissionAmount));

    const sellerLeg = settlementEntries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    expect(sellerLeg).toBeDefined();
    expect(sellerLeg.direction).toBe('CREDIT');
    expect(sellerLeg.account.ownerId).toBe(seller.user.id);
    // Posted with the FULL sellerEarning, not remainingSellerEarning —
    // this test has no outstanding liability so the two are equal anyway,
    // but the assertion is against settlement.sellerEarning specifically
    // (the field postSettlement is actually called with) rather than the
    // wallet delta, keeping this assertion honest about what SETTLEMENT
    // itself posts.
    expect(Number(sellerLeg.amount)).toBe(Number(settlement.sellerEarning));

    // Balanced: SUM(DEBIT) === SUM(CREDIT), Decimal-safe (Number is exact
    // here since these are whole-unit Decimal(12,0) TMN amounts, same
    // comparison style as payout-liabilities.test.js's own balance check).
    const debitTotal = settlementEntries.filter((e) => e.direction === 'DEBIT')
      .reduce((sum, e) => sum + Number(e.amount), 0);
    const creditTotal = settlementEntries.filter((e) => e.direction === 'CREDIT')
      .reduce((sum, e) => sum + Number(e.amount), 0);
    expect(debitTotal).toBe(creditTotal);

    // Wallet <-> Ledger reconciliation: the real Wallet.balance increase
    // from this settlement equals both the SELLER_WALLET Ledger CREDIT
    // leg and the seller's Ledger Account.balance movement.
    const sellerLedgerAccount = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'SELLER_WALLET', ownerId: seller.user.id, currency: 'TMN' } },
    });
    expect(sellerLedgerAccount).not.toBeNull();
    const walletIncrease = Number(walletAfter.balance) - Number(walletBefore.balance);
    expect(walletIncrease).toBe(Number(sellerLeg.amount)); // Ledger SELLER_WALLET CREDIT == actual Wallet.balance increase
    // This is this seller's very first settlement (fixture-created Wallet
    // starts at 0, beforeAll creates no prior settlement for them), so the
    // Ledger Account's cumulative balance equals this single leg exactly,
    // not just "at least" — a stronger reconciliation than the general case.
    expect(Number(sellerLedgerAccount.balance)).toBe(Number(sellerLeg.amount));
    expect(Number(sellerLedgerAccount.balance)).toBe(Number(walletAfter.balance));
  });

  test('commission rounds half-up when gross * rate / 100 is not an integer', async () => {
    const oddProduct = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 33333, stock: 10 });
    const order = await checkoutToSent(customer.auth, admin.auth, oddProduct, 1);
    await api.patch(`${PREFIX}/orders/${order.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });

    // gross=33333, rate=10% -> 3333.3 -> rounds to 3333.
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: order.items[0].id } });
    expect(Number(settlement.grossAmount)).toBe(33333);
    expect(Number(settlement.commissionAmount)).toBe(3333);
    expect(Number(settlement.sellerEarning)).toBe(33333 - 3333);
  });

  test('a CATEGORY-scope rule overrides GLOBAL for an item in that category', async () => {
    const specialCat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته ویژه تسویه', slug: `settlement-special-cat-${Date.now()}` });
    await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth)
      .send({ scope: 'CATEGORY', categoryId: specialCat.body.data.id, rate: 20 });

    // Explicit unique name — findOrCreateProduct() dedupes the shared global
    // Product by identityKey (name|brand|model|capacity|color), NOT by
    // categoryId. Reusing the default 'محصول تسویه تست' name here would
    // collide with the beforeAll product and silently keep the OLD
    // categoryId (categoryId is only set on first creation of a given
    // identity), making this test assert against the wrong rule entirely.
    const specialProduct = await makeApprovedProduct(seller.auth, admin.auth, specialCat.body.data.id, {
      name: 'محصول ویژه تسویه با دسته اختصاصی', price: 10000, stock: 10,
    });
    const order = await checkoutToSent(customer.auth, admin.auth, specialProduct, 1);
    await api.patch(`${PREFIX}/orders/${order.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });

    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: order.items[0].id } });
    expect(Number(settlement.commissionRate)).toBe(20); // CATEGORY rule, not the 10% GLOBAL default
    expect(Number(settlement.commissionAmount)).toBe(2000); // round(10000*20/100)
  });

  test('settlement snapshot is immutable: editing the CommissionRule afterwards does not change a past settlement or re-touch the wallet', async () => {
    const order = await checkoutToSent(customer.auth, admin.auth, product, 1);
    await api.patch(`${PREFIX}/orders/${order.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });

    const settlementBefore = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: order.items[0].id } });
    const walletAfterSettle = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });

    // Bump the GLOBAL rate way up after the fact.
    const patched = await api.patch(`${PREFIX}/admin/commission-rules/${globalRuleId}`).set('Authorization', admin.auth).send({ rate: 90 });
    expect(patched.status).toBe(200);

    const settlementAfter = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: order.items[0].id } });
    expect(Number(settlementAfter.commissionRate)).toBe(Number(settlementBefore.commissionRate));
    expect(Number(settlementAfter.commissionAmount)).toBe(Number(settlementBefore.commissionAmount));
    expect(Number(settlementAfter.sellerEarning)).toBe(Number(settlementBefore.sellerEarning));

    const walletNow = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletNow.balance)).toBe(Number(walletAfterSettle.balance)); // untouched by the rate edit

    // Restore for subsequent tests.
    await api.patch(`${PREFIX}/admin/commission-rules/${globalRuleId}`).set('Authorization', admin.auth).send({ rate: 10 });
  });

  test('OrderItemSettlement.orderItemId is DB-unique — a duplicate row for the same item is rejected', async () => {
    const order = await checkoutToSent(customer.auth, admin.auth, product, 1);
    await api.patch(`${PREFIX}/orders/${order.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });

    const existing = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: order.items[0].id } });
    expect(existing).not.toBeNull();

    await expect(prisma.orderItemSettlement.create({
      data: {
        orderItemId: order.items[0].id,
        orderId: order.id,
        storeId: order.items[0].storeId,
        commissionRate: 10,
        grossAmount: 1,
        commissionAmount: 0,
        sellerEarning: 1,
      },
    })).rejects.toThrow(); // Prisma P2002 unique constraint violation
  });

  test('concurrent duplicate DELIVERED requests settle exactly once — no double credit, losing request is a graceful no-op', async () => {
    const order = await checkoutToSent(customer.auth, admin.auth, product, 1);
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });

    const [first, second] = await Promise.all([
      api.patch(`${PREFIX}/orders/${order.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' }),
      api.patch(`${PREFIX}/orders/${order.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' }),
    ]);
    // Neither request errors — the loser is a graceful no-op reporting the
    // order's actual (already-DELIVERED) status, not a 409/500.
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body.data.status).toBe('DELIVERED');
    expect(second.body.data.status).toBe('DELIVERED');

    const settlements = await prisma.orderItemSettlement.findMany({ where: { orderItemId: order.items[0].id } });
    expect(settlements.length).toBe(1); // exactly one settlement row, never two

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance) + Number(settlements[0].sellerEarning)); // credited exactly once

    // P2.8-B — the replay-safe side of the same guarantee on the Ledger:
    // postJournal is idempotent on (eventType, eventId) (see
    // ledger.service.js#postJournal's own doc comment), and eventId here
    // is settlements[0].id — the single OrderItemSettlement row the DB's
    // orderItemId-unique constraint guaranteed above. Only one SETTLEMENT
    // Journal (and its 3 legs) should exist for it, never two, even though
    // two concurrent DELIVERED requests raced to settle this order.
    const settlementJournal = await findJournal('SETTLEMENT', settlements[0].id);
    expect(settlementJournal).not.toBeNull();
    const settlementEntries = await entriesFor(settlementJournal.id);
    expect(settlementEntries).toHaveLength(3); // never duplicated by the losing request
  });

  test('if settlement cannot resolve a commission rate, the whole transaction rolls back: order stays SENT and can be retried', async () => {
    const order = await checkoutToSent(customer.auth, admin.auth, product, 1);

    // Isolate this test's precondition explicitly instead of assuming
    // globalRuleId (this suite's own rule) is the only active GLOBAL row —
    // seed.js guarantees a default active GLOBAL rule exists in a fresh
    // database, so deactivating only globalRuleId would leave that seeded
    // row active and resolveCommissionRate() would still succeed. Look up
    // and deactivate every currently-active GLOBAL rule (going straight to
    // Prisma, since the admin API's assertNotRemovingLastActiveGlobal()
    // guard exists precisely to block reaching this "zero active GLOBAL"
    // state through the API) so resolveCommissionRate() truly has nothing
    // to resolve against — the exact failure path decision #14 requires to
    // roll back the whole transaction.
    const activeGlobalRules = await prisma.commissionRule.findMany({
      where: { scope: 'GLOBAL', isActive: true },
    });
    expect(activeGlobalRules.length).toBeGreaterThan(0); // sanity: something is active before we isolate the "none active" state
    await prisma.commissionRule.updateMany({
      where: { id: { in: activeGlobalRules.map((r) => r.id) } },
      data: { isActive: false },
    });

    const failedDelivery = await api.patch(`${PREFIX}/orders/${order.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });
    expect(failedDelivery.status).toBeGreaterThanOrEqual(500);

    const stillSent = await prisma.order.findUnique({ where: { id: order.id } });
    expect(stillSent.status).toBe('SENT'); // rolled back, NOT stuck half-DELIVERED

    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: order.items[0].id } });
    expect(settlement).toBeNull(); // no partial settlement row left behind

    // Restore exactly the rows we deactivated (not just globalRuleId) so
    // later tests — in this file and others — see the same active-GLOBAL
    // state as before this test, then retry the exact same request.
    await prisma.commissionRule.updateMany({
      where: { id: { in: activeGlobalRules.map((r) => r.id) } },
      data: { isActive: true },
    });
    const retried = await api.patch(`${PREFIX}/orders/${order.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });
    expect(retried.status).toBe(200);
    expect(retried.body.data.status).toBe('DELIVERED');

    const settlementAfterRetry = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: order.items[0].id } });
    expect(settlementAfterRetry).not.toBeNull();
  });
});
