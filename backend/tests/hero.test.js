/**
 * Test suite for the Hero slider backend:
 *   - Admin CRUD (create/edit/delete), seller/customer denial.
 *   - Active/inactive toggle and schedule window filtering on the public list.
 *   - A slide missing a desktop image is rejected.
 *   - Reorder endpoint applies the new displayOrder and rejects unknown ids.
 *
 * Requires a real Postgres database (DATABASE_URL) with the schema migrated
 * (`npx prisma migrate dev` / `deploy`) and roles seeded (`npm run seed`)
 * before running:
 *
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

describe('Hero slider management', () => {
  test('admin can create, edit, and delete a slide', async () => {
    const admin = await makeUser('ADMIN', '20000000' + Math.floor(Math.random() * 9));

    const created = await api.post(`${PREFIX}/hero`).set('Authorization', admin.auth).send({
      title: 'اسلاید تست',
      desktopImageUrl: 'https://placehold.co/1600x700',
      primaryButtonText: 'مشاهده',
      primaryButtonLink: '/products',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.isActive).toBe(true);
    expect(created.body.data.desktopImageUrl).toBe('https://placehold.co/1600x700');

    const edited = await api.patch(`${PREFIX}/hero/${created.body.data.id}`).set('Authorization', admin.auth)
      .send({ title: 'اسلاید ویرایش‌شده' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.title).toBe('اسلاید ویرایش‌شده');
    // Untouched image must survive a partial update.
    expect(edited.body.data.desktopImageUrl).toBe('https://placehold.co/1600x700');

    const removed = await api.delete(`${PREFIX}/hero/${created.body.data.id}`).set('Authorization', admin.auth);
    expect(removed.status).toBe(200);
  });

  test('creating a slide without a desktop image is rejected', async () => {
    const admin = await makeUser('ADMIN', '20100000' + Math.floor(Math.random() * 9));
    const res = await api.post(`${PREFIX}/hero`).set('Authorization', admin.auth).send({ title: 'بدون تصویر' });
    expect(res.status).toBe(400);
  });

  test('a customer/seller cannot manage hero slides', async () => {
    const seller = await makeUser('SELLER', '20200000' + Math.floor(Math.random() * 9));
    const res = await api.post(`${PREFIX}/hero`).set('Authorization', seller.auth)
      .send({ title: 'تلاش فروشنده', desktopImageUrl: 'https://placehold.co/1600x700' });
    expect(res.status).toBe(403);
  });

  test('inactive slides are hidden from the public list but visible to staff with includeInactive', async () => {
    const admin = await makeUser('ADMIN', '20300000' + Math.floor(Math.random() * 9));
    const created = await api.post(`${PREFIX}/hero`).set('Authorization', admin.auth)
      .send({ title: 'اسلاید غیرفعال‌شدنی', desktopImageUrl: 'https://placehold.co/1600x700' });
    const id = created.body.data.id;

    const off = await api.patch(`${PREFIX}/hero/${id}/active`).set('Authorization', admin.auth).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);

    const publicList = await api.get(`${PREFIX}/hero`);
    expect(publicList.body.data.some((s) => s.id === id)).toBe(false);

    const staffList = await api.get(`${PREFIX}/hero`).set('Authorization', admin.auth).query({ includeInactive: true });
    expect(staffList.body.data.some((s) => s.id === id)).toBe(true);
  });

  test('a slide scheduled for the future is hidden from the public list', async () => {
    const admin = await makeUser('ADMIN', '20400000' + Math.floor(Math.random() * 9));
    const futureStart = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const created = await api.post(`${PREFIX}/hero`).set('Authorization', admin.auth)
      .send({ title: 'اسلاید آینده', desktopImageUrl: 'https://placehold.co/1600x700', startAt: futureStart });
    expect(created.status).toBe(201);

    const publicList = await api.get(`${PREFIX}/hero`);
    expect(publicList.body.data.some((s) => s.id === created.body.data.id)).toBe(false);
  });

  test('reorder applies the requested order and rejects unknown ids', async () => {
    const admin = await makeUser('ADMIN', '20500000' + Math.floor(Math.random() * 9));
    const a = await api.post(`${PREFIX}/hero`).set('Authorization', admin.auth)
      .send({ title: 'اول', desktopImageUrl: 'https://placehold.co/1600x700' });
    const b = await api.post(`${PREFIX}/hero`).set('Authorization', admin.auth)
      .send({ title: 'دوم', desktopImageUrl: 'https://placehold.co/1600x700' });

    const reordered = await api.patch(`${PREFIX}/hero/reorder`).set('Authorization', admin.auth)
      .send({ order: [b.body.data.id, a.body.data.id] });
    expect(reordered.status).toBe(200);
    const bEntry = reordered.body.data.find((s) => s.id === b.body.data.id);
    const aEntry = reordered.body.data.find((s) => s.id === a.body.data.id);
    expect(bEntry.displayOrder).toBeLessThan(aEntry.displayOrder);

    const badReorder = await api.patch(`${PREFIX}/hero/reorder`).set('Authorization', admin.auth)
      .send({ order: ['00000000-0000-0000-0000-000000000000'] });
    expect(badReorder.status).toBe(400);
  });
});
