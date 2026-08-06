/**
 * Admin Panel & Moderation Audit (post Product -> StoreProduct refactor).
 *
 * This suite fills gaps not covered by the existing test files
 * (product-storeproduct-dedup.test.js, seller-store-isolation.test.js,
 * stores-products.access.test.js): it verifies, at the HTTP-API level, the
 * exact scenarios called out by the audit brief:
 *
 *   1. PRODUCT MODERATION — admin approve/reject applies to StoreProduct only.
 *      Same global Product, Store A offer PENDING / Store B offer APPROVED:
 *      approving/rejecting A must never change B's status, isActive, or
 *      rejectReason (and vice versa).
 *   2. PRODUCT CATALOG PROTECTION — moderating an offer must never write to
 *      the shared Product row's identity fields (name/brand/model/capacity/
 *      color/description/specifications/categoryId/identityKey/slug).
 *   3. MULTI-STORE MODERATION — each offer's status/isActive/rejectReason is
 *      independent, including the reject-reason text itself.
 *   4. ADMIN LISTS/FILTERS — GET /products?status=X (staff view) returns one
 *      row per StoreProduct offer (not deduped per Product), so an admin
 *      pending/approved/rejected queue reflects every store's own offer.
 *   5. RBAC — only PRODUCTS_MODERATE holders (ADMIN/SUPER_ADMIN) may call
 *      PATCH /products/:id/moderate or the /:id/status alias. A SELLER
 *      (even the owning seller of that exact offer) and a CUSTOMER must get
 *      403, not a silent no-op or 200.
 *
 * Requires a real Postgres database (DATABASE_URL), migrated + seeded:
 *   NODE_ENV=test npm test -- admin-moderation-audit
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

let roles;
let mobileCounter = 0;

function nextMobile() {
  mobileCounter += 1;
  return `0936${String(Date.now()).slice(-4)}${String(mobileCounter).padStart(3, '0')}`;
}

async function makeUser(roleKey) {
  const passwordHash = await bcrypt.hash('Passw0rd!23', 4);
  const user = await prisma.user.create({
    data: {
      name: `Test ${roleKey} ${mobileCounter}`,
      mobile: nextMobile(),
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

async function makeCategory(adminAuth, name) {
  const res = await api.post(`${PREFIX}/categories`).set('Authorization', adminAuth)
    .send({ name, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
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

describe('1/2/3 — Moderation isolation between stores selling the same shared Product', () => {
  let admin;
  let sellerA;
  let sellerB;
  let storeA;
  let storeB;
  let category;
  let identity;
  let offerAId;
  let offerBId;
  let sharedProductId;
  let originalProductSnapshot;

  beforeAll(async () => {
    admin = await makeUser('ADMIN');
    sellerA = await makeUser('SELLER');
    sellerB = await makeUser('SELLER');
    storeA = await makeApprovedStore(sellerA.user.id, `فروشگاه ممیزی الف ${Date.now()}`);
    storeB = await makeApprovedStore(sellerB.user.id, `فروشگاه ممیزی ب ${Date.now()}`);
    category = await makeCategory(admin.auth, `دسته ممیزی ${Date.now()}`);

    identity = {
      name: `گوشی ممیزی مشترک ${Date.now()}`, brand: 'برند-ممیزی', model: 'مدل-M', capacity: '128GB', color: 'مشکی',
    };

    const createA = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      ...identity, categoryId: category.id, price: 15000, stock: 3,
    });
    const createB = await api.post(`${PREFIX}/products`).set('Authorization', sellerB.auth).send({
      ...identity, categoryId: category.id, price: 16000, stock: 4,
    });
    offerAId = createA.body.data.id;
    offerBId = createB.body.data.id;
    sharedProductId = createA.body.data.productId;
    expect(createB.body.data.productId).toBe(sharedProductId); // same identity -> same global Product

    // Approve B up front so A and B start in genuinely different states
    // (PENDING vs APPROVED), matching the audit brief's exact example.
    await api.patch(`${PREFIX}/products/${offerBId}/moderate`).set('Authorization', admin.auth).send({ status: 'APPROVED' });

    originalProductSnapshot = await prisma.product.findUnique({ where: { id: sharedProductId } });
  });

  test('Store A offer is PENDING, Store B offer is APPROVED, before any moderation of A', async () => {
    const a = await prisma.storeProduct.findUnique({ where: { id: offerAId } });
    const b = await prisma.storeProduct.findUnique({ where: { id: offerBId } });
    expect(a.status).toBe('PENDING');
    expect(b.status).toBe('APPROVED');
  });

  test('admin approving Store A does not change Store B (status, isActive, rejectReason untouched)', async () => {
    const bBefore = await prisma.storeProduct.findUnique({ where: { id: offerBId } });

    const res = await api.patch(`${PREFIX}/products/${offerAId}/moderate`).set('Authorization', admin.auth)
      .send({ status: 'APPROVED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');

    const aAfter = await prisma.storeProduct.findUnique({ where: { id: offerAId } });
    const bAfter = await prisma.storeProduct.findUnique({ where: { id: offerBId } });
    expect(aAfter.status).toBe('APPROVED');
    // Store B is completely unaffected by A's moderation.
    expect(bAfter.status).toBe(bBefore.status);
    expect(bAfter.isActive).toBe(bBefore.isActive);
    expect(bAfter.rejectReason).toBe(bBefore.rejectReason);
    expect(Number(bAfter.price)).toBe(Number(bBefore.price));
  });

  test('admin rejecting Store B (with a reason) does not change Store A, and the rejection reason is scoped to B only', async () => {
    const aBefore = await prisma.storeProduct.findUnique({ where: { id: offerAId } });

    const res = await api.patch(`${PREFIX}/products/${offerBId}/moderate`).set('Authorization', admin.auth)
      .send({ status: 'REJECTED', note: 'تصاویر محصول واضح نیست' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REJECTED');

    const aAfter = await prisma.storeProduct.findUnique({ where: { id: offerAId } });
    const bAfter = await prisma.storeProduct.findUnique({ where: { id: offerBId } });

    // Store A (already APPROVED from the previous test) is untouched.
    expect(aAfter.status).toBe(aBefore.status);
    expect(aAfter.rejectReason).toBeNull();
    expect(aAfter.reviewedById).toBe(aBefore.reviewedById);

    // Store B alone carries the rejection + its reason.
    expect(bAfter.status).toBe('REJECTED');
    expect(bAfter.rejectReason).toBe('تصاویر محصول واضح نیست');
  });

  test('neither moderation action touched the shared Product row\'s identity fields', async () => {
    const productAfter = await prisma.product.findUnique({ where: { id: sharedProductId } });
    expect(productAfter.name).toBe(originalProductSnapshot.name);
    expect(productAfter.brand).toBe(originalProductSnapshot.brand);
    expect(productAfter.model).toBe(originalProductSnapshot.model);
    expect(productAfter.capacity).toBe(originalProductSnapshot.capacity);
    expect(productAfter.color).toBe(originalProductSnapshot.color);
    expect(productAfter.categoryId).toBe(originalProductSnapshot.categoryId);
    expect(productAfter.identityKey).toBe(originalProductSnapshot.identityKey);
    expect(productAfter.slug).toBe(originalProductSnapshot.slug);
    expect(productAfter.updatedAt.getTime()).toBe(originalProductSnapshot.updatedAt.getTime());
  });

  test('each offer keeps independent isActive: deactivating Store A\'s (approved) offer leaves Store B alone', async () => {
    const bBefore = await prisma.storeProduct.findUnique({ where: { id: offerBId } });

    const res = await api.patch(`${PREFIX}/products/${offerAId}/active`).set('Authorization', sellerA.auth)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);

    const bAfter = await prisma.storeProduct.findUnique({ where: { id: offerBId } });
    expect(bAfter.isActive).toBe(bBefore.isActive);
    expect(bAfter.status).toBe(bBefore.status);
  });

  test('admin list/filter by status returns one row per StoreProduct offer, not deduped per Product', async () => {
    // At this point: offer A = APPROVED (isActive:false), offer B = REJECTED — both point at sharedProductId.
    const approvedRes = await api.get(`${PREFIX}/products`).query({ status: 'APPROVED', pageSize: 200 }).set('Authorization', admin.auth);
    expect(approvedRes.status).toBe(200);
    expect(approvedRes.body.data.items.some((it) => it.id === offerAId)).toBe(true);
    expect(approvedRes.body.data.items.some((it) => it.id === offerBId)).toBe(false);

    const rejectedRes = await api.get(`${PREFIX}/products`).query({ status: 'REJECTED', pageSize: 200 }).set('Authorization', admin.auth);
    expect(rejectedRes.status).toBe(200);
    expect(rejectedRes.body.data.items.some((it) => it.id === offerBId)).toBe(true);
    const rejectedOffer = rejectedRes.body.data.items.find((it) => it.id === offerBId);
    expect(rejectedOffer.rejectReason).toBe('تصاویر محصول واضح نیست');
    expect(rejectedOffer.productId).toBe(sharedProductId); // still points at the shared Product...
    // ...but the two offers surface as two distinct list rows (id differs), never merged into one.
    expect(approvedRes.body.data.items.find((it) => it.id === offerAId).productId).toBe(sharedProductId);
  });
});

describe('5 — RBAC on moderation endpoints', () => {
  let admin;
  let superAdmin;
  let seller;
  let customer;
  let store;
  let category;
  let pendingOfferId;

  beforeAll(async () => {
    admin = await makeUser('ADMIN');
    superAdmin = await makeUser('SUPER_ADMIN');
    seller = await makeUser('SELLER');
    customer = await makeUser('CUSTOMER');
    store = await makeApprovedStore(seller.user.id, `فروشگاه آر‌بی‌ای‌سی ${Date.now()}`);
    category = await makeCategory(admin.auth, `دسته آر‌بی‌ای‌سی ${Date.now()}`);

    const created = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: `محصول آر‌بی‌ای‌سی ${Date.now()}`, categoryId: category.id, price: 12000, stock: 2,
    });
    pendingOfferId = created.body.data.id;
  });

  test('a CUSTOMER cannot call /moderate — 403, and the offer stays PENDING', async () => {
    const res = await api.patch(`${PREFIX}/products/${pendingOfferId}/moderate`).set('Authorization', customer.auth)
      .send({ status: 'APPROVED' });
    expect(res.status).toBe(403);
    const offer = await prisma.storeProduct.findUnique({ where: { id: pendingOfferId } });
    expect(offer.status).toBe('PENDING');
  });

  test('the SELLER who owns this exact offer still cannot self-approve via /moderate — 403', async () => {
    const res = await api.patch(`${PREFIX}/products/${pendingOfferId}/moderate`).set('Authorization', seller.auth)
      .send({ status: 'APPROVED' });
    expect(res.status).toBe(403);
    const offer = await prisma.storeProduct.findUnique({ where: { id: pendingOfferId } });
    expect(offer.status).toBe('PENDING');
  });

  test('a different SELLER (no relation to this offer) cannot call /moderate — 403', async () => {
    const otherSeller = await makeUser('SELLER');
    const res = await api.patch(`${PREFIX}/products/${pendingOfferId}/moderate`).set('Authorization', otherSeller.auth)
      .send({ status: 'APPROVED' });
    expect(res.status).toBe(403);
  });

  test('the same rules apply to the frontend-facing /:id/status alias — CUSTOMER and SELLER get 403', async () => {
    const asCustomer = await api.patch(`${PREFIX}/products/${pendingOfferId}/status`).set('Authorization', customer.auth)
      .send({ status: 'APPROVED' });
    expect(asCustomer.status).toBe(403);

    const asSeller = await api.patch(`${PREFIX}/products/${pendingOfferId}/status`).set('Authorization', seller.auth)
      .send({ status: 'APPROVED' });
    expect(asSeller.status).toBe(403);
  });

  test('an unauthenticated (no token) request to /moderate gets 401, not 200/500', async () => {
    const res = await api.patch(`${PREFIX}/products/${pendingOfferId}/moderate`).send({ status: 'APPROVED' });
    expect(res.status).toBe(401);
  });

  test('ADMIN (PRODUCTS_MODERATE) can approve via /moderate', async () => {
    const res = await api.patch(`${PREFIX}/products/${pendingOfferId}/moderate`).set('Authorization', admin.auth)
      .send({ status: 'APPROVED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
  });

  test('SUPER_ADMIN (wildcard) can moderate via the /status alias too', async () => {
    const created = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: `محصول سوپرادمین ${Date.now()}`, categoryId: category.id, price: 8000, stock: 1,
    });
    const id = created.body.data.id;

    const res = await api.patch(`${PREFIX}/products/${id}/status`).set('Authorization', superAdmin.auth)
      .send({ status: 'REJECTED', reason: 'نیاز به اصلاح دارد' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REJECTED');
    expect(res.body.data.rejectReason).toBe('نیاز به اصلاح دارد');
  });
});
