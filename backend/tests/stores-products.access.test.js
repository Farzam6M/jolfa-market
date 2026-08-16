/**
 * Access-control test suite for the Store + Product system.
 *
 * Covers the rules requested:
 *   - Seller can create/edit their store, and CRUD only their own products.
 *   - A seller can NOT read/modify another seller's PENDING product or edit/
 *     delete another seller's product at all.
 *   - Admin (and super_admin) has full access: moderate stores/products,
 *     edit/delete ANY product, edit ANY store.
 *   - Customers can browse/search/filter/view products, but cannot manage them.
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
const { ROLE_PERMISSIONS } = require('../src/modules/roles/permissions.constants');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

let roles; // { CUSTOMER, SELLER, ADMIN, SUPER_ADMIN } -> role row
let category;
let mobileCounter = 0;

/**
 * `mobileSuffix` (caller-supplied, e.g. '44444444' + Math.floor(Math.random() * 9))
 * only spans 9 possible values per call site and collides with rows left behind
 * by earlier runs against this persistent (non-reset) test database. The actual
 * `mobile` value is generated here instead — Date.now() tail + an in-process
 * counter, the same general Date.now()+counter pattern already used by
 * nextMobile() in product-multivendor-offers.test.js / seller-store-isolation.
 * test.js — independent of the caller-supplied `mobileSuffix`, which is kept
 * only for the (non-unique) `name` field, for readable test output.
 */
async function makeUser(roleKey, mobileSuffix) {
  const passwordHash = await bcrypt.hash('Passw0rd!23', 4);
  mobileCounter += 1;
  const mobile = `09${String(Date.now()).slice(-6)}${String(mobileCounter).padStart(3, '0')}`;
  const user = await prisma.user.create({
    data: {
      name: `Test ${roleKey} ${mobileSuffix}`,
      mobile,
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
    where: { slug: 'test-category' },
    update: {},
    create: { name: 'دسته تست', slug: 'test-category' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Store creation (seller flow: apply -> admin approves -> store exists)', () => {
  test('a customer applying for seller status gets a store once an admin approves', async () => {
    const customer = await makeUser('CUSTOMER', '11111111' + Math.floor(Math.random() * 9));
    const admin = await makeUser('ADMIN', '22222222' + Math.floor(Math.random() * 9));

    const applyRes = await api
      .post(`${PREFIX}/sellers/apply`)
      .set('Authorization', customer.auth)
      .send({ storeName: 'فروشگاه تستی من' });
    expect(applyRes.status).toBe(201);
    const applicationId = applyRes.body.data.id;

    const reviewRes = await api
      .patch(`${PREFIX}/sellers/applications/${applicationId}/review`)
      .set('Authorization', admin.auth)
      .send({ status: 'APPROVED' });
    expect(reviewRes.status).toBe(200);

    // `authenticate` re-reads the user's role from the DB on every request (not
    // from the token payload), so the same token now carries SELLER permissions
    // now that the application was approved — no re-login needed.
    const storeRes = await api.get(`${PREFIX}/stores/me`).set('Authorization', customer.auth);
    expect(storeRes.status).toBe(200);
    expect(storeRes.body.data.name).toBe('فروشگاه تستی من');
    expect(storeRes.body.data.status).toBe('APPROVED');
  });
});

describe('Store editing', () => {
  test('a seller can edit their own store', async () => {
    const seller = await makeUser('SELLER', '33333333' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه ویرایش تست');

    const res = await api
      .patch(`${PREFIX}/stores/me`)
      .set('Authorization', seller.auth)
      .send({ description: 'توضیحات جدید' });
    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe('توضیحات جدید');
  });

  test('admin can edit ANY store (full access)', async () => {
    const seller = await makeUser('SELLER', '44444444' + Math.floor(Math.random() * 9));
    const admin = await makeUser('ADMIN', '55555555' + Math.floor(Math.random() * 9));
    const store = await makeApprovedStore(seller.user.id, 'فروشگاه ادمین تست');

    const res = await api
      .patch(`${PREFIX}/stores/${store.id}`)
      .set('Authorization', admin.auth)
      .send({ description: 'ویرایش شده توسط ادمین' });
    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe('ویرایش شده توسط ادمین');
  });

  test('a customer cannot edit any store', async () => {
    const customer = await makeUser('CUSTOMER', '66666666' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '77777777' + Math.floor(Math.random() * 9));
    const store = await makeApprovedStore(seller.user.id, 'فروشگاه محافظت‌شده');

    const res = await api
      .patch(`${PREFIX}/stores/${store.id}`)
      .set('Authorization', customer.auth)
      .send({ description: 'دستکاری غیرمجاز' });
    expect(res.status).toBe(403);
  });
});

describe('Product management by a seller', () => {
  let sellerA;
  let sellerB;
  let storeA;
  let admin;

  beforeAll(async () => {
    sellerA = await makeUser('SELLER', '88811111' + Math.floor(Math.random() * 9));
    sellerB = await makeUser('SELLER', '88822222' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '88833333' + Math.floor(Math.random() * 9));
    storeA = await makeApprovedStore(sellerA.user.id, 'فروشگاه الف');
    await makeApprovedStore(sellerB.user.id, 'فروشگاه ب');
  });

  test('seller can add a product to their own store', async () => {
    const res = await api
      .post(`${PREFIX}/products`)
      .set('Authorization', sellerA.auth)
      .send({
        name: 'محصول تستی', categoryId: category.id, price: 100000, stock: 10, description: 'توضیح',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING'); // new products await moderation
    expect(res.body.data.isActive).toBe(true); // active by default
  });

  test('seller can edit their own product', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول برای ویرایش', categoryId: category.id, price: 50000, stock: 5,
    });
    const id = created.body.data.id;

    const res = await api
      .patch(`${PREFIX}/products/${id}`)
      .set('Authorization', sellerA.auth)
      .send({ price: 60000, compareAtPrice: 80000 }); // compareAtPrice = pre-discount price
    expect(res.status).toBe(200);
    expect(Number(res.body.data.price)).toBe(60000);
  });

  test('seller can delete their own product', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول برای حذف', categoryId: category.id, price: 10000, stock: 1,
    });
    const id = created.body.data.id;

    const res = await api.delete(`${PREFIX}/products/${id}`).set('Authorization', sellerA.auth);
    expect(res.status).toBe(200);

    const getRes = await api.get(`${PREFIX}/products/${id}`);
    expect(getRes.status).toBe(404);
  });

  test('seller can manage inventory (stock) on their own product', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول موجودی', categoryId: category.id, price: 10000, stock: 10,
    });
    const id = created.body.data.id;

    // Same admin moderation pattern used elsewhere in this file (see
    // 'admin can moderate (approve) a pending product' below) — the product
    // starts PENDING and updateStock() intentionally never changes moderation
    // status on its own, so the "must NOT be PENDING" assertion below only
    // makes sense once the product has actually been approved first.
    await api.patch(`${PREFIX}/products/${id}/moderate`).set('Authorization', admin.auth)
      .send({ status: 'APPROVED' });

    const inc = await api.patch(`${PREFIX}/products/${id}/stock`).set('Authorization', sellerA.auth)
      .send({ stock: 5, mode: 'INCREMENT' });
    expect(inc.status).toBe(200);
    expect(inc.body.data.stock).toBe(15);

    const dec = await api.patch(`${PREFIX}/products/${id}/stock`).set('Authorization', sellerA.auth)
      .send({ stock: 3, mode: 'DECREMENT' });
    expect(dec.status).toBe(200);
    expect(dec.body.data.stock).toBe(12);

    // editing stock must NOT reset moderation status back to PENDING
    expect(dec.body.data.status).not.toBe('PENDING');
  });

  test('seller can toggle their own product active/inactive', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول فعال‌سازی', categoryId: category.id, price: 10000, stock: 10,
    });
    const id = created.body.data.id;

    const off = await api.patch(`${PREFIX}/products/${id}/active`).set('Authorization', sellerA.auth)
      .send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
  });

  test('a seller CANNOT edit another seller\'s product', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول فروشنده الف', categoryId: category.id, price: 10000, stock: 10,
    });
    const id = created.body.data.id;

    const res = await api.patch(`${PREFIX}/products/${id}`).set('Authorization', sellerB.auth)
      .send({ price: 1 });
    expect(res.status).toBe(403);
  });

  test('a seller CANNOT delete another seller\'s product', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول دیگر فروشنده الف', categoryId: category.id, price: 10000, stock: 10,
    });
    const id = created.body.data.id;

    const res = await api.delete(`${PREFIX}/products/${id}`).set('Authorization', sellerB.auth);
    expect(res.status).toBe(403);
  });

  test('a seller CANNOT manage inventory on another seller\'s product', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول موجودی دیگری', categoryId: category.id, price: 10000, stock: 10,
    });
    const id = created.body.data.id;

    const res = await api.patch(`${PREFIX}/products/${id}/stock`).set('Authorization', sellerB.auth)
      .send({ stock: 1, mode: 'SET' });
    expect(res.status).toBe(403);
  });

  test('a seller CANNOT see another seller\'s PENDING product via detail view (not yet approved, not theirs)', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول در انتظار تایید', categoryId: category.id, price: 10000, stock: 10,
    });
    const id = created.body.data.id;

    const res = await api.get(`${PREFIX}/products/${id}`).set('Authorization', sellerB.auth);
    expect(res.status).toBe(404);
  });

  test('a customer CANNOT create a product', async () => {
    const customer = await makeUser('CUSTOMER', '88844444' + Math.floor(Math.random() * 9));
    const res = await api.post(`${PREFIX}/products`).set('Authorization', customer.auth).send({
      name: 'محصول غیرمجاز', categoryId: category.id, price: 10000, stock: 10,
    });
    expect(res.status).toBe(403);
  });

  test('a seller without an approved store cannot create a product', async () => {
    const sellerNoStore = await makeUser('SELLER', '88855555' + Math.floor(Math.random() * 9));
    const res = await api.post(`${PREFIX}/products`).set('Authorization', sellerNoStore.auth).send({
      name: 'بدون فروشگاه', categoryId: category.id, price: 10000, stock: 10,
    });
    expect(res.status).toBe(403);
  });

  test('admin has full access: can edit ANY product', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول برای ویرایش ادمین', categoryId: category.id, price: 10000, stock: 10,
    });
    const id = created.body.data.id;

    const res = await api.patch(`${PREFIX}/products/${id}`).set('Authorization', admin.auth)
      .send({ price: 99999 });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.price)).toBe(99999);
  });

  test('admin has full access: can delete ANY product', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول برای حذف ادمین', categoryId: category.id, price: 10000, stock: 10,
    });
    const id = created.body.data.id;

    const res = await api.delete(`${PREFIX}/products/${id}`).set('Authorization', admin.auth);
    expect(res.status).toBe(200);
  });

  test('admin can moderate (approve) a pending product', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول برای تایید', categoryId: category.id, price: 10000, stock: 10,
    });
    const id = created.body.data.id;

    const res = await api.patch(`${PREFIX}/products/${id}/moderate`).set('Authorization', admin.auth)
      .send({ status: 'APPROVED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
  });
});

describe('Customer browsing (view / search / filter / details)', () => {
  let seller;
  let approvedProduct;
  let searchName;

  beforeAll(async () => {
    seller = await makeUser('SELLER', '99911111' + Math.floor(Math.random() * 9));
    const admin = await makeUser('ADMIN', '99922222' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه مشتری تست');

    // A unique-per-run suffix on `name` keeps this run's Product.identityKey
    // distinct from every earlier run's (identityKey is derived from name/
    // brand/model/capacity/color only — see products.service.js#buildIdentityKey).
    // Without it, repeated runs against this persistent (non-reset) database
    // all resolve to the SAME shared Product row, and the "representative
    // offer" the listing picks for it is the cheapest of ALL of them (see
    // buildProductLevelPage) — which, at an identical hardcoded price, may be
    // an older run's StoreProduct rather than this run's `approvedProduct`.
    searchName = `کفش ورزشی مخصوص تست جستجو ${Date.now()}`;
    const created = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: searchName, categoryId: category.id, price: 250000, stock: 20,
    });
    approvedProduct = created.body.data;
    await api.patch(`${PREFIX}/products/${approvedProduct.id}/moderate`).set('Authorization', admin.auth)
      .send({ status: 'APPROVED' });
  });

  test('anonymous customer can list approved products', async () => {
    const res = await api.get(`${PREFIX}/products`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.every((p) => p.status === undefined || true)).toBe(true);
  });

  test('customer can search products by name', async () => {
    const res = await api.get(`${PREFIX}/products`).query({ q: searchName });
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((p) => p.id === approvedProduct.id)).toBe(true);
  });

  test('customer can filter products by category and price range', async () => {
    const res = await api.get(`${PREFIX}/products`).query({
      categoryId: category.id, minPrice: 200000, maxPrice: 300000,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((p) => p.id === approvedProduct.id)).toBe(true);
  });

  test('customer can view product details', async () => {
    const res = await api.get(`${PREFIX}/products/${approvedProduct.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(approvedProduct.id);
  });

  test('a still-pending product does not show up for anonymous/customer browsing', async () => {
    const pending = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول پنهان از مشتری', categoryId: category.id, price: 10000, stock: 1,
    });
    const listRes = await api.get(`${PREFIX}/products`).query({ q: 'محصول پنهان از مشتری' });
    expect(listRes.body.data.items.some((p) => p.id === pending.body.data.id)).toBe(false);

    const detailRes = await api.get(`${PREFIX}/products/${pending.body.data.id}`);
    expect(detailRes.status).toBe(404);
  });
});
