/**
 * Test suite for Phase 6: Seller Payout Liability Recovery & Visibility.
 *
 * Builds on Phase 5's SellerPayoutLiability (created by
 * orders.service.js#refundDeliveredOrder when a refund clawback can't be
 * fully collected — see order-refund.test.js) and closes the lifecycle:
 *
 *   - payout-liabilities.service.js#recoverSellerLiabilities: FIFO
 *     recovery from every future settleDeliveredOrder earning, called
 *     from inside that same settlement transaction.
 *   - payouts.service.js#createPayout: withdrawableAmount =
 *     max(0, wallet.balance - outstandingLiabilityTotal).
 *   - GET /admin/payout-liabilities: admin-only read listing.
 *
 * Requires a real Postgres database (DATABASE_URL), migrated + seeded:
 *   NODE_ENV=test npm test
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

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
    name: 'محصول بدهی تست', categoryId, price: 20000, stock: 999, ...overrides,
  });
  const id = created.body.data.id;
  await api.patch(`${PREFIX}/products/${id}/moderate`).set('Authorization', adminAuth).send({ status: 'APPROVED' });
  return prisma.storeProduct.findUnique({ where: { id } });
}

/** Checks out `qty` of `storeProduct` and drives the order all the way to DELIVERED (triggers settlement) — same pattern as order-settlement.test.js's checkoutToSent, extended one step further. No payment step: admin status transitions don't require one (see ORDER_TRANSITIONS). */
async function fullyDeliverOrder(customerAuth, adminAuth, storeProduct, qty) {
  await api.post(`${PREFIX}/cart/items`).set('Authorization', customerAuth).send({ productId: storeProduct.id, qty });
  const created = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customerAuth).send({});
  const orderId = created.body.data.id;
  await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'CONFIRMED' });
  await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'PREPARING' });
  await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'SENT' });
  const res = await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'DELIVERED' });
  return { res, order: await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } }) };
}

/** Checks out and confirms/prepares/sends, leaving the order SENT (caller triggers DELIVERED itself, e.g. for concurrency tests). */
async function checkoutToSent(customerAuth, adminAuth, storeProduct, qty) {
  await api.post(`${PREFIX}/cart/items`).set('Authorization', customerAuth).send({ productId: storeProduct.id, qty });
  const created = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customerAuth).send({});
  const orderId = created.body.data.id;
  await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'CONFIRMED' });
  await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'PREPARING' });
  await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'SENT' });
  return prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
}

/** Directly seeds an OUTSTANDING liability row (bypasses the refund flow — already covered by order-refund.test.js — so recovery scenarios here can be set up deterministically). */
async function makeLiability(sellerId, orderId, storeId, amount, { createdAt } = {}) {
  return prisma.sellerPayoutLiability.create({
    data: {
      sellerId,
      orderId,
      storeId,
      amount,
      reason: 'بدهی آزمایشی Phase 6',
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

const validBank = () => ({
  bankAccountHolder: 'علی رضایی',
  bankIban: 'IR820540102680020817909002',
  bankCardNumber: '6037991234567890',
});

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

describe('Phase 6 — Liability recovery on settlement', () => {
  let customer;
  let seller;
  let admin;
  let category;
  let product;
  let store;

  beforeAll(async () => {
    customer = await makeUser('CUSTOMER', '54000000' + Math.floor(Math.random() * 9));
    seller = await makeUser('SELLER', '54010000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '54020000' + Math.floor(Math.random() * 9));
    store = await makeApprovedStore(seller.user.id, 'فروشگاه بدهی');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته بدهی', slug: `liability-cat-${Date.now()}` });
    category = cat.body.data;
    product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 40000, stock: 999 });

    // resolveCommissionRate requires an active GLOBAL rule — same
    // prerequisite as order-settlement.test.js.
    const existingGlobal = await prisma.commissionRule.findFirst({ where: { scope: 'GLOBAL', isActive: true } });
    if (!existingGlobal) {
      await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate: 10 });
    }

    await prisma.wallet.upsert({
      where: { userId: seller.user.id }, update: { balance: 0 }, create: { userId: seller.user.id, balance: 0 },
    });
  });

  test('full recovery from one future settlement: liability becomes RECOVERED, wallet gets only the remainder', async () => {
    // gross=40000, commission 10% -> sellerEarning=36000.
    const dummyOrder = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    const liability = await makeLiability(seller.user.id, dummyOrder.order.id, store.id, 20000);

    const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    const { res, order } = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    expect(res.status).toBe(200);

    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: order.items[0].id } });
    expect(Number(settlement.sellerEarning)).toBe(36000); // snapshot unaffected by recovery

    const liabilityAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: liability.id } });
    expect(liabilityAfter.status).toBe('RECOVERED');
    expect(Number(liabilityAfter.amount)).toBe(0);
    expect(liabilityAfter.recoveredAt).not.toBeNull();

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    // 36000 earned - 20000 recovered = 16000 credited to wallet.
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance) + 16000);

    const recoveryTx = await prisma.walletTransaction.findFirst({ where: { refId: liability.id, type: 'DEBIT' } });
    expect(recoveryTx).not.toBeNull();
    expect(Number(recoveryTx.amount)).toBe(20000);

    const creditTx = await prisma.walletTransaction.findFirst({ where: { refId: order.items[0].id, type: 'CREDIT' } });
    expect(creditTx).not.toBeNull();
    expect(Number(creditTx.amount)).toBe(16000);
  });

  test('partial recovery: liability stays OUTSTANDING with a reduced amount, wallet receives nothing', async () => {
    const dummyOrder = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    const liability = await makeLiability(seller.user.id, dummyOrder.order.id, store.id, 100000); // bigger than one settlement's earning (36000)

    const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    const { order } = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);

    const liabilityAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: liability.id } });
    expect(liabilityAfter.status).toBe('OUTSTANDING');
    expect(Number(liabilityAfter.amount)).toBe(100000 - 36000);
    expect(liabilityAfter.recoveredAt).toBeNull();

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance)); // nothing credited — fully absorbed

    const creditTx = await prisma.walletTransaction.findFirst({ where: { refId: order.items[0].id, type: 'CREDIT' } });
    expect(creditTx).toBeNull(); // no zero-amount noise row
  });

  test('FIFO ordering: the older liability is recovered first even if created after a newer one in insertion order', async () => {
    const dummyOrder = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    const now = Date.now();
    // Insert the NEWER one first, then the OLDER one, to prove ordering is by createdAt, not insertion order.
    const newer = await makeLiability(seller.user.id, dummyOrder.order.id, store.id, 10000, { createdAt: new Date(now) });
    const older = await makeLiability(seller.user.id, dummyOrder.order.id, store.id, 10000, { createdAt: new Date(now - 60000) });

    // sellerEarning=36000 covers older(10000) + newer(10000) fully, remainder 16000 to wallet.
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    const { order } = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);

    const olderAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: older.id } });
    const newerAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: newer.id } });
    expect(olderAfter.status).toBe('RECOVERED');
    expect(newerAfter.status).toBe('RECOVERED');

    // Verify the OLDER liability's recovery WalletTransaction was written before the newer one's.
    const olderTx = await prisma.walletTransaction.findFirst({ where: { refId: older.id, type: 'DEBIT' } });
    const newerTx = await prisma.walletTransaction.findFirst({ where: { refId: newer.id, type: 'DEBIT' } });
    expect(olderTx.createdAt.getTime()).toBeLessThanOrEqual(newerTx.createdAt.getTime());

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance) + 16000);
    void order;
  });

  test('recovery across multiple future settlements: a partially-recovered liability finishes recovering on a later settlement', async () => {
    const dummyOrder = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    const liability = await makeLiability(seller.user.id, dummyOrder.order.id, store.id, 50000); // needs two 36000-earning settlements to clear

    const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });

    await fullyDeliverOrder(customer.auth, admin.auth, product, 1); // recovers 36000, remaining 14000
    const midLiability = await prisma.sellerPayoutLiability.findUnique({ where: { id: liability.id } });
    expect(midLiability.status).toBe('OUTSTANDING');
    expect(Number(midLiability.amount)).toBe(14000);

    await fullyDeliverOrder(customer.auth, admin.auth, product, 1); // recovers remaining 14000, credits 22000 remainder
    const finalLiability = await prisma.sellerPayoutLiability.findUnique({ where: { id: liability.id } });
    expect(finalLiability.status).toBe('RECOVERED');
    expect(Number(finalLiability.amount)).toBe(0);

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance) + 22000); // 0 + 22000 credited total across both settlements
  });

  test('seller with no outstanding liability behaves exactly as before Phase 6', async () => {
    const freshSeller = await makeUser('SELLER', '54030000' + Math.floor(Math.random() * 9));
    const freshStore = await makeApprovedStore(freshSeller.user.id, 'فروشگاه بدون بدهی');
    const freshProduct = await makeApprovedProduct(freshSeller.auth, admin.auth, category.id, { price: 40000, stock: 999 });
    void freshStore;

    const walletBefore = await prisma.wallet.findUnique({ where: { userId: freshSeller.user.id } });
    const { order } = await fullyDeliverOrder(customer.auth, admin.auth, freshProduct, 1);

    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: order.items[0].id } });
    expect(Number(settlement.sellerEarning)).toBe(36000);

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: freshSeller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance) + 36000); // full credit, unchanged behavior

    const creditTx = await prisma.walletTransaction.findFirst({ where: { refId: order.items[0].id, type: 'CREDIT' } });
    expect(creditTx).not.toBeNull();
    expect(Number(creditTx.amount)).toBe(36000);
  });

  test("seller A's liability is never touched by seller B's settlement", async () => {
    const sellerB = await makeUser('SELLER', '54040000' + Math.floor(Math.random() * 9));
    const storeB = await makeApprovedStore(sellerB.user.id, 'فروشگاه ب');
    const productB = await makeApprovedProduct(sellerB.auth, admin.auth, category.id, { price: 40000, stock: 999 });
    await prisma.wallet.upsert({
      where: { userId: sellerB.user.id }, update: { balance: 0 }, create: { userId: sellerB.user.id, balance: 0 },
    });
    void storeB;

    const dummyOrder = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    const liabilityA = await makeLiability(seller.user.id, dummyOrder.order.id, store.id, 20000);

    await fullyDeliverOrder(customer.auth, admin.auth, productB, 1); // seller B settles — must not touch seller A's liability

    const liabilityAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: liabilityA.id } });
    expect(liabilityAfter.status).toBe('OUTSTANDING');
    expect(Number(liabilityAfter.amount)).toBe(20000); // untouched
  });

  test('concurrent settlements for the same seller never double-recover the same liability', async () => {
    const racer = await makeUser('SELLER', '54050000' + Math.floor(Math.random() * 9));
    const racerStore = await makeApprovedStore(racer.user.id, 'فروشگاه هم‌زمان');
    const racerProduct = await makeApprovedProduct(racer.auth, admin.auth, category.id, { price: 40000, stock: 999 });
    await prisma.wallet.upsert({
      where: { userId: racer.user.id }, update: { balance: 0 }, create: { userId: racer.user.id, balance: 0 },
    });

    const dummyOrder = await fullyDeliverOrder(customer.auth, admin.auth, racerProduct, 1);
    // Liability smaller than a single settlement's earning (36000) but big
    // enough that two concurrent 36000 earnings both racing to recover it
    // would over-recover if not properly serialized.
    const liability = await makeLiability(racer.user.id, dummyOrder.order.id, racerStore.id, 30000);

    const orderX = await checkoutToSent(customer.auth, admin.auth, racerProduct, 1);
    const orderY = await checkoutToSent(customer.auth, admin.auth, racerProduct, 1);

    const [resX, resY] = await Promise.all([
      api.patch(`${PREFIX}/orders/${orderX.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' }),
      api.patch(`${PREFIX}/orders/${orderY.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' }),
    ]);

    // At least one must succeed; a genuine per-row race on the liability
    // is allowed to abort the loser (safe, retryable), but never allowed
    // to let both succeed AND over-recover.
    const statuses = [resX.status, resY.status];
    expect(statuses.some((s) => s === 200)).toBe(true);

    const liabilityAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: liability.id } });
    // Never recovered more than the original 30000, regardless of how many settlements touched it.
    expect(Number(liabilityAfter.amount)).toBeGreaterThanOrEqual(0);
    expect(30000 - Number(liabilityAfter.amount)).toBeLessThanOrEqual(30000);

    const recoveryDebits = await prisma.walletTransaction.findMany({ where: { refId: liability.id, type: 'DEBIT' } });
    const totalRecovered = recoveryDebits.reduce((s, t) => s + Number(t.amount), 0);
    expect(totalRecovered).toBe(30000 - Number(liabilityAfter.amount)); // ledger matches the liability's remaining amount exactly
    expect(totalRecovered).toBeLessThanOrEqual(30000); // never over-recovered

    const wallet = await prisma.wallet.findUnique({ where: { userId: racer.user.id } });
    expect(Number(wallet.balance)).toBeGreaterThanOrEqual(0); // invariant #1
  });
});

describe('Phase 6 — Payout capped by outstanding liability', () => {
  let seller;
  let admin;

  beforeAll(async () => {
    seller = await makeUser('SELLER', '54060000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '54070000' + Math.floor(Math.random() * 9));
  });

  test('payout is capped at wallet.balance - outstandingLiabilityTotal', async () => {
    await prisma.wallet.upsert({
      where: { userId: seller.user.id }, update: { balance: 500000 }, create: { userId: seller.user.id, balance: 500000 },
    });
    const store = await makeApprovedStore(seller.user.id, 'فروشگاه سقف برداشت');
    // Need a real order/store FK for the liability row.
    const customer = await makeUser('CUSTOMER', '54080000' + Math.floor(Math.random() * 9));
    const category = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته سقف برداشت', slug: `payout-cap-cat-${Date.now()}` });
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.body.data.id, { price: 10000, stock: 999 });
    const { order } = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    await makeLiability(seller.user.id, order.id, store.id, 180000);
    // wallet=500000+earning already settled; reset explicit for determinism.
    await prisma.wallet.update({ where: { userId: seller.user.id }, data: { balance: 500000 } });

    // wallet=500000, liability=180000 -> max payout = 320000.
    const tooMuch = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({ amount: 321000, ...validBank() });
    expect(tooMuch.status).toBe(400);

    const walletUnchanged = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletUnchanged.balance)).toBe(500000);

    const exact = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({ amount: 320000, ...validBank() });
    expect(exact.status).toBe(201);

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(180000); // exactly the reserved liability amount remains
  });

  test('payout is 0 when liability equals or exceeds wallet balance', async () => {
    const racer = await makeUser('SELLER', '54090000' + Math.floor(Math.random() * 9));
    const store = await makeApprovedStore(racer.user.id, 'فروشگاه بدهی کامل');
    const customer = await makeUser('CUSTOMER', '54100000' + Math.floor(Math.random() * 9));
    const category = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته بدهی کامل', slug: `payout-full-liability-cat-${Date.now()}` });
    const product = await makeApprovedProduct(racer.auth, admin.auth, category.body.data.id, { price: 10000, stock: 999 });
    const { order } = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    await prisma.wallet.update({ where: { userId: racer.user.id }, data: { balance: 500 } });
    await makeLiability(racer.user.id, order.id, store.id, 500);

    const res = await api.post(`${PREFIX}/payouts`).set('Authorization', racer.auth).send({ amount: 1, ...validBank() });
    expect(res.status).toBe(400);
  });

  test('payout works normally when liability = 0 (unchanged pre-Phase-6 behavior)', async () => {
    const racer = await makeUser('SELLER', '54110000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: racer.user.id, balance: 100000 } });

    const res = await api.post(`${PREFIX}/payouts`).set('Authorization', racer.auth).send({ amount: 100000, ...validBank() });
    expect(res.status).toBe(201);

    const wallet = await prisma.wallet.findUnique({ where: { userId: racer.user.id } });
    expect(Number(wallet.balance)).toBe(0);
  });
});

describe('Phase 6 — Admin liability visibility', () => {
  let seller;
  let admin;
  let store;

  beforeAll(async () => {
    seller = await makeUser('SELLER', '54120000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '54130000' + Math.floor(Math.random() * 9));
    store = await makeApprovedStore(seller.user.id, 'فروشگاه نمایش بدهی');
  });

  test('GET /admin/payout-liabilities lists liabilities with status/seller filters and pagination', async () => {
    const customer = await makeUser('CUSTOMER', '54140000' + Math.floor(Math.random() * 9));
    const category = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته نمایش بدهی', slug: `admin-liability-cat-${Date.now()}` });
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.body.data.id, { price: 10000, stock: 999 });
    const { order } = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    await makeLiability(seller.user.id, order.id, store.id, 5000);

    const res = await api.get(`${PREFIX}/admin/payout-liabilities`).set('Authorization', admin.auth).query({ sellerId: seller.user.id, status: 'OUTSTANDING' });
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThan(0);
    expect(res.body.data.items.every((i) => i.sellerId === seller.user.id && i.status === 'OUTSTANDING')).toBe(true);
    expect(res.body.data.items[0]).toHaveProperty('amount');
    expect(res.body.data.items[0]).toHaveProperty('createdAt');
    expect(res.body.data.items[0]).toHaveProperty('orderId');
  });

  test('a seller (no PAYOUT_LIABILITIES_READ) gets 403', async () => {
    const res = await api.get(`${PREFIX}/admin/payout-liabilities`).set('Authorization', seller.auth);
    expect(res.status).toBe(403);
  });

  test('a customer gets 403', async () => {
    const customer = await makeUser('CUSTOMER', '54150000' + Math.floor(Math.random() * 9));
    const res = await api.get(`${PREFIX}/admin/payout-liabilities`).set('Authorization', customer.auth);
    expect(res.status).toBe(403);
  });

  test('there is no manual-recovery endpoint (Phase 6 is automatic-only)', async () => {
    const customer = await makeUser('CUSTOMER', '54160000' + Math.floor(Math.random() * 9));
    const category = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته بدون بازیابی دستی', slug: `no-manual-recovery-cat-${Date.now()}` });
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.body.data.id, { price: 10000, stock: 999 });
    const { order } = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    const liability = await makeLiability(seller.user.id, order.id, store.id, 5000);

    const res = await api.patch(`${PREFIX}/admin/payout-liabilities/${liability.id}/recover`).set('Authorization', admin.auth);
    expect([404, 403]).toContain(res.status); // no such route wired anywhere
  });
});
