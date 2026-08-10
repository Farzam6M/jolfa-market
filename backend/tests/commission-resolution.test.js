/**
 * P1 Phase 1 — Commission Engine resolution precedence tests.
 *
 * Scope (per P1 audit): commission-rules.service.js#resolveCommissionRate()
 * is the single source of truth for which CommissionRule wins for a given
 * (sellerId, categoryId, now). This suite locks in, by calling the real
 * exported function against real rows (created through the actual admin
 * API — POST /admin/commission-rules — so validation + service-layer combo
 * checks run for real, nothing is mocked or bypassed):
 *
 *   - SELLER overrides CATEGORY and GLOBAL.
 *   - An inactive SELLER rule is excluded and the resolver falls through.
 *   - Multiple active SELLER rules for the same seller are tie-broken by
 *     `priority` (higher wins).
 *   - CAMPAIGN overrides SELLER, CATEGORY and GLOBAL.
 *   - CAMPAIGN specificity ordering: seller+category > seller-only >
 *     category-only > unscoped — verified as a full 4-step cascade by
 *     deactivating the winner at each step and re-resolving.
 *   - `priority` cannot cross tiers: a low-priority active CAMPAIGN still
 *     beats a SELLER rule with an extremely high priority.
 *
 * Business-rule inputs approved for this phase (see P1 audit): campaign
 * date boundaries are INCLUSIVE ([start, end]), and the specificity order
 * above is the confirmed intended behavior — both are exercised here as
 * settled facts, not open questions.
 *
 * Deliberately OUT of scope for this file (left for a later phase, per the
 * P1 test plan): campaign boundary edge cases (exact start/end instant,
 * one moment outside the window), GLOBAL fallback/multi-GLOBAL tie-break,
 * overlapping campaigns across different sellers, and audit-log content —
 * none of those are touched here.
 *
 * resolveCommissionRate() is called directly (not via checkout/settlement)
 * since it's the exact function orders.service.js#settleDeliveredOrder()
 * calls — this is the real resolver, not a re-implementation or a mock of
 * the CommissionRule query. Settlement/order flow is intentionally not
 * exercised here (no Wallet fixture is required for these tests) — that
 * end-to-end path is already covered by order-settlement.test.js.
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

/**
 * Creates a fresh SELLER user + an APPROVED Store for them, directly via
 * Prisma (same pattern as order-settlement.test.js's makeApprovedStore) —
 * these tests call resolveCommissionRate() directly rather than going
 * through checkout/settlement, so no Wallet is needed for this seller.
 */
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
  return store;
}

/**
 * `name` is kept Persian (readable in test output); `slug` is a separate,
 * caller-supplied ASCII identifier. categories.validation.js#createSchema
 * requires `slug` to match /^[a-z0-9-]+$/ — deriving it from a Persian
 * `name` via toLowerCase() (as an earlier version of this helper did)
 * leaves the Persian characters/digits untouched and always fails that
 * regex with a 400, before resolveCommissionRate() is ever reached. Same
 * pattern already used by order-settlement.test.js/settlement-reporting.
 * test.js/categories-images.test.js (e.g. `slug: \`settlement-cat-${Date.now()}\``).
 */
async function makeCategory(name, slugPrefix) {
  const res = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
    .send({ name, slug: `${slugPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  expect(res.status).toBe(201);
  return res.body.data;
}

/** Creates a CommissionRule through the real admin API (real validation + service, nothing mocked). */
async function createRule(payload) {
  const res = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send(payload);
  expect(res.status).toBe(201);
  return res.body.data;
}

async function deactivateRule(id) {
  const res = await api.patch(`${PREFIX}/admin/commission-rules/${id}`).set('Authorization', admin.auth).send({ isActive: false });
  expect(res.status).toBe(200);
}

/** Wide, symmetric window around "now" so these precedence tests are never flaky on exact-boundary timing (boundary behavior itself is out of scope for this file). */
function wideCampaignWindow() {
  const now = new Date();
  return {
    campaignStartAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    campaignEndAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

beforeAll(async () => {
  const roleRows = await prisma.role.findMany();
  roles = Object.fromEntries(roleRows.map((r) => [r.key, r]));
  if (!roles.ADMIN || !roles.SELLER) {
    throw new Error('Roles are not seeded — run `npm run seed` against the test database first.');
  }
  admin = await makeUser('ADMIN', '54000000' + Math.floor(Math.random() * 9));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Commission Engine resolution — SELLER tier', () => {
  test('SELLER overrides CATEGORY and GLOBAL', async () => {
    const store = await makeSellerStore('54010000' + Math.floor(Math.random() * 9), 'فروشگاه اولویت فروشنده ۱');
    const category = await makeCategory('دسته اولویت فروشنده ۱', 'seller-tier-1');

    await createRule({ scope: 'GLOBAL', rate: 10 });
    await createRule({ scope: 'CATEGORY', categoryId: category.id, rate: 20 });
    await createRule({ scope: 'SELLER', sellerId: store.id, rate: 30 });

    const { rate, rule } = await resolveCommissionRate(store.id, category.id);
    expect(Number(rate)).toBe(30);
    expect(rule.scope).toBe('SELLER');
  });

  test('an inactive SELLER rule falls through and CATEGORY wins', async () => {
    const store = await makeSellerStore('54020000' + Math.floor(Math.random() * 9), 'فروشگاه اولویت فروشنده ۲');
    const category = await makeCategory('دسته اولویت فروشنده ۲', 'seller-tier-2');

    await createRule({ scope: 'GLOBAL', rate: 10 });
    await createRule({ scope: 'CATEGORY', categoryId: category.id, rate: 20 });
    const sellerRule = await createRule({ scope: 'SELLER', sellerId: store.id, rate: 30, isActive: false });
    expect(sellerRule.isActive).toBe(false);

    const { rate, rule } = await resolveCommissionRate(store.id, category.id);
    expect(Number(rate)).toBe(20);
    expect(rule.scope).toBe('CATEGORY');
  });

  test('multiple active SELLER rules for the same seller: higher priority wins', async () => {
    const store = await makeSellerStore('54030000' + Math.floor(Math.random() * 9), 'فروشگاه اولویت فروشنده ۳');
    const category = await makeCategory('دسته اولویت فروشنده ۳', 'seller-tier-3');

    await createRule({
      scope: 'SELLER', sellerId: store.id, rate: 40, priority: 5,
    });
    const higherPriorityRule = await createRule({
      scope: 'SELLER', sellerId: store.id, rate: 50, priority: 10,
    });

    const { rate, rule } = await resolveCommissionRate(store.id, category.id);
    expect(Number(rate)).toBe(50);
    expect(rule.id).toBe(higherPriorityRule.id);
  });
});

describe('Commission Engine resolution — CAMPAIGN tier', () => {
  test('an active in-window CAMPAIGN overrides SELLER, CATEGORY and GLOBAL', async () => {
    const store = await makeSellerStore('54040000' + Math.floor(Math.random() * 9), 'فروشگاه کمپین برتر');
    const category = await makeCategory('دسته کمپین برتر', 'campaign-top-tier');
    const { campaignStartAt, campaignEndAt } = wideCampaignWindow();

    await createRule({ scope: 'GLOBAL', rate: 10 });
    await createRule({ scope: 'CATEGORY', categoryId: category.id, rate: 20 });
    await createRule({ scope: 'SELLER', sellerId: store.id, rate: 30 });
    await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 40, campaignStartAt, campaignEndAt,
    });

    const { rate, rule } = await resolveCommissionRate(store.id, category.id);
    expect(Number(rate)).toBe(40);
    expect(rule.scope).toBe('CAMPAIGN');
  });

  test('CAMPAIGN specificity: seller+category > seller-only > category-only > unscoped', async () => {
    const store = await makeSellerStore('54050000' + Math.floor(Math.random() * 9), 'فروشگاه دقت کمپین');
    const category = await makeCategory('دسته دقت کمپین', 'campaign-specificity');
    const { campaignStartAt, campaignEndAt } = wideCampaignWindow();

    const sellerAndCategory = await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 99, campaignStartAt, campaignEndAt,
    });
    const sellerOnly = await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, rate: 88, campaignStartAt, campaignEndAt,
    });
    const categoryOnly = await createRule({
      scope: 'CAMPAIGN', categoryId: category.id, rate: 77, campaignStartAt, campaignEndAt,
    });
    const unscoped = await createRule({
      scope: 'CAMPAIGN', rate: 66, campaignStartAt, campaignEndAt,
    });

    // Step 1: all four active — most specific (seller+category) must win.
    let resolved = await resolveCommissionRate(store.id, category.id);
    expect(Number(resolved.rate)).toBe(99);
    expect(resolved.rule.id).toBe(sellerAndCategory.id);

    // Step 2: remove the winner — seller-only must now win over category-only/unscoped.
    await deactivateRule(sellerAndCategory.id);
    resolved = await resolveCommissionRate(store.id, category.id);
    expect(Number(resolved.rate)).toBe(88);
    expect(resolved.rule.id).toBe(sellerOnly.id);

    // Step 3: remove seller-only — category-only must now win over unscoped.
    await deactivateRule(sellerOnly.id);
    resolved = await resolveCommissionRate(store.id, category.id);
    expect(Number(resolved.rate)).toBe(77);
    expect(resolved.rule.id).toBe(categoryOnly.id);

    // Step 4: remove category-only — the fully unscoped campaign is the last one standing.
    await deactivateRule(categoryOnly.id);
    resolved = await resolveCommissionRate(store.id, category.id);
    expect(Number(resolved.rate)).toBe(66);
    expect(resolved.rule.id).toBe(unscoped.id);
  });
});

describe('Commission Engine resolution — priority is tier-scoped', () => {
  test('priority cannot cross tiers: a low-priority CAMPAIGN still beats a very-high-priority SELLER rule', async () => {
    const store = await makeSellerStore('54060000' + Math.floor(Math.random() * 9), 'فروشگاه اولویت متقاطع');
    const category = await makeCategory('دسته اولویت متقاطع', 'cross-tier-priority');
    const { campaignStartAt, campaignEndAt } = wideCampaignWindow();

    await createRule({ scope: 'GLOBAL', rate: 10 });
    await createRule({ scope: 'CATEGORY', categoryId: category.id, rate: 20 });
    const highPrioritySeller = await createRule({
      scope: 'SELLER', sellerId: store.id, rate: 90, priority: 9999,
    });
    const lowPriorityCampaign = await createRule({
      scope: 'CAMPAIGN', sellerId: store.id, categoryId: category.id, rate: 15, priority: 0, campaignStartAt, campaignEndAt,
    });

    const { rate, rule } = await resolveCommissionRate(store.id, category.id);
    expect(Number(rate)).toBe(15);
    expect(rule.id).toBe(lowPriorityCampaign.id);
    expect(rule.id).not.toBe(highPrioritySeller.id); // sanity: the high-priority SELLER row really did lose
  });
});
