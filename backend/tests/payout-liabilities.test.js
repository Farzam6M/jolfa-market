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
const crypto = require('crypto');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');
const { PLATFORM_LEDGER_OWNER_ID } = require('../src/modules/ledger/ledger.constants');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

let roles;

/**
 * Generates a collision-resistant 9-digit mobile suffix for synthetic test
 * users (the app requires mobile to match /^09\d{9}$/, so this value is
 * always exactly 9 digits).
 *
 * The previous pattern ('<8-digit block prefix>' + Math.floor(Math.random() * 9))
 * left only 9 possible endings per block, which collided with rows already
 * created by this same suite on a prior run, and with rows created by other
 * suites sharing the '54' synthetic-mobile namespace (e.g.
 * order-refund.test.js) against the same persistent, never-truncated test
 * database.
 *
 * `block` is a 2-digit code that preserves the original per-scenario
 * grouping (still human-readable when eyeballing rows in the DB); the
 * 5-digit cryptographically random tail gives each block a 100,000-value
 * collision space instead of 9.
 */
function uniqueMobileSuffix(block) {
  const random5 = crypto.randomInt(0, 100000).toString().padStart(5, '0');
  return `54${block}${random5}`;
}

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

/** Pays a PENDING order via WALLET — same call as order-refund.test.js's payWallet helper. Flips the order PENDING -> CONFIRMED as a side effect (see payments.service.js#payWithWallet). */
async function payWallet(customerAuth, orderId) {
  const res = await api.post(`${PREFIX}/payments`).set('Authorization', customerAuth).send({ orderId, method: 'WALLET' });
  return res.body.data;
}

/** Checks out `qty` of `storeProduct`, pays via WALLET, and drives the order all the way to DELIVERED (triggers settlement). Unlike `fullyDeliverOrder` below, this leaves a real SUCCESS WALLET Payment behind, which the P2.8-A test needs in order to drive a real POST /orders/:id/refund afterward. */
async function payAndDeliverOrder(customerAuth, adminAuth, storeProduct, qty) {
  await api.post(`${PREFIX}/cart/items`).set('Authorization', customerAuth).send({ productId: storeProduct.id, qty });
  const created = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customerAuth).send({});
  const orderId = created.body.data.id;
  await payWallet(customerAuth, orderId);
  await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'PREPARING' });
  await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'SENT' });
  const res = await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'DELIVERED' });
  return { res, order: await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } }) };
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
    customer = await makeUser('CUSTOMER', uniqueMobileSuffix('00'));
    seller = await makeUser('SELLER', uniqueMobileSuffix('01'));
    admin = await makeUser('ADMIN', uniqueMobileSuffix('02'));
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
    // Isolated seller/store/product/wallet (not the shared `seller`): the
    // preceding 'partial recovery' test deliberately leaves an OUTSTANDING
    // leftover liability on the shared seller, which would otherwise sit
    // between this test's own older/newer liabilities in FIFO (createdAt)
    // order and consume the settlement earning meant for `newer` — same
    // isolation pattern as the 'concurrent settlements' test below.
    const fifoSeller = await makeUser('SELLER', uniqueMobileSuffix('03'));
    const fifoStore = await makeApprovedStore(fifoSeller.user.id, 'فروشگاه ترتیب FIFO');
    const fifoProduct = await makeApprovedProduct(fifoSeller.auth, admin.auth, category.id, { price: 40000, stock: 999 });
    await prisma.wallet.upsert({
      where: { userId: fifoSeller.user.id }, update: { balance: 0 }, create: { userId: fifoSeller.user.id, balance: 0 },
    });

    const dummyOrder = await fullyDeliverOrder(customer.auth, admin.auth, fifoProduct, 1);
    const now = Date.now();
    // Insert the NEWER one first, then the OLDER one, to prove ordering is by createdAt, not insertion order.
    const newer = await makeLiability(fifoSeller.user.id, dummyOrder.order.id, fifoStore.id, 10000, { createdAt: new Date(now) });
    const older = await makeLiability(fifoSeller.user.id, dummyOrder.order.id, fifoStore.id, 10000, { createdAt: new Date(now - 60000) });

    // sellerEarning=36000 covers older(10000) + newer(10000) fully, remainder 16000 to wallet.
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: fifoSeller.user.id } });
    const { order } = await fullyDeliverOrder(customer.auth, admin.auth, fifoProduct, 1);

    const olderAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: older.id } });
    const newerAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: newer.id } });
    expect(olderAfter.status).toBe('RECOVERED');
    expect(newerAfter.status).toBe('RECOVERED');

    // Verify the OLDER liability's recovery WalletTransaction was written before the newer one's.
    const olderTx = await prisma.walletTransaction.findFirst({ where: { refId: older.id, type: 'DEBIT' } });
    const newerTx = await prisma.walletTransaction.findFirst({ where: { refId: newer.id, type: 'DEBIT' } });
    expect(olderTx.createdAt.getTime()).toBeLessThanOrEqual(newerTx.createdAt.getTime());

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: fifoSeller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance) + 16000);
    void order;
  });

  test('recovery across multiple future settlements: a partially-recovered liability finishes recovering on a later settlement', async () => {
    // Isolated seller/store/product/wallet (not the shared `seller`): the
    // preceding 'partial recovery' test leaves an OUTSTANDING leftover
    // liability on the shared seller, and this test's own `dummyOrder`
    // settlement (needed only to obtain a valid orderId FK for
    // makeLiability, before this test's own liability even exists) would
    // otherwise partially recover into that leftover — corrupting the
    // 14000/22000/0 math below, which assumes this test's own liability is
    // the only OUTSTANDING one for its seller. Same isolation pattern as
    // the FIFO and 'concurrent settlements' tests.
    const multiSettleSeller = await makeUser('SELLER', uniqueMobileSuffix('04'));
    const multiSettleStore = await makeApprovedStore(multiSettleSeller.user.id, 'فروشگاه تسویه چندگانه');
    const multiSettleProduct = await makeApprovedProduct(multiSettleSeller.auth, admin.auth, category.id, { price: 40000, stock: 999 });
    await prisma.wallet.upsert({
      where: { userId: multiSettleSeller.user.id }, update: { balance: 0 }, create: { userId: multiSettleSeller.user.id, balance: 0 },
    });

    const dummyOrder = await fullyDeliverOrder(customer.auth, admin.auth, multiSettleProduct, 1);
    const liability = await makeLiability(multiSettleSeller.user.id, dummyOrder.order.id, multiSettleStore.id, 50000); // needs two 36000-earning settlements to clear

    const walletBefore = await prisma.wallet.findUnique({ where: { userId: multiSettleSeller.user.id } });

    await fullyDeliverOrder(customer.auth, admin.auth, multiSettleProduct, 1); // recovers 36000, remaining 14000
    const midLiability = await prisma.sellerPayoutLiability.findUnique({ where: { id: liability.id } });
    expect(midLiability.status).toBe('OUTSTANDING');
    expect(Number(midLiability.amount)).toBe(14000);

    await fullyDeliverOrder(customer.auth, admin.auth, multiSettleProduct, 1); // recovers remaining 14000, credits 22000 remainder
    const finalLiability = await prisma.sellerPayoutLiability.findUnique({ where: { id: liability.id } });
    expect(finalLiability.status).toBe('RECOVERED');
    expect(Number(finalLiability.amount)).toBe(0);

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: multiSettleSeller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance) + 22000); // 0 + 22000 credited total across both settlements
  });

  test('seller with no outstanding liability behaves exactly as before Phase 6', async () => {
    const freshSeller = await makeUser('SELLER', uniqueMobileSuffix('05'));
    const freshStore = await makeApprovedStore(freshSeller.user.id, 'فروشگاه بدون بدهی');
    const freshProduct = await makeApprovedProduct(freshSeller.auth, admin.auth, category.id, { price: 40000, stock: 999 });
    void freshStore;
    await prisma.wallet.upsert({
      where: { userId: freshSeller.user.id }, update: { balance: 0 }, create: { userId: freshSeller.user.id, balance: 0 },
    });

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
    const sellerB = await makeUser('SELLER', uniqueMobileSuffix('06'));
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
    const racer = await makeUser('SELLER', uniqueMobileSuffix('07'));
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
    seller = await makeUser('SELLER', uniqueMobileSuffix('08'));
    admin = await makeUser('ADMIN', uniqueMobileSuffix('09'));
  });

  test('payout is capped at wallet.balance - outstandingLiabilityTotal', async () => {
    await prisma.wallet.upsert({
      where: { userId: seller.user.id }, update: { balance: 500000 }, create: { userId: seller.user.id, balance: 500000 },
    });
    const store = await makeApprovedStore(seller.user.id, 'فروشگاه سقف برداشت');
    // Need a real order/store FK for the liability row.
    const customer = await makeUser('CUSTOMER', uniqueMobileSuffix('10'));
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
    const racer = await makeUser('SELLER', uniqueMobileSuffix('11'));
    const store = await makeApprovedStore(racer.user.id, 'فروشگاه بدهی کامل');
    const customer = await makeUser('CUSTOMER', uniqueMobileSuffix('12'));
    const category = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته بدهی کامل', slug: `payout-full-liability-cat-${Date.now()}` });
    const product = await makeApprovedProduct(racer.auth, admin.auth, category.body.data.id, { price: 10000, stock: 999 });
    await prisma.wallet.create({ data: { userId: racer.user.id, balance: 0 } });
    const { order } = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    await prisma.wallet.update({ where: { userId: racer.user.id }, data: { balance: 500 } });
    await makeLiability(racer.user.id, order.id, store.id, 500);

    const res = await api.post(`${PREFIX}/payouts`).set('Authorization', racer.auth).send({ amount: 1, ...validBank() });
    expect(res.status).toBe(400);
  });

  test('payout works normally when liability = 0 (unchanged pre-Phase-6 behavior)', async () => {
    const racer = await makeUser('SELLER', uniqueMobileSuffix('13'));
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
    seller = await makeUser('SELLER', uniqueMobileSuffix('14'));
    admin = await makeUser('ADMIN', uniqueMobileSuffix('15'));
    store = await makeApprovedStore(seller.user.id, 'فروشگاه نمایش بدهی');
    await prisma.wallet.upsert({
      where: { userId: seller.user.id }, update: { balance: 0 }, create: { userId: seller.user.id, balance: 0 },
    });
  });

  test('GET /admin/payout-liabilities lists liabilities with status/seller filters and pagination', async () => {
    const customer = await makeUser('CUSTOMER', uniqueMobileSuffix('16'));
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
    const customer = await makeUser('CUSTOMER', uniqueMobileSuffix('17'));
    const res = await api.get(`${PREFIX}/admin/payout-liabilities`).set('Authorization', customer.auth);
    expect(res.status).toBe(403);
  });

  test('there is no manual-recovery endpoint (Phase 6 is automatic-only)', async () => {
    const customer = await makeUser('CUSTOMER', uniqueMobileSuffix('18'));
    const category = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته بدون بازیابی دستی', slug: `no-manual-recovery-cat-${Date.now()}` });
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.body.data.id, { price: 10000, stock: 999 });
    const { order } = await fullyDeliverOrder(customer.auth, admin.auth, product, 1);
    const liability = await makeLiability(seller.user.id, order.id, store.id, 5000);

    const res = await api.patch(`${PREFIX}/admin/payout-liabilities/${liability.id}/recover`).set('Authorization', admin.auth);
    expect([404, 403]).toContain(res.status); // no such route wired anywhere
  });
});

/**
 * P2.8-A — Receivable-backed liability recovery, end to end.
 *
 * Every recovery scenario above uses `makeLiability()`, which inserts a
 * SellerPayoutLiability directly and therefore never has a
 * `ledgerReceivableEntryId` — it always exercises
 * recoverSellerLiabilities' legacy `receivableBacked: false` branch
 * (CREDIT PLATFORM_CASH). order-refund.test.js's test E already proves a
 * REAL delivered-WALLET-refund-with-shortfall creates the liability with
 * its PLATFORM_RECEIVABLE leg correctly; ledger.service.test.js's own
 * P2.9 test already proves postLiabilityRecovery's receivableBacked:
 * true branch credits PLATFORM_RECEIVABLE in isolation. Neither proves
 * the two are wired together end to end. This test is the missing link:
 * a real refund-created, receivable-backed liability, recovered by a
 * real later settlement, posting a real LIABILITY_RECOVERY Journal with
 * a PLATFORM_RECEIVABLE credit leg — see
 * payout-liabilities.service.js#recoverSellerLiabilities' own comment on
 * `receivableBacked: liability.ledgerReceivableEntryId != null`.
 */
describe('P2.8-A — Receivable-backed liability recovery (real refund -> real settlement)', () => {
  async function findJournal(eventType, eventId) {
    return prisma.journal.findUnique({ where: { eventType_eventId: { eventType, eventId } } });
  }

  async function entriesFor(journalId) {
    return prisma.ledgerEntry.findMany({ where: { journalId }, include: { account: true } });
  }

  test('a real refund-created receivable-backed liability recovers into PLATFORM_RECEIVABLE on a real future settlement', async () => {
    // Dedicated seller/store/product/customer — isolates this liability
    // (and the receivable it claims) from every other test in this file,
    // same rationale as the FIFO / multi-settlement / concurrent-settlement
    // tests above (and as sellerE in order-refund.test.js's test E).
    const customerR = await makeUser('CUSTOMER', uniqueMobileSuffix('19'));
    await prisma.wallet.create({ data: { userId: customerR.user.id, balance: 100000000 } });
    const sellerR = await makeUser('SELLER', uniqueMobileSuffix('20'));
    await prisma.wallet.create({ data: { userId: sellerR.user.id, balance: 0 } });
    const adminR = await makeUser('ADMIN', uniqueMobileSuffix('21'));
    await makeApprovedStore(sellerR.user.id, 'فروشگاه بازیابی مطالبات');
    const categoryR = await api.post(`${PREFIX}/categories`).set('Authorization', adminR.auth)
      .send({ name: 'دسته بازیابی مطالبات', slug: `receivable-recovery-cat-${Date.now()}` });
    const existingGlobal = await prisma.commissionRule.findFirst({ where: { scope: 'GLOBAL', isActive: true } });
    if (!existingGlobal) {
      await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', adminR.auth).send({ scope: 'GLOBAL', rate: 10 });
    }
    const productR = await makeApprovedProduct(sellerR.auth, adminR.auth, categoryR.body.data.id, { price: 100000, stock: 999 });

    // Step 1 — REAL delivered WALLET order, forced to a full shortfall so
    // the refund clawback creates a liability (mirrors order-refund
    // test E exactly, just with this file's own fixtures/helpers).
    const { order: refundedOrder } = await payAndDeliverOrder(customerR.auth, adminR.auth, productR, 1);
    const item = refundedOrder.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });
    await prisma.wallet.update({ where: { userId: sellerR.user.id }, data: { balance: 0 } }); // force full shortfall

    // Step 2 — REAL refund. Produces the SellerPayoutLiability with its
    // ledgerReceivableEntryId set (P2.9 — Model C), not `makeLiability()`.
    const refundRes = await api.post(`${PREFIX}/orders/${refundedOrder.id}/refund`).set('Authorization', adminR.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(refundRes.status).toBe(200);

    const refund = await prisma.paymentRefund.findUnique({ where: { id: refundRes.body.data.refund.id } });
    const liability = await prisma.sellerPayoutLiability.findFirst({
      where: { orderId: refundedOrder.id, sellerId: sellerR.user.id, refundId: refund.id },
    });
    expect(liability).not.toBeNull();
    expect(liability.status).toBe('OUTSTANDING');
    expect(liability.ledgerReceivableEntryId).not.toBeNull(); // the precondition recoverSellerLiabilities checks
    expect(Number(liability.amount)).toBe(Number(settlement.sellerEarning)); // full shortfall, nothing collected yet

    // Step 3 — REAL future settlement for the same seller. gross=100000,
    // commission 10% -> sellerEarning=90000, which fully covers the
    // liability (also 90000, since the refunded order was the seller's
    // only prior settlement) with nothing left over for the wallet.
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: sellerR.user.id } });
    const { order: settledOrder } = await fullyDeliverOrder(customerR.auth, adminR.auth, productR, 1);
    const recoverySettlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: settledOrder.items[0].id } });

    // Step 4 — the liability lifecycle closed correctly.
    const liabilityAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: liability.id } });
    expect(liabilityAfter.status).toBe('RECOVERED');
    expect(Number(liabilityAfter.amount)).toBe(0);
    expect(liabilityAfter.recoveredAt).not.toBeNull();

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: sellerR.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance)); // fully absorbed by the liability, nothing credited

    const recoveryDebitTx = await prisma.walletTransaction.findFirst({ where: { refId: liability.id, type: 'DEBIT' } });
    expect(recoveryDebitTx).not.toBeNull();
    expect(Number(recoveryDebitTx.amount)).toBe(Number(settlement.sellerEarning));

    // Step 5 — the actual assertion this test exists for: the
    // LIABILITY_RECOVERY Journal posted PLATFORM_RECEIVABLE, not
    // PLATFORM_CASH, because this liability's ledgerReceivableEntryId
    // was set. eventId is the deterministic composite this recovery
    // pass used — see recoverSellerLiabilities' own comment.
    const recoveryJournal = await findJournal('LIABILITY_RECOVERY', `${recoverySettlement.id}:${liability.id}`);
    expect(recoveryJournal).not.toBeNull();

    const recoveryEntries = await entriesFor(recoveryJournal.id);
    expect(recoveryEntries).toHaveLength(2);
    const debitLeg = recoveryEntries.find((e) => e.direction === 'DEBIT');
    const creditLeg = recoveryEntries.find((e) => e.direction === 'CREDIT');

    expect(debitLeg.account.ownerType).toBe('SELLER_WALLET');
    expect(debitLeg.account.ownerId).toBe(sellerR.user.id);
    expect(Number(debitLeg.amount)).toBe(Number(settlement.sellerEarning));

    expect(creditLeg.account.ownerType).toBe('PLATFORM_RECEIVABLE'); // not PLATFORM_CASH — the whole point of P2.8-A
    expect(creditLeg.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(Number(creditLeg.amount)).toBe(Number(settlement.sellerEarning));

    // Balanced: CREDIT total === DEBIT total.
    const creditTotal = recoveryEntries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + Number(e.amount), 0);
    const debitTotal = recoveryEntries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + Number(e.amount), 0);
    expect(debitTotal).toBe(creditTotal);

    // Sanity check against the REFUND journal's own PLATFORM_RECEIVABLE
    // leg (the claim this recovery is paying down): same account.
    const refundJournal = await findJournal('REFUND', refund.id);
    const refundEntries = await entriesFor(refundJournal.id);
    const refundReceivableLeg = refundEntries.find((e) => e.account.ownerType === 'PLATFORM_RECEIVABLE');
    expect(refundReceivableLeg.account.id).toBe(creditLeg.account.id);
  });
});

/**
 * P2.8-D1 — Financial lifecycle reconciliation: Settlement -> seller wallet
 * credit -> existing seller liability recovery -> LIABILITY_RECOVERY
 * posting -> Wallet/Ledger reconciliation.
 *
 * Every prior test in this file (and P2.8-A above) inspects one Journal's
 * legs in isolation. This test instead reconstructs the seller's whole
 * SELLER_WALLET Ledger Account balance from its full LedgerEntry history
 * and proves it reconciles exactly against the real Wallet.balance — the
 * design doc §5/§11.5 invariant the cached Account.balance column exists
 * to uphold.
 *
 * The liability here is created the same way P2.8-A's is: through a REAL
 * refund clawback shortfall, never `makeLiability()`. But unlike P2.8-A
 * (which forces the shortfall via a raw `prisma.wallet.update({balance:
 * 0})`, breaking the wallet/ledger identity for that seller on purpose —
 * fine there, since P2.8-A only inspects one Journal's legs), this test
 * needs the identity to hold from a clean start all the way through, so it
 * forces the same shortfall a different, real way: the seller withdraws
 * their settlement via a genuine payout first (same pattern as
 * order-refund.test.js's "seller withdraws their full settlement via a
 * payout..." test) — a real ledger-posting operation, not a raw column
 * write — leaving the wallet legitimately empty when the refund lands.
 *
 * P2.8-D2 extends the same test in place (no new lifecycle): after the
 * reconciliation above, it replays the DELIVERED transition that drove
 * the recovery, through the real API/state-machine, and re-checks that
 * the replay posts no second Journal, moves no additional Wallet balance,
 * and that the three-way reconciliation still holds unchanged.
 */
describe('P2.8-D1 — Financial lifecycle reconciliation (settlement -> recovery -> wallet/ledger identity)', () => {
  async function findJournal(eventType, eventId) {
    return prisma.journal.findUnique({ where: { eventType_eventId: { eventType, eventId } } });
  }

  async function entriesFor(journalId) {
    return prisma.ledgerEntry.findMany({ where: { journalId }, include: { account: true } });
  }

  test('settlement credit, real payout withdrawal, refund shortfall liability, and its recovery on a later settlement all reconcile to the real Wallet.balance', async () => {
    // Dedicated seller/store/product/customer, isolated from every other
    // test in this file — same rationale as P2.8-A above. This seller's
    // wallet never receives a raw/manual balance write anywhere in this
    // test, so the SELLER_WALLET Ledger Account's cached balance stays
    // reconcilable against the real Wallet.balance at every step.
    const customerD = await makeUser('CUSTOMER', uniqueMobileSuffix('22'));
    await prisma.wallet.create({ data: { userId: customerD.user.id, balance: 100000000 } });
    const sellerD = await makeUser('SELLER', uniqueMobileSuffix('23'));
    await prisma.wallet.create({ data: { userId: sellerD.user.id, balance: 0 } });
    const adminD = await makeUser('ADMIN', uniqueMobileSuffix('24'));
    await makeApprovedStore(sellerD.user.id, 'فروشگاه تطبیق مالی');
    const categoryD = await api.post(`${PREFIX}/categories`).set('Authorization', adminD.auth)
      .send({ name: 'دسته تطبیق مالی', slug: `reconciliation-cat-${Date.now()}` });
    const existingGlobal = await prisma.commissionRule.findFirst({ where: { scope: 'GLOBAL', isActive: true } });
    if (!existingGlobal) {
      await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', adminD.auth).send({ scope: 'GLOBAL', rate: 10 });
    }
    const productD = await makeApprovedProduct(sellerD.auth, adminD.auth, categoryD.body.data.id, { price: 100000, stock: 999 });

    // Step 1 — REAL delivered WALLET order #1: gross=100000, commission
    // 10% -> sellerEarning=90000, credited to the wallet via a real
    // SETTLEMENT Journal (SELLER_WALLET CREDIT leg).
    const { order: firstOrder } = await payAndDeliverOrder(customerD.auth, adminD.auth, productD, 1);
    const firstItem = firstOrder.items[0];
    const firstSettlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: firstItem.id } });
    expect(Number(firstSettlement.sellerEarning)).toBe(90000);

    const walletAfterFirstSettlement = await prisma.wallet.findUnique({ where: { userId: sellerD.user.id } });
    expect(Number(walletAfterFirstSettlement.balance)).toBe(90000);

    // Step 2 — REAL payout withdrawal of the full balance (Phase 5
    // createPayout — posts a real PAYOUT_RESERVE Journal, SELLER_WALLET
    // DEBIT leg), leaving the wallet legitimately empty.
    const payoutRes = await api.post(`${PREFIX}/payouts`).set('Authorization', sellerD.auth).send({
      amount: 90000,
      bankAccountHolder: 'علی رضایی',
      bankIban: 'IR820540102680020817909002',
      bankCardNumber: '6037991234567890',
    });
    expect(payoutRes.status).toBe(201);
    const walletAfterPayout = await prisma.wallet.findUnique({ where: { userId: sellerD.user.id } });
    expect(Number(walletAfterPayout.balance)).toBe(0);

    // Step 3 — REAL refund of order #1. The wallet has nothing left, so
    // the full 90000 clawback shortfalls: a receivable-backed
    // SellerPayoutLiability is created for the uncollected remainder (no
    // additional SELLER_WALLET leg is posted here — there is nothing left
    // to debit).
    const refundRes = await api.post(`${PREFIX}/orders/${firstOrder.id}/refund`).set('Authorization', adminD.auth)
      .send({ items: [{ orderItemId: firstItem.id, qty: 1 }] });
    expect(refundRes.status).toBe(200);

    const refund = await prisma.paymentRefund.findUnique({ where: { id: refundRes.body.data.refund.id } });
    const liability = await prisma.sellerPayoutLiability.findFirst({
      where: { orderId: firstOrder.id, sellerId: sellerD.user.id, refundId: refund.id },
    });
    expect(liability).not.toBeNull();
    expect(liability.status).toBe('OUTSTANDING');
    expect(Number(liability.amount)).toBe(90000);

    const walletAfterRefund = await prisma.wallet.findUnique({ where: { userId: sellerD.user.id } });
    expect(Number(walletAfterRefund.balance)).toBe(0); // never went negative, nothing to give back from an empty wallet

    // Step 4 — REAL future settlement for the same seller (order #2, same
    // gross/commission), recovering the existing liability. postSettlement
    // posts the FULL sellerEarning as a SELLER_WALLET CREDIT; because the
    // liability exactly equals that earning, recoverSellerLiabilities'
    // own LIABILITY_RECOVERY Journal then debits the SAME amount straight
    // back out — nothing left over for the wallet.
    const { order: secondOrder } = await payAndDeliverOrder(customerD.auth, adminD.auth, productD, 1);
    const secondItem = secondOrder.items[0];
    const secondSettlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: secondItem.id } });
    expect(Number(secondSettlement.sellerEarning)).toBe(90000);

    const liabilityAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: liability.id } });
    expect(liabilityAfter.status).toBe('RECOVERED');
    expect(Number(liabilityAfter.amount)).toBe(0);

    const walletFinal = await prisma.wallet.findUnique({ where: { userId: sellerD.user.id } });
    expect(Number(walletFinal.balance)).toBe(0); // fully absorbed by the liability, nothing credited

    // --- Reconciliation ---------------------------------------------

    // 1) Read the seller Wallet, the seller SELLER_WALLET Ledger Account,
    // and every LedgerEntry row posted against that account.
    const sellerLedgerAccount = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'SELLER_WALLET', ownerId: sellerD.user.id, currency: 'TMN' } },
    });
    expect(sellerLedgerAccount).not.toBeNull();
    const sellerLedgerEntries = await prisma.ledgerEntry.findMany({ where: { accountId: sellerLedgerAccount.id } });
    // The four legs posted above: SETTLEMENT #1 CREDIT, PAYOUT_RESERVE
    // DEBIT, SETTLEMENT #2 CREDIT, LIABILITY_RECOVERY DEBIT. The refund's
    // own REFUND Journal posts no SELLER_WALLET leg (full shortfall).
    expect(sellerLedgerEntries).toHaveLength(4);

    // 2) Reconstruct the seller Ledger balance from that LedgerEntry
    // history: SUM(CREDIT) - SUM(DEBIT).
    const reconstructedBalance = sellerLedgerEntries.reduce(
      (sum, e) => sum + (e.direction === 'CREDIT' ? Number(e.amount) : -Number(e.amount)),
      0,
    );
    expect(reconstructedBalance).toBe(0); // 90000 - 90000 + 90000 - 90000

    // 3) reconstructed Ledger balance === Account.balance (the cached column).
    expect(reconstructedBalance).toBe(Number(sellerLedgerAccount.balance));

    // 4) Account.balance === actual Wallet.balance.
    expect(Number(sellerLedgerAccount.balance)).toBe(Number(walletFinal.balance));

    // 5) The recovery settlement's SETTLEMENT CREDIT and LIABILITY_RECOVERY
    // DEBIT together equal the actual seller wallet increase across that
    // settlement (here: fully offsetting, so the increase is exactly 0).
    const secondSettlementJournal = await findJournal('SETTLEMENT', secondSettlement.id);
    const secondSettlementEntries = await entriesFor(secondSettlementJournal.id);
    const secondSettlementSellerLeg = secondSettlementEntries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    expect(secondSettlementSellerLeg.direction).toBe('CREDIT');
    expect(Number(secondSettlementSellerLeg.amount)).toBe(90000);

    const recoveryJournal = await findJournal('LIABILITY_RECOVERY', `${secondSettlement.id}:${liability.id}`);
    expect(recoveryJournal).not.toBeNull();
    const recoveryEntries = await entriesFor(recoveryJournal.id);
    const recoveryDebitLeg = recoveryEntries.find((e) => e.direction === 'DEBIT');
    const recoveryCreditLeg = recoveryEntries.find((e) => e.direction === 'CREDIT');
    expect(recoveryDebitLeg.account.ownerType).toBe('SELLER_WALLET');
    expect(Number(recoveryDebitLeg.amount)).toBe(90000);

    const walletIncreaseAcrossRecoverySettlement = Number(walletFinal.balance) - Number(walletAfterRefund.balance);
    expect(Number(secondSettlementSellerLeg.amount) - Number(recoveryDebitLeg.amount)).toBe(walletIncreaseAcrossRecoverySettlement);

    // 6) The LIABILITY_RECOVERY Journal itself: DEBIT SELLER_WALLET,
    // CREDIT PLATFORM_RECEIVABLE (this liability's ledgerReceivableEntryId
    // was set by the real refund shortfall in step 3), balanced totals.
    expect(recoveryEntries).toHaveLength(2);
    expect(recoveryDebitLeg.account.ownerId).toBe(sellerD.user.id);
    expect(recoveryCreditLeg.account.ownerType).toBe('PLATFORM_RECEIVABLE');
    expect(recoveryCreditLeg.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(Number(recoveryCreditLeg.amount)).toBe(90000);
    const recoveryDebitTotal = recoveryEntries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + Number(e.amount), 0);
    const recoveryCreditTotal = recoveryEntries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + Number(e.amount), 0);
    expect(recoveryDebitTotal).toBe(recoveryCreditTotal);

    // --- P2.8-D2: replay idempotency ---------------------------------
    //
    // Replay the SAME DELIVERED transition that drove step 4's settlement
    // + recovery above, through the real API/state-machine mechanism (no
    // direct Journal/LedgerEntry manipulation). By the time this runs,
    // secondOrder.status is already DELIVERED, so ORDER_TRANSITIONS
    // (DELIVERED: []) rejects the replay before settleDeliveredOrder can
    // run a second time — see orders.service.js#updateStatus's own
    // ORDER_TRANSITIONS check, the same guard payouts.service.js's
    // assertIdempotentOrThrowInvalidTransition mirrors for payouts.
    const replayRes = await api.patch(`${PREFIX}/orders/${secondOrder.id}/status`).set('Authorization', adminD.auth).send({ status: 'DELIVERED' });
    expect(replayRes.status).toBe(409);

    // No second LIABILITY_RECOVERY Journal for the same eventType/eventId.
    const recoveryJournalsAfterReplay = await prisma.journal.findMany({
      where: { eventType: 'LIABILITY_RECOVERY', eventId: `${secondSettlement.id}:${liability.id}` },
    });
    expect(recoveryJournalsAfterReplay).toHaveLength(1);

    // No additional Wallet movement.
    const walletAfterReplay = await prisma.wallet.findUnique({ where: { userId: sellerD.user.id } });
    expect(Number(walletAfterReplay.balance)).toBe(Number(walletFinal.balance));

    // Re-read Wallet.balance, the SELLER_WALLET Account.balance, and the
    // full LedgerEntry history, and recompute SUM(CREDIT) - SUM(DEBIT).
    const sellerLedgerAccountAfterReplay = await prisma.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType: 'SELLER_WALLET', ownerId: sellerD.user.id, currency: 'TMN' } },
    });
    const sellerLedgerEntriesAfterReplay = await prisma.ledgerEntry.findMany({ where: { accountId: sellerLedgerAccountAfterReplay.id } });
    expect(sellerLedgerEntriesAfterReplay).toHaveLength(4); // still the same 4 legs — nothing new posted by the rejected replay

    const reconstructedBalanceAfterReplay = sellerLedgerEntriesAfterReplay.reduce(
      (sum, e) => sum + (e.direction === 'CREDIT' ? Number(e.amount) : -Number(e.amount)),
      0,
    );
    expect(reconstructedBalanceAfterReplay).toBe(reconstructedBalance); // unchanged from before the replay

    // All three remain identical after the replay: reconstructed Ledger
    // balance === Account.balance === Wallet.balance.
    expect(reconstructedBalanceAfterReplay).toBe(Number(sellerLedgerAccountAfterReplay.balance));
    expect(Number(sellerLedgerAccountAfterReplay.balance)).toBe(Number(walletAfterReplay.balance));
  });
});
