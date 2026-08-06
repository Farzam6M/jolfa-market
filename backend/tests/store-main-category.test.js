/**
 * Test suite for the "Store main category" business rule (requested fix):
 *
 *   - Every Store MAY have one authoritative mainCategoryId.
 *   - When set, that store's products may ONLY use that same category, on
 *     BOTH create and update, regardless of who is calling — seller, admin,
 *     or super_admin (products.service#resolveEnforcedCategoryId is the
 *     single enforcement point for every create/update path).
 *   - A store with NO mainCategoryId (legacy / not yet assigned) is
 *     unrestricted — this is a deliberate backward-compatibility decision,
 *     see the migration's comments.
 *   - Only admin/super_admin can set/change a store's mainCategoryId
 *     (POST /stores, PATCH /stores/:id) — a seller's own PATCH /stores/me
 *     must not be able to touch it at all.
 *   - A category currently used as a store's mainCategoryId cannot be
 *     deleted.
 *
 * Requires a real Postgres database (DATABASE_URL) with the schema migrated
 * (`npx prisma migrate deploy`) and roles seeded (`npm run seed`) before running:
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

async function makeApprovedStore(sellerId, name, mainCategoryId) {
  return prisma.store.create({
    data: {
      sellerId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: 'APPROVED',
      ...(mainCategoryId ? { mainCategoryId } : {}),
    },
  });
}

async function makeCategory(admin, name) {
  const res = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
    .send({ name, slug: `${name}-${Date.now()}-${Math.floor(Math.random() * 100000)}` });
  return res.body.data;
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

describe('Store main category — assignment (admin/super_admin only)', () => {
  test('admin can set mainCategoryId when creating a store directly', async () => {
    const admin = await makeUser('ADMIN', '50000000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-ایجاد');

    const res = await api.post(`${PREFIX}/stores`).set('Authorization', admin.auth).send({
      name: 'فروشگاه پوشاک مستقیم', mainCategoryId: clothing.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.store.mainCategoryId).toBe(clothing.id);
  });

  test('admin can set/change mainCategoryId via PATCH /stores/:id', async () => {
    const admin = await makeUser('ADMIN', '50100000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '50110000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-ادمین-پچ');
    const store = await makeApprovedStore(seller.user.id, 'فروشگاه بدون دسته اولیه');

    const res = await api.patch(`${PREFIX}/stores/${store.id}`).set('Authorization', admin.auth)
      .send({ mainCategoryId: clothing.id });
    expect(res.status).toBe(200);
    expect(res.body.data.mainCategoryId).toBe(clothing.id);

    const mobile = await makeCategory(admin, 'موبایل-تغییر');
    const changed = await api.patch(`${PREFIX}/stores/${store.id}`).set('Authorization', admin.auth)
      .send({ mainCategoryId: mobile.id });
    expect(changed.status).toBe(200);
    expect(changed.body.data.mainCategoryId).toBe(mobile.id);
  });

  test('a seller CANNOT set/change their store\'s mainCategoryId via PATCH /stores/me', async () => {
    const admin = await makeUser('ADMIN', '50200000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '50210000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-فروشنده-تلاش');
    await makeApprovedStore(seller.user.id, 'فروشگاه تلاش فروشنده');

    // Even though the seller's own update route accepts other fields
    // (name/description/etc — see stores.validation.js#updateOwnSchema),
    // mainCategoryId is simply not part of that schema, so zod strips it
    // silently; the store's mainCategoryId must remain unchanged (null).
    const res = await api.patch(`${PREFIX}/stores/me`).set('Authorization', seller.auth)
      .send({ mainCategoryId: clothing.id, description: 'تلاش برای دور زدن' });
    expect(res.status).toBe(200);
    expect(res.body.data.mainCategoryId).toBeFalsy();
  });
});

describe('Store main category — product create/update enforcement', () => {
  test('a store with mainCategoryId can register a product in that same category', async () => {
    const admin = await makeUser('ADMIN', '51000000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '51010000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-معتبر');
    await makeApprovedStore(seller.user.id, 'فروشگاه پوشاک الف', clothing.id);

    const res = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'پیراهن مردانه', categoryId: clothing.id, price: 100000, stock: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.categoryId).toBe(clothing.id);
  });

  test('the SAME store cannot register a product in an unrelated category', async () => {
    const admin = await makeUser('ADMIN', '51100000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '51110000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-محدود');
    const mobile = await makeCategory(admin, 'موبایل-محدود');
    await makeApprovedStore(seller.user.id, 'فروشگاه پوشاک ب', clothing.id);

    const res = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'گوشی موبایل نامرتبط', categoryId: mobile.id, price: 5000000, stock: 2,
    });
    expect(res.status).toBe(400);
  });

  test('a categoryId is auto-filled from the store\'s mainCategoryId when omitted', async () => {
    const admin = await makeUser('ADMIN', '51200000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '51210000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-پیشفرض');
    await makeApprovedStore(seller.user.id, 'فروشگاه پیشفرض', clothing.id);

    const res = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول بدون دسته صریح', price: 10000, stock: 1,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.categoryId).toBe(clothing.id);
  });

  test('the rule applies the same way when an admin creates the product for that store', async () => {
    const admin = await makeUser('ADMIN', '51300000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '51310000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-ادمین-ساخت');
    const mobile = await makeCategory(admin, 'موبایل-ادمین-ساخت');
    const store = await makeApprovedStore(seller.user.id, 'فروشگاه ساخت ادمین', clothing.id);

    const mismatched = await api.post(`${PREFIX}/products`).set('Authorization', admin.auth).send({
      name: 'محصول نامعتبر ادمین', storeId: store.id, categoryId: mobile.id, price: 10000, stock: 1,
    });
    expect(mismatched.status).toBe(400);

    const matched = await api.post(`${PREFIX}/products`).set('Authorization', admin.auth).send({
      name: 'محصول معتبر ادمین', storeId: store.id, categoryId: clothing.id, price: 10000, stock: 1,
    });
    expect(matched.status).toBe(201);
  });

  test('the rule applies the same way when a super_admin creates the product for that store', async () => {
    const admin = await makeUser('ADMIN', '51400000' + Math.floor(Math.random() * 9));
    const superAdmin = await makeUser('SUPER_ADMIN', '51410000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '51420000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-سوپرادمین');
    const mobile = await makeCategory(admin, 'موبایل-سوپرادمین');
    const store = await makeApprovedStore(seller.user.id, 'فروشگاه سوپرادمین', clothing.id);

    const mismatched = await api.post(`${PREFIX}/products`).set('Authorization', superAdmin.auth).send({
      name: 'محصول نامعتبر سوپرادمین', storeId: store.id, categoryId: mobile.id, price: 10000, stock: 1,
    });
    expect(mismatched.status).toBe(400);

    const matched = await api.post(`${PREFIX}/products`).set('Authorization', superAdmin.auth).send({
      name: 'محصول معتبر سوپرادمین', storeId: store.id, categoryId: clothing.id, price: 10000, stock: 1,
    });
    expect(matched.status).toBe(201);
  });

  test('updating an existing product to a mismatched category is rejected', async () => {
    const admin = await makeUser('ADMIN', '51500000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '51510000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-آپدیت');
    const mobile = await makeCategory(admin, 'موبایل-آپدیت');
    await makeApprovedStore(seller.user.id, 'فروشگاه آپدیت محصول', clothing.id);

    const created = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول برای آپدیت دسته', categoryId: clothing.id, price: 10000, stock: 1,
    });
    expect(created.status).toBe(201);

    const res = await api.patch(`${PREFIX}/products/${created.body.data.id}`).set('Authorization', seller.auth)
      .send({ categoryId: mobile.id });
    expect(res.status).toBe(400);
  });

  test('updating an existing product to the SAME (matching) category still works', async () => {
    const admin = await makeUser('ADMIN', '51600000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '51610000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-آپدیت-معتبر');
    await makeApprovedStore(seller.user.id, 'فروشگاه آپدیت معتبر', clothing.id);

    const created = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول برای آپدیت هم‌دسته', categoryId: clothing.id, price: 10000, stock: 1,
    });

    const res = await api.patch(`${PREFIX}/products/${created.body.data.id}`).set('Authorization', seller.auth)
      .send({ categoryId: clothing.id, price: 20000 });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.price)).toBe(20000);
  });

  test('a store WITHOUT a mainCategoryId is unrestricted (backward compatibility)', async () => {
    const admin = await makeUser('ADMIN', '51700000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '51710000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-بدون-محدودیت');
    const mobile = await makeCategory(admin, 'موبایل-بدون-محدودیت');
    await makeApprovedStore(seller.user.id, 'فروشگاه بدون دسته اصلی'); // no mainCategoryId

    const first = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول پوشاک آزاد', categoryId: clothing.id, price: 10000, stock: 1,
    });
    expect(first.status).toBe(201);

    const second = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول موبایل آزاد', categoryId: mobile.id, price: 10000, stock: 1,
    });
    expect(second.status).toBe(201);
  });
});

describe('Store main category — category deletion guard', () => {
  test('a category currently set as a store\'s mainCategoryId cannot be deleted', async () => {
    const admin = await makeUser('ADMIN', '52000000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '52010000' + Math.floor(Math.random() * 9));
    const clothing = await makeCategory(admin, 'پوشاک-غیرقابل‌حذف');
    await makeApprovedStore(seller.user.id, 'فروشگاه دسته غیرقابل حذف', clothing.id);

    const res = await api.delete(`${PREFIX}/categories/${clothing.id}`).set('Authorization', admin.auth);
    expect(res.status).toBe(409);
  });

  test('once the store\'s mainCategoryId is reassigned elsewhere, the old category can be deleted', async () => {
    const admin = await makeUser('ADMIN', '52100000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '52110000' + Math.floor(Math.random() * 9));
    const oldCat = await makeCategory(admin, 'پوشاک-قدیمی-آزادشدنی');
    const newCat = await makeCategory(admin, 'پوشاک-جدید-جایگزین');
    const store = await makeApprovedStore(seller.user.id, 'فروشگاه جابه‌جایی دسته', oldCat.id);

    await api.patch(`${PREFIX}/stores/${store.id}`).set('Authorization', admin.auth)
      .send({ mainCategoryId: newCat.id });

    const res = await api.delete(`${PREFIX}/categories/${oldCat.id}`).set('Authorization', admin.auth);
    expect(res.status).toBe(200);
  });
});
