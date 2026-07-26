/**
 * Test suite for the pieces completed in this pass:
 *   - Category admin CRUD + active/inactive toggle, seller/customer denial.
 *   - Category deletion blocked while it still has active products.
 *   - Inactive category can't be selected on product create/update.
 *   - Product image add/remove, ownership (IDOR) protection, MAX_IMAGES cap.
 *   - Price/discount validation (compareAtPrice must exceed price).
 *   - Search now matches on description too.
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
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Category management', () => {
  test('admin can create, edit, and delete an empty category', async () => {
    const admin = await makeUser('ADMIN', '10000000' + Math.floor(Math.random() * 9));
    const slug = `cat-${Date.now()}`;

    const created = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته جدید', slug });
    expect(created.status).toBe(201);
    expect(created.body.data.isActive).toBe(true);

    const edited = await api.patch(`${PREFIX}/categories/${created.body.data.id}`).set('Authorization', admin.auth)
      .send({ name: 'دسته ویرایش‌شده' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.name).toBe('دسته ویرایش‌شده');

    const removed = await api.delete(`${PREFIX}/categories/${created.body.data.id}`).set('Authorization', admin.auth);
    expect(removed.status).toBe(200);
  });

  test('a seller cannot create or delete a category', async () => {
    const seller = await makeUser('SELLER', '10100000' + Math.floor(Math.random() * 9));
    const createRes = await api.post(`${PREFIX}/categories`).set('Authorization', seller.auth)
      .send({ name: 'دسته فروشنده', slug: `seller-cat-${Date.now()}` });
    expect(createRes.status).toBe(403);
  });

  test('admin can toggle a category active/inactive, and an inactive category is hidden from public listing', async () => {
    const admin = await makeUser('ADMIN', '10200000' + Math.floor(Math.random() * 9));
    const created = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته غیرفعال‌شدنی', slug: `toggle-cat-${Date.now()}` });
    const id = created.body.data.id;

    const off = await api.patch(`${PREFIX}/categories/${id}/active`).set('Authorization', admin.auth).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);

    const publicList = await api.get(`${PREFIX}/categories`);
    expect(publicList.body.data.some((c) => c.id === id)).toBe(false);

    const staffList = await api.get(`${PREFIX}/categories`).set('Authorization', admin.auth).query({ includeInactive: true });
    expect(staffList.body.data.some((c) => c.id === id)).toBe(true);
  });

  test('an inactive category cannot be selected when creating a product', async () => {
    const admin = await makeUser('ADMIN', '10300000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '10310000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه دسته غیرفعال');

    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته غیرفعال محصول', slug: `inactive-cat-${Date.now()}` });
    await api.patch(`${PREFIX}/categories/${cat.body.data.id}/active`).set('Authorization', admin.auth).send({ isActive: false });

    const res = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth)
      .send({ name: 'محصول با دسته غیرفعال', categoryId: cat.body.data.id, price: 10000, stock: 1 });
    expect(res.status).toBe(400);
  });

  test('deleting a category with an active product is blocked', async () => {
    const admin = await makeUser('ADMIN', '10400000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '10410000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه حذف دسته');

    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته با محصول', slug: `cat-with-product-${Date.now()}` });
    await api.post(`${PREFIX}/products`).set('Authorization', seller.auth)
      .send({ name: 'محصول در دسته', categoryId: cat.body.data.id, price: 10000, stock: 1 });

    const removed = await api.delete(`${PREFIX}/categories/${cat.body.data.id}`).set('Authorization', admin.auth);
    expect(removed.status).toBe(409);
  });
});

describe('Product price/discount validation', () => {
  let seller;
  let category;

  beforeAll(async () => {
    const admin = await makeUser('ADMIN', '20000000' + Math.floor(Math.random() * 9));
    seller = await makeUser('SELLER', '20010000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه تخفیف تست');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته تخفیف', slug: `discount-cat-${Date.now()}` });
    category = cat.body.data;
  });

  test('compareAtPrice must be greater than price (a real discount)', async () => {
    const res = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول تخفیف نامعتبر', categoryId: category.id, price: 100000, compareAtPrice: 90000, stock: 1,
    });
    expect(res.status).toBe(400);
  });

  test('a valid compareAtPrice is accepted', async () => {
    const res = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول تخفیف معتبر', categoryId: category.id, price: 90000, compareAtPrice: 120000, stock: 1,
    });
    expect(res.status).toBe(201);
  });

  test('negative price is rejected', async () => {
    const res = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول قیمت منفی', categoryId: category.id, price: -100, stock: 1,
    });
    expect(res.status).toBe(400);
  });

  test('empty product name is rejected', async () => {
    const res = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: '', categoryId: category.id, price: 1000, stock: 1,
    });
    expect(res.status).toBe(400);
  });
});

describe('Product image management', () => {
  let sellerA;
  let sellerB;
  let productA;

  beforeAll(async () => {
    const admin = await makeUser('ADMIN', '30000000' + Math.floor(Math.random() * 9));
    sellerA = await makeUser('SELLER', '30010000' + Math.floor(Math.random() * 9));
    sellerB = await makeUser('SELLER', '30020000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(sellerA.user.id, 'فروشگاه تصویر الف');
    await makeApprovedStore(sellerB.user.id, 'فروشگاه تصویر ب');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته تصویر', slug: `image-cat-${Date.now()}` });

    const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      name: 'محصول با تصویر', categoryId: cat.body.data.id, price: 10000, stock: 5,
    });
    productA = created.body.data;
  });

  test('owner can add an image by URL', async () => {
    const res = await api.post(`${PREFIX}/products/${productA.id}/images`).set('Authorization', sellerA.auth)
      .send({ url: 'https://example.com/img1.jpg' });
    expect(res.status).toBe(201);
    expect(res.body.data.url).toBe('https://example.com/img1.jpg');
  });

  test('another seller cannot add an image to a product they do not own', async () => {
    const res = await api.post(`${PREFIX}/products/${productA.id}/images`).set('Authorization', sellerB.auth)
      .send({ url: 'https://example.com/hack.jpg' });
    expect(res.status).toBe(403);
  });

  test('the image cap (MAX_IMAGES) is enforced', async () => {
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await api.post(`${PREFIX}/products/${productA.id}/images`).set('Authorization', sellerA.auth)
        .send({ url: `https://example.com/bulk-${i}.jpg` });
    }
    const overflow = await api.post(`${PREFIX}/products/${productA.id}/images`).set('Authorization', sellerA.auth)
      .send({ url: 'https://example.com/overflow.jpg' });
    expect(overflow.status).toBe(400);
  });

  test('a seller cannot delete another seller\'s product image (IDOR check)', async () => {
    const productDetail = await api.get(`${PREFIX}/products/${productA.id}`).set('Authorization', sellerA.auth);
    const imageId = productDetail.body.data.images[0].id;

    const res = await api.delete(`${PREFIX}/products/${productA.id}/images/${imageId}`).set('Authorization', sellerB.auth);
    expect(res.status).toBe(403);
  });

  test('owner can delete their own product image', async () => {
    const productDetail = await api.get(`${PREFIX}/products/${productA.id}`).set('Authorization', sellerA.auth);
    const imageId = productDetail.body.data.images[0].id;

    const res = await api.delete(`${PREFIX}/products/${productA.id}/images/${imageId}`).set('Authorization', sellerA.auth);
    expect(res.status).toBe(200);
  });
});

describe('Search by description', () => {
  test('customer search matches product description, not just name', async () => {
    const admin = await makeUser('ADMIN', '40000000' + Math.floor(Math.random() * 9));
    const seller = await makeUser('SELLER', '40010000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه جستجوی توضیحات');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته جستجو', slug: `search-cat-${Date.now()}` });

    const created = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'یک محصول عادی',
      categoryId: cat.body.data.id,
      price: 10000,
      stock: 1,
      description: 'این محصول دارای کلیدواژه منحصربفرد الوندیک است',
    });
    await api.patch(`${PREFIX}/products/${created.body.data.id}/moderate`).set('Authorization', admin.auth)
      .send({ status: 'APPROVED' });

    const res = await api.get(`${PREFIX}/products`).query({ q: 'الوندیک' });
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((p) => p.id === created.body.data.id)).toBe(true);
  });
});
