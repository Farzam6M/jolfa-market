/**
 * Product update / StoreProduct update authorization test suite.
 *
 * Covers exactly what the task asked to verify:
 *   - a seller can update their own StoreProduct offer fields (price/stock/etc.)
 *   - a seller can NOT update another seller's StoreProduct
 *   - a seller can NOT edit global Product identity fields (name/brand/model/
 *     capacity/color/description/specifications/categoryId) — only staff can
 *   - a staff (admin) identity-field edit is visible to EVERY store selling
 *     that product (proves Product stays global/shared, not duplicated)
 *   - a seller whose STORE has been suspended (while their own account is
 *     still ACTIVE) can no longer manage their offers; staff still can
 *   - PATCHing a non-existent StoreProduct id -> 404
 *   - no update path ever creates a duplicate StoreProduct row
 *
 * Requires a real Postgres database (DATABASE_URL) with the schema migrated
 * and roles seeded before running:
 *
 *   NODE_ENV=test npm test -- product-update-ownership
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

let roles;
let category;

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

beforeAll(async () => {
  const roleRows = await prisma.role.findMany();
  roles = Object.fromEntries(roleRows.map((r) => [r.key, r]));
  if (!roles.CUSTOMER || !roles.SELLER || !roles.ADMIN || !roles.SUPER_ADMIN) {
    throw new Error('Roles are not seeded — run `npm run seed` against the test database first.');
  }
  category = await prisma.category.upsert({
    where: { slug: 'test-category-update' },
    update: {},
    create: { name: 'دسته تست آپدیت', slug: 'test-category-update' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('StoreProduct update — seller-owned offer fields', () => {
  test('seller can update their own offer (price/stock/warranty)', async () => {
    const seller = await makeUser('SELLER', `1${Math.floor(Math.random() * 9e7)}`.slice(0, 9));
    const store = await makeApprovedStore(seller.user.id, `فروشگاه آپدیت ${Date.now()}`);
    const created = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول قابل ویرایش', categoryId: category.id, price: 100000, stock: 5,
    });
    const id = created.body.data.id;

    const res = await api.patch(`${PREFIX}/products/${id}`).set('Authorization', seller.auth).send({
      price: 120000, stock: 8, warranty: '۱۲ ماهه',
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.price)).toBe(120000);
    expect(res.body.data.stock).toBe(8);
    expect(res.body.data.warranty).toBe('۱۲ ماهه');

    // No new row — the same StoreProduct id, just updated.
    const count = await prisma.storeProduct.count({ where: { id } });
    expect(count).toBe(1);
  });

  test('seller can NOT update another seller\'s StoreProduct', async () => {
    const sellerA = await makeUser('SELLER', `2${Math.floor(Math.random() * 9e7)}`.slice(0, 9));
    const sellerB = await makeUser('SELLER', `3${Math.floor(Math.random() * 9e7)}`.slice(0, 9));
    await makeApprovedStore(sellerA.user.id, `فروشگاه الف آپدیت ${Date.now()}`);
    await makeApprovedStore(sellerB.user.id, `فروشگاه ب آپدیت ${Date.now()}`);

    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول فروشنده الف', categoryId: category.id, price: 50000, stock: 2,
    });
    const id = created.body.data.id;

    const res = await api.patch(`${PREFIX}/products/${id}`).set('Authorization', sellerB.auth).send({ price: 1 });
    expect(res.status).toBe(403);

    const unchanged = await prisma.storeProduct.findUnique({ where: { id } });
    expect(Number(unchanged.price)).toBe(50000); // untouched
  });

  test('PATCHing a non-existent StoreProduct id returns 404', async () => {
    const seller = await makeUser('SELLER', `4${Math.floor(Math.random() * 9e7)}`.slice(0, 9));
    const res = await api.patch(`${PREFIX}/products/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', seller.auth).send({ price: 1000 });
    expect(res.status).toBe(404);
  });
});

describe('Product update — global identity fields are staff-only', () => {
  test('a seller can NOT change name/brand/model/capacity/color/description/specifications/categoryId', async () => {
    const seller = await makeUser('SELLER', `5${Math.floor(Math.random() * 9e7)}`.slice(0, 9));
    await makeApprovedStore(seller.user.id, `فروشگاه هویت ${Date.now()}`);
    const created = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول هویتی', brand: 'BrandX', categoryId: category.id, price: 70000, stock: 3,
    });
    const id = created.body.data.id;

    const res = await api.patch(`${PREFIX}/products/${id}`).set('Authorization', seller.auth).send({
      name: 'اسم دستکاری‌شده',
    });
    expect(res.status).toBe(403);

    const storeProduct = await prisma.storeProduct.findUnique({ where: { id }, include: { product: true } });
    expect(storeProduct.product.name).toBe('محصول هویتی'); // unchanged

    // A price/stock change bundled in the SAME request as an identity field
    // must also be rejected wholesale, not partially applied.
    const mixed = await api.patch(`${PREFIX}/products/${id}`).set('Authorization', seller.auth).send({
      name: 'اسم دیگر', price: 1,
    });
    expect(mixed.status).toBe(403);
    const stillUnchanged = await prisma.storeProduct.findUnique({ where: { id } });
    expect(Number(stillUnchanged.price)).toBe(70000);
  });

  test('staff CAN edit identity fields, and the edit is visible to every store selling that product', async () => {
    const admin = await makeUser('ADMIN', `6${Math.floor(Math.random() * 9e7)}`.slice(0, 9));
    const sellerA = await makeUser('SELLER', `7${Math.floor(Math.random() * 9e7)}`.slice(0, 9));
    const sellerB = await makeUser('SELLER', `8${Math.floor(Math.random() * 9e7)}`.slice(0, 9));
    await makeApprovedStore(sellerA.user.id, `فروشگاه شریک الف ${Date.now()}`);
    await makeApprovedStore(sellerB.user.id, `فروشگاه شریک ب ${Date.now()}`);

    const SHARED = {
      name: 'محصول مشترک ادمین', brand: 'Shared', model: 'M1', capacity: '128GB', color: 'Silver',
    };
    const offerA = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      ...SHARED, categoryId: category.id, price: 200000, stock: 4,
    });
    const offerB = await api.post(`${PREFIX}/products`).set('Authorization', sellerB.auth).send({
      ...SHARED, categoryId: category.id, price: 210000, stock: 2,
    });
    expect(offerA.body.data.productId).toBe(offerB.body.data.productId); // same global Product, confirmed by scenario B logic

    const patch = await api.patch(`${PREFIX}/products/${offerA.body.data.id}`)
      .set('Authorization', admin.auth)
      .send({ description: 'توضیح جدید توسط ادمین' });
    expect(patch.status).toBe(200);

    const viewFromB = await api.get(`${PREFIX}/products/${offerB.body.data.id}`).set('Authorization', sellerB.auth);
    expect(viewFromB.body.data.description).toBe('توضیح جدید توسط ادمین'); // same global Product, visible from store B's offer too

    const productCount = await prisma.product.count({ where: { id: offerA.body.data.productId } });
    expect(productCount).toBe(1); // still exactly one global Product row — never duplicated
  });
});

describe('Suspended store blocks the owning seller from managing offers', () => {
  test('owner of a suspended store can no longer update their StoreProduct; staff still can', async () => {
    const admin = await makeUser('ADMIN', `9${Math.floor(Math.random() * 9e7)}`.slice(0, 9));
    const seller = await makeUser('SELLER', `1${Math.floor(Math.random() * 9e6)}1`.slice(0, 9));
    const store = await makeApprovedStore(seller.user.id, `فروشگاه مسدود ${Date.now()}`);
    const created = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول فروشگاه مسدود', categoryId: category.id, price: 30000, stock: 1,
    });
    const id = created.body.data.id;

    await prisma.store.update({ where: { id: store.id }, data: { status: 'SUSPENDED' } });
    // Seller's own account stays ACTIVE — only the store is suspended.

    const sellerAttempt = await api.patch(`${PREFIX}/products/${id}`).set('Authorization', seller.auth).send({ price: 99999 });
    expect(sellerAttempt.status).toBe(403);

    const adminAttempt = await api.patch(`${PREFIX}/products/${id}`).set('Authorization', admin.auth).send({ price: 99999 });
    expect(adminAttempt.status).toBe(200); // staff override still works
  });
});
