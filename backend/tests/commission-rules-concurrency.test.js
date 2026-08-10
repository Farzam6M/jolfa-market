/**
 * Test suite for F2 — concurrency-safe "at least one active GLOBAL
 * CommissionRule must always exist" invariant.
 *
 * Prior to F2, commission-rules.service.js#update()/remove() checked
 * "is there another active GLOBAL rule?" and then performed the
 * deactivate/delete as two separate statements. Two concurrent admin
 * requests could each pass the check (each seeing 2 active GLOBAL rules)
 * and then each mutate a different one, jointly leaving zero active GLOBAL
 * rules — after which order settlement's resolveCommissionRate() has
 * nothing to resolve against.
 *
 * Covers:
 *   - The pre-existing "can't remove the only active GLOBAL rule" guard
 *     still works for both PATCH (deactivate) and DELETE.
 *   - Two concurrent requests that each try to deactivate a DIFFERENT one
 *     of exactly two active GLOBAL rules: at least one must fail, and the
 *     database never ends up with zero active GLOBAL rules.
 *   - Three active GLOBAL rules can be reduced to one via sequential
 *     requests, and the final one is then protected again.
 *
 * seed.js (F3) guarantees a default active GLOBAL rule in a fresh
 * database, so every test here explicitly captures and isolates whichever
 * GLOBAL rules currently exist (going straight to Prisma, same pattern
 * used in order-settlement.test.js) rather than assuming "there is only
 * the one I just created".
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

/** All currently-active GLOBAL rule rows, read directly (not via the API). */
async function activeGlobalRules() {
  return prisma.commissionRule.findMany({ where: { scope: 'GLOBAL', isActive: true } });
}

/**
 * Deactivates every currently-active GLOBAL rule directly via Prisma
 * (bypassing the admin API's own last-active-GLOBAL guard, which exists
 * precisely to block reaching this state through the API) and returns
 * their ids, so the caller can restore them afterwards. Mirrors the
 * isolation pattern used in order-settlement.test.js's rollback test.
 */
async function isolateNoActiveGlobal() {
  const existing = await activeGlobalRules();
  if (existing.length) {
    await prisma.commissionRule.updateMany({
      where: { id: { in: existing.map((r) => r.id) } },
      data: { isActive: false },
    });
  }
  return existing.map((r) => r.id);
}

async function restoreActiveGlobal(ids) {
  if (ids.length) {
    await prisma.commissionRule.updateMany({
      where: { id: { in: ids } },
      data: { isActive: true },
    });
  }
}

async function createGlobalRule(rate = 10) {
  const res = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate });
  expect(res.status).toBe(201);
  return res.body.data;
}

beforeAll(async () => {
  const roleRows = await prisma.role.findMany();
  roles = Object.fromEntries(roleRows.map((r) => [r.key, r]));
  if (!roles.ADMIN) {
    throw new Error('Roles are not seeded — run `npm run seed` against the test database first.');
  }
  admin = await makeUser('ADMIN', '53000000' + Math.floor(Math.random() * 9));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('F2 — GLOBAL CommissionRule removal concurrency safety', () => {
  test('deactivating the only active GLOBAL rule is rejected, and it remains active', async () => {
    const preExisting = await isolateNoActiveGlobal();
    const rule = await createGlobalRule();

    const res = await api.patch(`${PREFIX}/admin/commission-rules/${rule.id}`).set('Authorization', admin.auth).send({ isActive: false });
    expect(res.status).toBe(409);

    const stored = await prisma.commissionRule.findUnique({ where: { id: rule.id } });
    expect(stored.isActive).toBe(true);

    await restoreActiveGlobal(preExisting);
  });

  test('deleting the only active GLOBAL rule is rejected, and it still exists and is active', async () => {
    const preExisting = await isolateNoActiveGlobal();
    const rule = await createGlobalRule();

    const res = await api.delete(`${PREFIX}/admin/commission-rules/${rule.id}`).set('Authorization', admin.auth);
    expect(res.status).toBe(409);

    const stored = await prisma.commissionRule.findUnique({ where: { id: rule.id } });
    expect(stored).not.toBeNull();
    expect(stored.isActive).toBe(true);

    await restoreActiveGlobal(preExisting);
  });

  test('two concurrent requests deactivating two different active GLOBAL rules: at least one is rejected, and at least one active GLOBAL rule always remains', async () => {
    const preExisting = await isolateNoActiveGlobal();
    const ruleA = await createGlobalRule();
    const ruleB = await createGlobalRule();

    // The actual race this test exists to catch: two genuinely concurrent
    // requests, not sequential ones — issued together via Promise.all so
    // both reach the service around the same time.
    const [resA, resB] = await Promise.all([
      api.patch(`${PREFIX}/admin/commission-rules/${ruleA.id}`).set('Authorization', admin.auth).send({ isActive: false }),
      api.patch(`${PREFIX}/admin/commission-rules/${ruleB.id}`).set('Authorization', admin.auth).send({ isActive: false }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Exactly one must succeed and one must be rejected — if the old
    // count-then-update race were still present, both would return 200.
    expect(statuses).toEqual([200, 409]);

    const winnerIsA = resA.status === 200;
    const winnerId = winnerIsA ? ruleA.id : ruleB.id;
    const loserId = winnerIsA ? ruleB.id : ruleA.id;

    const winnerRow = await prisma.commissionRule.findUnique({ where: { id: winnerId } });
    const loserRow = await prisma.commissionRule.findUnique({ where: { id: loserId } });
    expect(winnerRow.isActive).toBe(false); // the request that got 200 actually deactivated its rule
    expect(loserRow.isActive).toBe(true); // the rejected request's rule was left untouched

    const remainingActive = await activeGlobalRules();
    // The critical regression assertion: never zero active GLOBAL rules.
    expect(remainingActive.length).toBeGreaterThanOrEqual(1);
    expect(remainingActive.map((r) => r.id)).toContain(loserId);

    await restoreActiveGlobal(preExisting);
  });

  test('three active GLOBAL rules can be reduced to one sequentially, and the final one is then protected again', async () => {
    const preExisting = await isolateNoActiveGlobal();
    const ruleA = await createGlobalRule();
    const ruleB = await createGlobalRule();
    const ruleC = await createGlobalRule();

    const deactivateA = await api.patch(`${PREFIX}/admin/commission-rules/${ruleA.id}`).set('Authorization', admin.auth).send({ isActive: false });
    expect(deactivateA.status).toBe(200);

    const deactivateB = await api.patch(`${PREFIX}/admin/commission-rules/${ruleB.id}`).set('Authorization', admin.auth).send({ isActive: false });
    expect(deactivateB.status).toBe(200);

    // Only ruleC is left active — removing it must now be rejected, same
    // as the single-rule case above.
    const deactivateC = await api.patch(`${PREFIX}/admin/commission-rules/${ruleC.id}`).set('Authorization', admin.auth).send({ isActive: false });
    expect(deactivateC.status).toBe(409);

    const remainingActive = await activeGlobalRules();
    expect(remainingActive.map((r) => r.id)).toEqual([ruleC.id]);

    await restoreActiveGlobal(preExisting);
  });
});
