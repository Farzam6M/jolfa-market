/**
 * Test suite for Phase 3 — Seller Settlement Visibility + Admin Commission
 * Reporting. Built on top of Phase 1 (CommissionRule) and Phase 2 (Order
 * Settlement), both already covered by order-settlement.test.js.
 *
 * Covers:
 *   - GET /orders/settlements (seller): returns only the caller's own
 *     store's settlements, including order/item reference, store,
 *     commission rule, rate, gross/commission/sellerEarning, settledAt.
 *   - GET /orders/settlements never leaks another seller's settlements.
 *   - GET /orders/settlements requires authentication.
 *   - GET /admin/commission-report (admin): aggregate totals
 *     (grossAmount/commissionAmount/sellerEarning/count) match the
 *     underlying OrderItemSettlement rows.
 *   - storeId / date range / commissionRuleId filters narrow the report
 *     correctly.
 *   - pagination (page/pageSize) works.
 *   - GET /admin/commission-report requires authentication and
 *     commission:manage (a seller/customer gets 403).
 *   - Historical snapshot: editing a CommissionRule's rate after settlement
 *     does not change previously-reported totals.
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
    name: 'محصول گزارش تسویه', categoryId, price: 20000, stock: 10, ...overrides,
  });
  const id = created.body.data.id;
  await api.patch(`${PREFIX}/products/${id}/moderate`).set('Authorization', adminAuth).send({ status: 'APPROVED' });
  return prisma.storeProduct.findUnique({ where: { id } });
}

/** Drives one order all the way to DELIVERED (creating exactly one OrderItemSettlement). */
async function checkoutToDelivered(customerAuth, adminAuth, storeProduct, qty) {
  await api.post(`${PREFIX}/cart/items`).set('Authorization', customerAuth).send({ productId: storeProduct.id, qty });
  const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customerAuth).send({});
  const id = order.body.data.id;
  await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', adminAuth).send({ status: 'CONFIRMED' });
  await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', adminAuth).send({ status: 'PREPARING' });
  await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', adminAuth).send({ status: 'SENT' });
  await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', adminAuth).send({ status: 'DELIVERED' });
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

describe('Phase 3 — Seller settlement visibility + Admin commission report', () => {
  let customer;
  let sellerA;
  let sellerB;
  let admin;
  let category;
  let storeA;
  let storeB;
  let productA;
  let productB;
  let globalRuleId;
  let settlementA;

  beforeAll(async () => {
    const rand = () => Math.floor(Math.random() * 9);
    customer = await makeUser('CUSTOMER', `5300000${rand()}`);
    sellerA = await makeUser('SELLER', `5301000${rand()}`);
    sellerB = await makeUser('SELLER', `5302000${rand()}`);
    admin = await makeUser('ADMIN', `5303000${rand()}`);

    storeA = await makeApprovedStore(sellerA.user.id, 'فروشگاه گزارش A');
    storeB = await makeApprovedStore(sellerB.user.id, 'فروشگاه گزارش B');

    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته گزارش تسویه', slug: `report-cat-${Date.now()}` });
    category = cat.body.data;

    productA = await makeApprovedProduct(sellerA.auth, admin.auth, category.id, { price: 50000, stock: 50 });
    productB = await makeApprovedProduct(sellerB.auth, admin.auth, category.id, { price: 30000, stock: 50 });

    // Ensure at least one active GLOBAL rule exists (resolveCommissionRate
    // requires one). A newer/higher-priority GLOBAL rule created here simply
    // wins the tie-break over any pre-existing one from another test file —
    // it doesn't need to be the only one.
    const rule = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth)
      .send({ scope: 'GLOBAL', rate: 10, priority: 100 });
    expect(rule.status).toBe(201);
    globalRuleId = rule.body.data.id;

    // Two delivered orders for store A, one for store B — gives us
    // predictable totals to assert on.
    const orderA1 = await checkoutToDelivered(customer.auth, admin.auth, productA, 1); // gross 50000
    const orderA2 = await checkoutToDelivered(customer.auth, admin.auth, productA, 2); // gross 100000
    await checkoutToDelivered(customer.auth, admin.auth, productB, 1); // gross 30000, store B

    settlementA = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: orderA1.items[0].id } });
    await prisma.orderItemSettlement.findUnique({ where: { orderItemId: orderA2.items[0].id } });
  });

  describe('Seller settlement visibility — GET /orders/settlements', () => {
    test('seller A sees only settlements for their own store, with the expected fields', async () => {
      const res = await api.get(`${PREFIX}/orders/settlements`).set('Authorization', sellerA.auth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(2);
      for (const item of res.body.data.items) {
        expect(item.storeId).toBe(storeA.id);
        expect(item).toHaveProperty('order');
        expect(item).toHaveProperty('orderItem');
        expect(item).toHaveProperty('commissionRule');
        expect(item).toHaveProperty('commissionRate');
        expect(item).toHaveProperty('grossAmount');
        expect(item).toHaveProperty('commissionAmount');
        expect(item).toHaveProperty('sellerEarning');
        expect(item).toHaveProperty('settledAt');
      }
    });

    test('seller A never sees seller B\'s settlements', async () => {
      const res = await api.get(`${PREFIX}/orders/settlements`).set('Authorization', sellerA.auth);
      expect(res.status).toBe(200);
      const foreignStoreIds = res.body.data.items.map((it) => it.storeId).filter((id) => id !== storeA.id);
      expect(foreignStoreIds).toHaveLength(0);
    });

    test('seller B sees exactly their own settlement(s), not store A\'s', async () => {
      const res = await api.get(`${PREFIX}/orders/settlements`).set('Authorization', sellerB.auth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.items.every((it) => it.storeId === storeB.id)).toBe(true);
    });

    test('unauthenticated request is rejected', async () => {
      const res = await api.get(`${PREFIX}/orders/settlements`);
      expect(res.status).toBe(401);
    });

    test('query parameters cannot be used to bypass store scoping (no storeId param is honored)', async () => {
      // The endpoint doesn't accept a storeId filter at all — scoping comes
      // solely from the caller's own store lookup — so passing one is
      // simply ignored rather than opening a bypass.
      const res = await api.get(`${PREFIX}/orders/settlements?storeId=${storeB.id}`).set('Authorization', sellerA.auth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.every((it) => it.storeId === storeA.id)).toBe(true);
    });
  });

  describe('Admin commission report — GET /admin/commission-report', () => {
    test('admin gets correct aggregate totals across all stores', async () => {
      const res = await api.get(`${PREFIX}/admin/commission-report`).set('Authorization', admin.auth);
      expect(res.status).toBe(200);
      const all = await prisma.orderItemSettlement.aggregate({
        _sum: { grossAmount: true, commissionAmount: true, sellerEarning: true }, _count: true,
      });
      expect(Number(res.body.data.summary.totalGrossAmount)).toBe(Number(all._sum.grossAmount));
      expect(Number(res.body.data.summary.totalCommissionAmount)).toBe(Number(all._sum.commissionAmount));
      expect(Number(res.body.data.summary.totalSellerEarning)).toBe(Number(all._sum.sellerEarning));
      expect(res.body.data.summary.count).toBe(all._count);
    });

    test('storeId filter narrows the report to that store only', async () => {
      const res = await api.get(`${PREFIX}/admin/commission-report?storeId=${storeA.id}`).set('Authorization', admin.auth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.every((it) => it.storeId === storeA.id)).toBe(true);

      const expected = await prisma.orderItemSettlement.aggregate({
        where: { storeId: storeA.id }, _sum: { grossAmount: true }, _count: true,
      });
      expect(Number(res.body.data.summary.totalGrossAmount)).toBe(Number(expected._sum.grossAmount));
      expect(res.body.data.summary.count).toBe(expected._count);
    });

    test('commissionRuleId filter narrows the report correctly', async () => {
      const res = await api.get(`${PREFIX}/admin/commission-report?commissionRuleId=${globalRuleId}`).set('Authorization', admin.auth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.every((it) => it.commissionRuleId === globalRuleId)).toBe(true);
    });

    test('date range filter narrows the report correctly', async () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const res = await api.get(`${PREFIX}/admin/commission-report?dateFrom=${future}`).set('Authorization', admin.auth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(0);
      expect(res.body.data.summary.count).toBe(0);

      const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const res2 = await api.get(`${PREFIX}/admin/commission-report?dateFrom=${past}`).set('Authorization', admin.auth);
      expect(res2.status).toBe(200);
      expect(res2.body.data.summary.count).toBeGreaterThan(0);
    });

    test('invalid date range (dateTo before dateFrom) is rejected with 400', async () => {
      const res = await api.get(`${PREFIX}/admin/commission-report?dateFrom=2026-01-02&dateTo=2026-01-01`).set('Authorization', admin.auth);
      expect(res.status).toBe(400);
    });

    test('pagination works: pageSize limits item count and total reflects the full match', async () => {
      const res = await api.get(`${PREFIX}/admin/commission-report?storeId=${storeA.id}&page=1&pageSize=1`).set('Authorization', admin.auth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.total).toBeGreaterThanOrEqual(2);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(1);
    });

    test('unauthenticated request is rejected', async () => {
      const res = await api.get(`${PREFIX}/admin/commission-report`);
      expect(res.status).toBe(401);
    });

    test('a seller (no commission:manage) is forbidden', async () => {
      const res = await api.get(`${PREFIX}/admin/commission-report`).set('Authorization', sellerA.auth);
      expect(res.status).toBe(403);
    });
  });

  describe('Historical snapshot integrity in the report', () => {
    test('editing the CommissionRule rate after settlement does not change previously-reported totals', async () => {
      const before = await api.get(`${PREFIX}/admin/commission-report?storeId=${storeA.id}`).set('Authorization', admin.auth);
      const totalsBefore = before.body.data.summary;

      const patched = await api.patch(`${PREFIX}/admin/commission-rules/${globalRuleId}`).set('Authorization', admin.auth).send({ rate: 77 });
      expect(patched.status).toBe(200);

      const after = await api.get(`${PREFIX}/admin/commission-report?storeId=${storeA.id}`).set('Authorization', admin.auth);
      expect(Number(after.body.data.summary.totalCommissionAmount)).toBe(Number(totalsBefore.totalCommissionAmount));
      expect(Number(after.body.data.summary.totalSellerEarning)).toBe(Number(totalsBefore.totalSellerEarning));

      // Same for the seller-facing settlement rate snapshot.
      const sellerView = await api.get(`${PREFIX}/orders/settlements`).set('Authorization', sellerA.auth);
      const row = sellerView.body.data.items.find((it) => it.id === settlementA.id);
      expect(Number(row.commissionRate)).toBe(Number(settlementA.commissionRate));

      // Restore for any other suite relying on the original rate.
      await api.patch(`${PREFIX}/admin/commission-rules/${globalRuleId}`).set('Authorization', admin.auth).send({ rate: 10 });
    });
  });
});
