/**
 * Test suite for P1 — Admin Commission Governance.
 *
 * Covers the two gaps identified by the P1 audit that were not already
 * covered by commission-rules-concurrency.test.js:
 *
 *   1. Negative-path authorization: SELLER and CUSTOMER must get 403 from
 *      every /admin/commission-rules endpoint (GET/POST/PATCH/DELETE), and
 *      ADMIN/SUPER_ADMIN must be able to use all four.
 *   2. Audit-log content: every CREATE/UPDATE/ACTIVATE/DEACTIVATE/DELETE
 *      must write an AdminActivityLog row with the correct actorId, a
 *      distinct machine-readable meta.actionCode (see
 *      COMMISSION_RULE_ACTION_CODES in commission-rules.service.js), and a
 *      structured before/after snapshot covering rate, scope, sellerId,
 *      categoryId, campaignStartAt, campaignEndAt, priority, and isActive.
 *
 * Uses the real HTTP routes (supertest) and the real auth/RBAC stack —
 * no mocked permission middleware.
 *
 * Test isolation: seed.js guarantees a baseline active GLOBAL rule, so
 * every test here only ever ADDS active GLOBAL rules it creates itself,
 * and removes them again (via a direct Prisma delete, bypassing the
 * admin-API guard, same pattern commission-rules-concurrency.test.js uses
 * for isolation) in a `finally` block so a failed assertion can't leave
 * debris behind for later tests or later suites — this is exactly the
 * class of leak that caused the earlier CAMPAIGN rate=45 fixture-isolation
 * bug, so cleanup here is deliberately unconditional.
 *
 * Requires a real Postgres database (DATABASE_URL), migrated + seeded:
 *   NODE_ENV=test npm test
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');
const { COMMISSION_RULE_ACTION_CODES } = require('../src/modules/commission-rules/commission-rules.service');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

let roles;
let admin;
let superAdmin;
let seller;
let customer;

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

/** Directly removes a rule via Prisma, bypassing the admin API's own guards — cleanup only. */
async function hardDelete(id) {
  if (!id) return;
  await prisma.commissionRule.deleteMany({ where: { id } });
}

/** Most recent AdminActivityLog row for a given actor — safe under --runInBand since tests are serial and each checks immediately after its own mutation. */
async function latestActivityLogFor(actorId) {
  return prisma.adminActivityLog.findFirst({
    where: { actorId },
    orderBy: { createdAt: 'desc' },
  });
}

beforeAll(async () => {
  const roleRows = await prisma.role.findMany();
  roles = Object.fromEntries(roleRows.map((r) => [r.key, r]));
  if (!roles.ADMIN || !roles.SUPER_ADMIN || !roles.SELLER || !roles.CUSTOMER) {
    throw new Error('Roles are not seeded — run `npm run seed` against the test database first.');
  }
  const suffix = String(56000000 + Math.floor(Math.random() * 900000));
  admin = await makeUser('ADMIN', `${suffix}1`);
  superAdmin = await makeUser('SUPER_ADMIN', `${suffix}2`);
  seller = await makeUser('SELLER', `${suffix}3`);
  customer = await makeUser('CUSTOMER', `${suffix}4`);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('P1 — commission-rule admin authorization', () => {
  test('GET /admin/commission-rules — ADMIN and SUPER_ADMIN allowed, SELLER and CUSTOMER get 403', async () => {
    const resAdmin = await api.get(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth);
    expect(resAdmin.status).toBe(200);

    const resSuperAdmin = await api.get(`${PREFIX}/admin/commission-rules`).set('Authorization', superAdmin.auth);
    expect(resSuperAdmin.status).toBe(200);

    const resSeller = await api.get(`${PREFIX}/admin/commission-rules`).set('Authorization', seller.auth);
    expect(resSeller.status).toBe(403);

    const resCustomer = await api.get(`${PREFIX}/admin/commission-rules`).set('Authorization', customer.auth);
    expect(resCustomer.status).toBe(403);
  });

  test('POST /admin/commission-rules — ADMIN and SUPER_ADMIN allowed, SELLER and CUSTOMER get 403 and create nothing', async () => {
    let adminRuleId;
    let superAdminRuleId;
    try {
      const resAdmin = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate: 7 });
      expect(resAdmin.status).toBe(201);
      adminRuleId = resAdmin.body.data.id;

      const resSuperAdmin = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', superAdmin.auth).send({ scope: 'GLOBAL', rate: 8 });
      expect(resSuperAdmin.status).toBe(201);
      superAdminRuleId = resSuperAdmin.body.data.id;

      const beforeCount = await prisma.commissionRule.count();

      const resSeller = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', seller.auth).send({ scope: 'GLOBAL', rate: 9 });
      expect(resSeller.status).toBe(403);

      const resCustomer = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', customer.auth).send({ scope: 'GLOBAL', rate: 9 });
      expect(resCustomer.status).toBe(403);

      const afterCount = await prisma.commissionRule.count();
      expect(afterCount).toBe(beforeCount); // neither 403'd request created a row
    } finally {
      await hardDelete(adminRuleId);
      await hardDelete(superAdminRuleId);
    }
  });

  test('PATCH /admin/commission-rules/:id — ADMIN and SUPER_ADMIN allowed, SELLER and CUSTOMER get 403 and change nothing', async () => {
    const created = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate: 11, priority: 0 });
    expect(created.status).toBe(201);
    const ruleId = created.body.data.id;

    try {
      const resSeller = await api.patch(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', seller.auth).send({ priority: 99 });
      expect(resSeller.status).toBe(403);

      const resCustomer = await api.patch(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', customer.auth).send({ priority: 99 });
      expect(resCustomer.status).toBe(403);

      const untouched = await prisma.commissionRule.findUnique({ where: { id: ruleId } });
      expect(untouched.priority).toBe(0); // neither 403'd request mutated the row

      const resAdmin = await api.patch(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', admin.auth).send({ priority: 1 });
      expect(resAdmin.status).toBe(200);

      const resSuperAdmin = await api.patch(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', superAdmin.auth).send({ priority: 2 });
      expect(resSuperAdmin.status).toBe(200);
    } finally {
      await hardDelete(ruleId);
    }
  });

  test('DELETE /admin/commission-rules/:id — SELLER and CUSTOMER get 403 and delete nothing; ADMIN can delete', async () => {
    const created = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate: 12 });
    expect(created.status).toBe(201);
    const ruleId = created.body.data.id;

    try {
      const resSeller = await api.delete(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', seller.auth);
      expect(resSeller.status).toBe(403);

      const resCustomer = await api.delete(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', customer.auth);
      expect(resCustomer.status).toBe(403);

      const stillThere = await prisma.commissionRule.findUnique({ where: { id: ruleId } });
      expect(stillThere).not.toBeNull(); // neither 403'd request deleted the row

      const resAdmin = await api.delete(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', admin.auth);
      expect(resAdmin.status).toBe(200);

      const gone = await prisma.commissionRule.findUnique({ where: { id: ruleId } });
      expect(gone).toBeNull();
    } finally {
      await hardDelete(ruleId); // no-op if the ADMIN delete above already succeeded
    }
  });
});

describe('P1 — commission-rule audit trail (actor, actionCode, before/after)', () => {
  test('CREATE writes an AdminActivityLog entry with the correct actor, actionCode, and after-state', async () => {
    let ruleId;
    try {
      const res = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate: 15.5, priority: 3 });
      expect(res.status).toBe(201);
      ruleId = res.body.data.id;

      const log = await latestActivityLogFor(admin.user.id);
      expect(log).not.toBeNull();
      expect(typeof log.action).toBe('string');
      expect(log.action.length).toBeGreaterThan(0);
      expect(log.meta.actionCode).toBe(COMMISSION_RULE_ACTION_CODES.CREATED);
      expect(log.meta.resource).toBe('CommissionRule');
      expect(log.meta.resourceId).toBe(ruleId);
      expect(log.meta.before).toBeNull();
      expect(log.meta.after).toEqual({
        rate: '15.5',
        scope: 'GLOBAL',
        sellerId: null,
        categoryId: null,
        campaignStartAt: null,
        campaignEndAt: null,
        priority: 3,
        isActive: true,
      });
    } finally {
      await hardDelete(ruleId);
    }
  });

  test('UPDATE (non-isActive field change) writes an AdminActivityLog entry classified as UPDATED with correct before/after', async () => {
    let ruleId;
    try {
      const created = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate: 20, priority: 0 });
      expect(created.status).toBe(201);
      ruleId = created.body.data.id;

      const res = await api.patch(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', admin.auth).send({ priority: 5, rate: 21 });
      expect(res.status).toBe(200);

      const log = await latestActivityLogFor(admin.user.id);
      expect(log.meta.actionCode).toBe(COMMISSION_RULE_ACTION_CODES.UPDATED);
      expect(log.meta.resourceId).toBe(ruleId);
      expect(log.meta.before).toEqual(expect.objectContaining({ rate: '20', priority: 0, isActive: true }));
      expect(log.meta.after).toEqual(expect.objectContaining({ rate: '21', priority: 5, isActive: true }));
    } finally {
      await hardDelete(ruleId);
    }
  });

  test('ACTIVATE (isActive false -> true) is classified as ACTIVATED, not UPDATED', async () => {
    let ruleId;
    try {
      const created = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate: 25, isActive: false });
      expect(created.status).toBe(201);
      ruleId = created.body.data.id;

      const res = await api.patch(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', admin.auth).send({ isActive: true });
      expect(res.status).toBe(200);

      const log = await latestActivityLogFor(admin.user.id);
      expect(log.meta.actionCode).toBe(COMMISSION_RULE_ACTION_CODES.ACTIVATED);
      expect(log.meta.before.isActive).toBe(false);
      expect(log.meta.after.isActive).toBe(true);
    } finally {
      await hardDelete(ruleId);
    }
  });

  test('DEACTIVATE (isActive true -> false) is classified as DEACTIVATED, not UPDATED', async () => {
    // A second active GLOBAL rule so deactivating the target doesn't trip
    // the "at least one active GLOBAL rule" invariant (seed.js's baseline
    // rule already covers this too, but an explicit safety rule keeps this
    // test independent of what other suites/tests have left active).
    let safetyRuleId;
    let ruleId;
    try {
      const safety = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate: 30 });
      expect(safety.status).toBe(201);
      safetyRuleId = safety.body.data.id;

      const created = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate: 31 });
      expect(created.status).toBe(201);
      ruleId = created.body.data.id;

      const res = await api.patch(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', admin.auth).send({ isActive: false });
      expect(res.status).toBe(200);

      const log = await latestActivityLogFor(admin.user.id);
      expect(log.meta.actionCode).toBe(COMMISSION_RULE_ACTION_CODES.DEACTIVATED);
      expect(log.meta.before.isActive).toBe(true);
      expect(log.meta.after.isActive).toBe(false);
    } finally {
      await hardDelete(ruleId);
      await hardDelete(safetyRuleId);
    }
  });

  test('DELETE writes an AdminActivityLog entry with the deleted rule as before-state and after=null', async () => {
    const created = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth).send({ scope: 'GLOBAL', rate: 40.25, priority: 2 });
    expect(created.status).toBe(201);
    const ruleId = created.body.data.id;

    try {
      const res = await api.delete(`${PREFIX}/admin/commission-rules/${ruleId}`).set('Authorization', admin.auth);
      expect(res.status).toBe(200);

      const log = await latestActivityLogFor(admin.user.id);
      expect(log.meta.actionCode).toBe(COMMISSION_RULE_ACTION_CODES.DELETED);
      expect(log.meta.resourceId).toBe(ruleId);
      expect(log.meta.after).toBeNull();
      expect(log.meta.before).toEqual(expect.objectContaining({
        rate: '40.25', scope: 'GLOBAL', priority: 2, isActive: true, sellerId: null, categoryId: null,
      }));
    } finally {
      await hardDelete(ruleId); // no-op — the DELETE above already removed it
    }
  });
});
