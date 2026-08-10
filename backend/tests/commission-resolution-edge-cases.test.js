/**
 * P1 Phase 2 — Commission Engine edge-case coverage.
 *
 * Continuation of commission-resolution.test.js (which locks in the core
 * tier precedence and CAMPAIGN specificity ordering). This file covers the
 * gaps that suite's own docblock explicitly left for later:
 *
 *   - Product.categoryId === null: CATEGORY tier must be skipped (not
 *     crash, not silently match every category), with GLOBAL and unscoped
 *     CAMPAIGN fallback still working — tested both by calling
 *     resolveCommissionRate() directly AND through a real end-to-end
 *     checkout -> DELIVERED settlement for a product with no category.
 *   - Exact CAMPAIGN boundary instants: now === campaignStartAt and
 *     now === campaignEndAt both match (inclusive [start, end], already
 *     approved business behavior); one second outside either edge does not.
 *   - An in-window but isActive:false CAMPAIGN does not block fall-through
 *     to the next applicable tier.
 *   - Two active CAMPAIGN rules of equal specificity: higher `priority`
 *     wins; with priority also equal, the more recently created rule wins.
 *   - Multiple active GLOBAL rules: same priority-then-createdAt tie-break
 *     as every other tier.
 *
 * Same ground rules as commission-resolution.test.js: rules are created
 * through the real admin API (POST /admin/commission-rules), nothing about
 * the Commission Engine is mocked, and resolveCommissionRate() is called
 * directly except where the test is explicitly about the settlement path.
 *
 * Requires a real Postgres database (DATABASE_URL), migrated + seeded:
 *   NODE_ENV=test npm test
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');
const { resolveCommissionRate } = require('../src/modules/commission-rules/commission-rules.service');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

let roles;
let admin;

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

async function makeSellerStore(mobileSuffix, name) {
  const seller = await makeUser('SELLER', mobileSuffix);
  const store = await prisma.store.create({
    data: {
      sellerId: seller.user.id,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'APPROVED',
    },
  });
  return { seller, store };
}

/** Same fixture pattern as commission-resolution.test.js: Persian `name`, separate ASCII `slug`. */
async function makeCategory(name, slugPrefix) {
  const res = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
    .send({ name, slug: `${slugPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  expect(res.status).toBe(201);
  return res.body.data;
}

async function createRule(payload) {
  const res = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send(payload);
  expect(res.status).toBe(201);
  return res.body.data;
}

/** Creates a StoreProduct with NO categoryId — products.validation.js's createSchema treats categoryId as optional. */
async function makeApprovedProductNoCategory(sellerAuth, adminAuth, overrides = {}) {
  const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerAuth).send({
    name: 'محصول بدون دسته‌بندی', price: 15000, stock: 10, ...overrides,
  });
  expect(created.status).toBe(201);
  expect(created.body.data.product?.categoryId ?? null).toBeNull();
  const id = created.body.data.id;
  const moderated = await api.patch(`${PREFIX}/products/${id}/moderate`).set('Authorization', adminAuth).send({ status: 'APPROVED' });
  expect(moderated.status).toBe(200);
  return prisma.storeProduct.findUnique({ where: { id } });
}

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
  if (!roles.ADMIN || !roles.SELLER || !roles.CUSTOMER) {
    throw new Error('Roles are not seeded — run `npm run seed` against the test database first.');
  }
  admin = await makeUser('ADMIN', '55000000' + Math.floor(Math.random() * 9));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Commission Engine resolution — categoryId is null', () => {
  test('resolveCommissionRate(sellerId, null) skips CATEGORY entirely and falls to GLOBAL, no crash', async () => {
    const { store } = await makeSellerStore('55010000' + Math.floor(Math.random() * 9), 'فروشگاه بدون دسته ۱');
    // A CATEGORY rule exists in the system (for some other category) — it
    // must never accidentally match a null categoryId lookup.
    const otherCategory = await makeCategory('دسته دیگر ۱', 'null-cat-other-1');
    await createRule({ scope: 'GLOBAL', rate: 12 });
    await createRule({ scope: 'CATEGORY', categoryId: otherCategory.id, rate: 99 });

    const { rate, rule } = await resolveCommissionRate(store.id, null);
    expect(Number(rate)).toBe(12);
    expect(rule.scope).toBe('GLOBAL');
  });

  test('resolveCommissionRate(sellerId, null) still lets SELLER win over GLOBAL', async () => {
    const { store } = await makeSellerStore('55020000' + Math.floor(Math.random() * 9), 'فروشگاه بدون دسته ۲');
    await createRule({ scope: 'GLOBAL', rate: 12 });
    await createRule({ scope: 'SELLER', sellerId: store.id, rate: 35 });

    const { rate, rule } = await resolveCommissionRate(store.id, null);
    expect(Number(rate)).toBe(35);
    expect(rule.scope).toBe('SELLER');
  });

  test('resolveCommissionRate(sellerId, null) still lets an unscoped CAMPAIGN win, but a category-scoped CAMPAIGN cannot match', async () => {
    const { store } = await makeSellerStore('55030000' + Math.floor(Math.random() * 9), 'فروشگاه بدون دسته ۳');
    const otherCategory = await makeCategory('دسته دیگر ۳', 'null-cat-other-3');
    const now = new Date();
    const campaignStartAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const campaignEndAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    await createRule({ scope: 'GLOBAL', rate: 12 });
    // Scoped to a category the product does NOT have — must not match a null categoryId lookup.
    await createRule({
      scope: 'CAMPAIGN', categoryId: otherCategory.id, rate: 77, campaignStartAt, campaignEndAt,
    });
    const unscopedCampaign = await createRule({
      scope: 'CAMPAIGN', rate: 45, campaignStartAt, campaignEndAt,
    });

    const { rate, rule } = await resolveCommissionRate(store.id, null);
    expect(Number(rate)).toBe(45);
    expect(rule.id).toBe(unscopedCampaign.id);

    // This CAMPAIGN rule is fully unscoped (no sellerId, no categoryId), so
    // as the highest-precedence tier it would match ANY seller/category
    // lookup made by later tests for the remainder of its 1h window. Only
    // this specific rule (by id) is deactivated — no other rule, from this
    // test or any other suite, is touched.
    await prisma.commissionRule.update({ where: { id: unscopedCampaign.id }, data: { isActive: false } });
  });

  test('end-to-end: a product with no category settles correctly against GLOBAL through checkout -> DELIVERED', async () => {
    const customer = await makeUser('CUSTOMER', '55040000' + Math.floor(Math.random() * 9));
    const { seller, store } = await makeSellerStore('55050000' + Math.floor(Math.random() * 9), 'فروشگاه تسویه بدون دسته');
    await prisma.wallet.create({ data: { userId: seller.user.id } });
    // Isolate this test's own GLOBAL rule set: deactivate whatever GLOBAL
    // rules other suites/tests left active in this shared DB, then create
    // exactly one known-rate active GLOBAL rule, so the settlement's rate
    // assertion below is deterministic regardless of test run order.
    await prisma.commissionRule.updateMany({ where: { scope: 'GLOBAL', isActive: true }, data: { isActive: false } });
    const globalRule = await createRule({ scope: 'GLOBAL', rate: 8 });

    const noCategoryProduct = await makeApprovedProductNoCategory(seller.auth, admin.auth, { price: 25000, stock: 5 });
    expect(store.id).toBe(noCategoryProduct.storeId);

    const order = await checkoutToSent(customer.auth, admin.auth, noCategoryProduct, 1);
    const delivered = await api.patch(`${PREFIX}/orders/${order.id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });
    expect(delivered.status).toBe(200);
    expect(delivered.body.data.status).toBe('DELIVERED');

    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: order.items[0].id } });
    expect(settlement).not.toBeNull();
    expect(settlement.commissionRuleId).toBe(globalRule.id);
    expect(Number(settlement.commissionRate)).toBe(8);
    expect(Number(settlement.grossAmount)).toBe(25000); // price * qty(1)
    expect(Number(settlement.commissionAmount)).toBe(2000); // round(25000*8/100)
    expect(Number(settlement.sellerEarning)).toBe(23000);

    // Restore a baseline active GLOBAL rule so later tests/files in this
    // shared DB aren't left with zero active GLOBAL rules.
    await createRule({ scope: 'GLOBAL', rate: 10 });
  });
});

describe('Commission Engine resolution — exact CAMPAIGN boundary instants', () => {
  test('now === campaignStartAt: campaign applies (inclusive lower bound)', async () => {
    const { store } = await makeSellerStore('55060000' + Math.floor(Math.random() * 9), 'فروشگاه مرز شروع کمپین');
    const category = await makeCategory('دسته مرز شروع کمپین', 'boundary-start');
    const start = new Date();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    await createRule({ scope: 'GLOBAL', rate: 10 });
    const campaign = await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 50, campaignStartAt: start.toISOString(), campaignEndAt: end.toISOString(),
    });

    const { rate, rule } = await resolveCommissionRate(store.id, category.id, start);
    expect(Number(rate)).toBe(50);
    expect(rule.id).toBe(campaign.id);
  });

  test('now === campaignEndAt: campaign applies (inclusive upper bound)', async () => {
    const { store } = await makeSellerStore('55070000' + Math.floor(Math.random() * 9), 'فروشگاه مرز پایان کمپین');
    const category = await makeCategory('دسته مرز پایان کمپین', 'boundary-end');
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date();
    await createRule({ scope: 'GLOBAL', rate: 10 });
    const campaign = await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 55, campaignStartAt: start.toISOString(), campaignEndAt: end.toISOString(),
    });

    const { rate, rule } = await resolveCommissionRate(store.id, category.id, end);
    expect(Number(rate)).toBe(55);
    expect(rule.id).toBe(campaign.id);
  });

  test('now = start - 1s: campaign does not yet apply, falls through to GLOBAL', async () => {
    const { store } = await makeSellerStore('55080000' + Math.floor(Math.random() * 9), 'فروشگاه قبل از شروع کمپین');
    const category = await makeCategory('دسته قبل از شروع کمپین', 'boundary-before-start');
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    await createRule({ scope: 'GLOBAL', rate: 10 });
    await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 60, campaignStartAt: start.toISOString(), campaignEndAt: end.toISOString(),
    });

    const before = new Date(start.getTime() - 1000);
    const { rate, rule } = await resolveCommissionRate(store.id, category.id, before);
    expect(Number(rate)).toBe(10);
    expect(rule.scope).toBe('GLOBAL');
  });

  test('now = end + 1s: campaign no longer applies, falls through to GLOBAL', async () => {
    const { store } = await makeSellerStore('55090000' + Math.floor(Math.random() * 9), 'فروشگاه بعد از پایان کمپین');
    const category = await makeCategory('دسته بعد از پایان کمپین', 'boundary-after-end');
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const end = new Date(Date.now() - 60 * 60 * 1000);
    await createRule({ scope: 'GLOBAL', rate: 10 });
    await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 65, campaignStartAt: start.toISOString(), campaignEndAt: end.toISOString(),
    });

    const after = new Date(end.getTime() + 1000);
    const { rate, rule } = await resolveCommissionRate(store.id, category.id, after);
    expect(Number(rate)).toBe(10);
    expect(rule.scope).toBe('GLOBAL');
  });
});

describe('Commission Engine resolution — inactive CAMPAIGN fall-through', () => {
  test('an in-window but inactive CAMPAIGN does not block SELLER from winning', async () => {
    const { store } = await makeSellerStore('55100000' + Math.floor(Math.random() * 9), 'فروشگاه کمپین غیرفعال');
    const category = await makeCategory('دسته کمپین غیرفعال', 'inactive-campaign');
    const now = new Date();
    const campaignStartAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const campaignEndAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    await createRule({ scope: 'GLOBAL', rate: 10 });
    await createRule({ scope: 'CATEGORY', categoryId: category.id, rate: 20 });
    const sellerRule = await createRule({ scope: 'SELLER', sellerId: store.id, rate: 30 });
    const inactiveCampaign = await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 90, campaignStartAt, campaignEndAt, isActive: false,
    });
    expect(inactiveCampaign.isActive).toBe(false);

    const { rate, rule } = await resolveCommissionRate(store.id, category.id);
    expect(Number(rate)).toBe(30);
    expect(rule.id).toBe(sellerRule.id);
    expect(rule.id).not.toBe(inactiveCampaign.id);
  });
});

describe('Commission Engine resolution — CAMPAIGN tie-break among equal-specificity rules', () => {
  test('two active same-specificity CAMPAIGN rules: higher priority wins', async () => {
    const { store } = await makeSellerStore('55110000' + Math.floor(Math.random() * 9), 'فروشگاه اولویت کمپین برابر');
    const category = await makeCategory('دسته اولویت کمپین برابر', 'campaign-priority-tie');
    const { campaignStartAt, campaignEndAt } = (() => {
      const now = new Date();
      return {
        campaignStartAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        campaignEndAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      };
    })();

    await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 40, priority: 5, campaignStartAt, campaignEndAt,
    });
    const higherPriority = await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 60, priority: 20, campaignStartAt, campaignEndAt,
    });

    const { rate, rule } = await resolveCommissionRate(store.id, category.id);
    expect(Number(rate)).toBe(60);
    expect(rule.id).toBe(higherPriority.id);
  });

  test('two active same-specificity, same-priority CAMPAIGN rules: the more recently created rule wins', async () => {
    const { store } = await makeSellerStore('55120000' + Math.floor(Math.random() * 9), 'فروشگاه اولویت کمپین یکسان');
    const category = await makeCategory('دسته اولویت کمپین یکسان', 'campaign-createdat-tie');
    const now = new Date();
    const campaignStartAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const campaignEndAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const older = await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 40, priority: 10, campaignStartAt, campaignEndAt,
    });
    // Backdate the first rule's createdAt directly via Prisma (no timers/
    // delays) so the second createRule() call is unambiguously "more
    // recent" without relying on real-clock ordering between two fast API
    // calls that could otherwise land in the same millisecond.
    await prisma.commissionRule.update({ where: { id: older.id }, data: { createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } });
    const newer = await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 45, priority: 10, campaignStartAt, campaignEndAt,
    });

    const { rate, rule } = await resolveCommissionRate(store.id, category.id);
    expect(Number(rate)).toBe(45);
    expect(rule.id).toBe(newer.id);
  });
});

describe('Commission Engine resolution — multiple active GLOBAL rules', () => {
  test('multiple active GLOBAL rules: higher priority wins', async () => {
    // Deactivate any pre-existing active GLOBAL rules from other suites so
    // this test's own two rules are the only candidates.
    await prisma.commissionRule.updateMany({ where: { scope: 'GLOBAL', isActive: true }, data: { isActive: false } });

    await createRule({ scope: 'GLOBAL', rate: 5, priority: 1 });
    const higherPriority = await createRule({ scope: 'GLOBAL', rate: 9, priority: 7 });

    const { rate, rule } = await resolveCommissionRate('nonexistent-seller-id-placeholder', null);
    expect(Number(rate)).toBe(9);
    expect(rule.id).toBe(higherPriority.id);

    // Restore a baseline active GLOBAL rule for any later tests/files.
    await createRule({ scope: 'GLOBAL', rate: 10 });
  });

  test('multiple active GLOBAL rules with equal priority: the more recently created rule wins', async () => {
    await prisma.commissionRule.updateMany({ where: { scope: 'GLOBAL', isActive: true }, data: { isActive: false } });
    const now = new Date();

    const older = await createRule({ scope: 'GLOBAL', rate: 6, priority: 3 });
    await prisma.commissionRule.update({ where: { id: older.id }, data: { createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } });
    const newer = await createRule({ scope: 'GLOBAL', rate: 7, priority: 3 });

    const { rate, rule } = await resolveCommissionRate(null, null);
    expect(Number(rate)).toBe(7);
    expect(rule.id).toBe(newer.id);

    // Restore a baseline active GLOBAL rule for any later tests/files.
    await createRule({ scope: 'GLOBAL', rate: 10 });
  });
});
