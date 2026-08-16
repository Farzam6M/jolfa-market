/**
 * GET /products/:productId/offers — multi-vendor product detail endpoint.
 *
 * :productId here is the GLOBAL Product id (unlike every other :id in this
 * router, which addresses a StoreProduct) — see products.routes.js /
 * products.service.js#getOffersByProduct. This is a NEW, additive endpoint;
 * GET /products/:id (StoreProduct-shaped) is untouched and covered by its
 * own existing tests.
 *
 * Covers:
 *   - One Product with 3 StoreProducts -> 1 product + 3 offers.
 *   - Offers sorted by price ascending.
 *   - A suspended store's offer is hidden.
 *   - An inactive (isActive:false) StoreProduct is hidden.
 *   - A deleted (soft-deleted) seller's offer is hidden.
 *   - The offer's `id` is the StoreProduct id and is directly usable by
 *     POST /cart/items (cart architecture unchanged).
 *   - Two stores selling the same Product stay fully independent (price/
 *     stock), and the response never merges or corrupts either offer.
 *
 * Requires a real Postgres database (DATABASE_URL), migrated + seeded:
 *   NODE_ENV=test npm test -- product-multivendor-offers
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
  return `0935${String(Date.now()).slice(-4)}${String(mobileCounter).padStart(3, '0')}`;
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

/**
 * `name` is kept Persian (readable in test output); `slugPrefix` is a
 * separate, caller-supplied ASCII identifier. categories.validation.js
 * requires `slug` to match /^[a-z0-9-]+$/ — deriving it from a Persian
 * `name` (as this helper previously did) leaves the Persian characters
 * untouched and always fails that regex with a 400, before the category
 * is ever created. Same pattern as commission-resolution.test.js /
 * categories-images.test.js (e.g. `slug: \`settlement-cat-${Date.now()}\``).
 */
async function makeCategory(adminAuth, name, slugPrefix) {
  const res = await api.post(`${PREFIX}/categories`).set('Authorization', adminAuth)
    .send({ name, slug: `${slugPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  return res.body.data;
}

/** Creates + admin-approves a StoreProduct via the real HTTP flow. */
async function makeApprovedOffer(sellerAuth, adminAuth, categoryId, overrides = {}) {
  const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerAuth).send({
    categoryId, price: 20000, stock: 10, ...overrides,
  });
  const id = created.body.data.id;
  await api.patch(`${PREFIX}/products/${id}/moderate`).set('Authorization', adminAuth).send({ status: 'APPROVED' });
  return prisma.storeProduct.findUnique({ where: { id } });
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

describe('GET /products/:productId/offers', () => {
  let admin;
  let category;
  let sellerA;
  let sellerB;
  let sellerC;
  let storeA;
  let storeB;
  let storeC;
  let identity;
  let sharedProductId;
  let offerA;
  let offerB;
  let offerC;

  beforeAll(async () => {
    admin = await makeUser('ADMIN');
    sellerA = await makeUser('SELLER');
    sellerB = await makeUser('SELLER');
    sellerC = await makeUser('SELLER');
    storeA = await makeApprovedStore(sellerA.user.id, `فروشگاه چندفروشنده الف ${Date.now()}`);
    storeB = await makeApprovedStore(sellerB.user.id, `فروشگاه چندفروشنده ب ${Date.now()}`);
    storeC = await makeApprovedStore(sellerC.user.id, `فروشگاه چندفروشنده ج ${Date.now()}`);
    category = await makeCategory(admin.auth, `دسته چندفروشنده ${Date.now()}`, 'multivendor-cat');

    identity = {
      name: `گوشی چندفروشنده ${Date.now()}`, brand: 'برند-چند', model: 'مدل-Y', capacity: '256GB', color: 'نقره‌ای',
    };

    offerA = await makeApprovedOffer(sellerA.auth, admin.auth, category.id, { ...identity, price: 92000000, stock: 5, warranty: '۱۲ ماهه', shippingTime: '۲ روز', discount: 5 });
    offerB = await makeApprovedOffer(sellerB.auth, admin.auth, category.id, { ...identity, price: 89000000, stock: 3, warranty: '۱۸ ماهه', shippingTime: '۳ روز', discount: 10 });
    offerC = await makeApprovedOffer(sellerC.auth, admin.auth, category.id, { ...identity, price: 95000000, stock: 8, warranty: '۶ ماهه', shippingTime: '۱ روز', discount: 0 });

    sharedProductId = offerA.productId;
    expect(offerB.productId).toBe(sharedProductId);
    expect(offerC.productId).toBe(sharedProductId);
  });

  test('returns 1 global Product + 3 offers, one per store', async () => {
    const res = await api.get(`${PREFIX}/products/${sharedProductId}/offers`);
    expect(res.status).toBe(200);
    expect(res.body.data.product.id).toBe(sharedProductId);
    expect(res.body.data.product.name).toBe(identity.name);
    expect(res.body.data.product.brand).toBe(identity.brand);
    expect(res.body.data.offers).toHaveLength(3);

    const storeIds = res.body.data.offers.map((o) => o.store.id).sort();
    expect(storeIds).toEqual([storeA.id, storeB.id, storeC.id].sort());
  });

  test('offers are sorted by price ascending (cheapest first)', async () => {
    const res = await api.get(`${PREFIX}/products/${sharedProductId}/offers`);
    const prices = res.body.data.offers.map((o) => Number(o.price));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(prices[0]).toBe(89000000); // offer B, the cheapest
    expect(res.body.data.offers[0].store.id).toBe(storeB.id);
  });

  test('each offer carries its own store info, price, stock, warranty, shippingTime, discount independently', async () => {
    const res = await api.get(`${PREFIX}/products/${sharedProductId}/offers`);
    const byStore = Object.fromEntries(res.body.data.offers.map((o) => [o.store.id, o]));

    expect(Number(byStore[storeA.id].price)).toBe(92000000);
    expect(byStore[storeA.id].stock).toBe(5);
    expect(byStore[storeA.id].warranty).toBe('۱۲ ماهه');
    expect(byStore[storeA.id].shippingTime).toBe('۲ روز');
    expect(byStore[storeA.id].discount).toBe(5);

    expect(Number(byStore[storeB.id].price)).toBe(89000000);
    expect(byStore[storeB.id].stock).toBe(3);
    expect(byStore[storeB.id].warranty).toBe('۱۸ ماهه');

    expect(Number(byStore[storeC.id].price)).toBe(95000000);
    expect(byStore[storeC.id].stock).toBe(8);
    expect(byStore[storeC.id].discount).toBe(0);

    // Independence check: none of the offers' fields leaked into another.
    expect(byStore[storeA.id].id).not.toBe(byStore[storeB.id].id);
    expect(byStore[storeB.id].id).not.toBe(byStore[storeC.id].id);
  });

  test('offer.id is the StoreProduct id and works directly with POST /cart/items (cart architecture unchanged)', async () => {
    const customer = await makeUser('CUSTOMER');
    const res = await api.get(`${PREFIX}/products/${sharedProductId}/offers`);
    const cheapest = res.body.data.offers[0];
    expect(cheapest.id).toBe(offerB.id); // the cheapest offer is Store B's StoreProduct row

    const addToCart = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth)
      .send({ productId: cheapest.id, qty: 1 });
    // POST /cart/items returns 200, not 201, for both a new and a merged cart
    // item — see cart.controller.js#addItem (res.json(...), no res.status(201))
    // and the established contract already asserted by
    // tests/cart-orders-payments.test.js ('add, update quantity, and remove
    // reflect in the cart...': expect(add.status).toBe(200)).
    expect(addToCart.status).toBe(200);

    const cart = await api.get(`${PREFIX}/cart`).set('Authorization', customer.auth);
    expect(cart.body.data.items.some((it) => it.productId === cheapest.id)).toBe(true);
  });

  test('a suspended store\'s offer is hidden from the offers list', async () => {
    await api.patch(`${PREFIX}/stores/${storeA.id}/moderate`).set('Authorization', admin.auth).send({ status: 'SUSPENDED' });

    const res = await api.get(`${PREFIX}/products/${sharedProductId}/offers`);
    expect(res.status).toBe(200);
    expect(res.body.data.offers.some((o) => o.store.id === storeA.id)).toBe(false);
    // Other stores remain visible and unaffected.
    expect(res.body.data.offers.some((o) => o.store.id === storeB.id)).toBe(true);
    expect(res.body.data.offers.some((o) => o.store.id === storeC.id)).toBe(true);
    expect(res.body.data.offers).toHaveLength(2);

    await api.patch(`${PREFIX}/stores/${storeA.id}/moderate`).set('Authorization', admin.auth).send({ status: 'APPROVED' });
  });

  test('an inactive (seller-paused) StoreProduct is hidden from the offers list', async () => {
    // At this point storeA was restored to APPROVED at the end of the previous
    // test, so A and B are both live; deactivating C's own offer must hide
    // ONLY C, leaving A and B (2 offers) untouched.
    await api.patch(`${PREFIX}/products/${offerC.id}/active`).set('Authorization', sellerC.auth).send({ isActive: false });

    const res = await api.get(`${PREFIX}/products/${sharedProductId}/offers`);
    expect(res.body.data.offers.some((o) => o.store.id === storeC.id)).toBe(false);
    expect(res.body.data.offers.some((o) => o.store.id === storeA.id)).toBe(true);
    expect(res.body.data.offers.some((o) => o.store.id === storeB.id)).toBe(true);
    expect(res.body.data.offers).toHaveLength(2);

    await api.patch(`${PREFIX}/products/${offerC.id}/active`).set('Authorization', sellerC.auth).send({ isActive: true });
  });

  test('a soft-deleted seller\'s offer is hidden from the offers list', async () => {
    const beforeDelete = await api.get(`${PREFIX}/products/${sharedProductId}/offers`);
    expect(beforeDelete.body.data.offers.some((o) => o.store.id === storeB.id)).toBe(true);

    await api.delete(`${PREFIX}/admin/sellers/${sellerB.user.id}`).set('Authorization', admin.auth);

    const afterDelete = await api.get(`${PREFIX}/products/${sharedProductId}/offers`);
    expect(afterDelete.body.data.offers.some((o) => o.store.id === storeB.id)).toBe(false);

    // The shared Product row itself survives and is still reachable.
    const productStill = await prisma.product.findUnique({ where: { id: sharedProductId } });
    expect(productStill).not.toBeNull();
    expect(productStill.name).toBe(identity.name);
  });

  test('a non-existent global Product id returns 404', async () => {
    const res = await api.get(`${PREFIX}/products/00000000-0000-0000-0000-000000000000/offers`);
    expect(res.status).toBe(404);
  });

  test('a malformed productId returns 400 (validated before hitting the DB)', async () => {
    const res = await api.get(`${PREFIX}/products/not-a-uuid/offers`);
    expect(res.status).toBe(400);
  });
});

describe('Two stores selling the same Product remain fully independent through the offers endpoint', () => {
  test('moderating/deactivating one store\'s offer never mutates another store\'s offer or the shared Product', async () => {
    const admin = await makeUser('ADMIN');
    const sellerX = await makeUser('SELLER');
    const sellerY = await makeUser('SELLER');
    const storeX = await makeApprovedStore(sellerX.user.id, `فروشگاه ایزوله ایکس ${Date.now()}`);
    const storeY = await makeApprovedStore(sellerY.user.id, `فروشگاه ایزوله ایگرگ ${Date.now()}`);
    const category = await makeCategory(admin.auth, `دسته ایزوله ${Date.now()}`, 'isolate-cat');

    const identity = {
      name: `محصول ایزوله ${Date.now()}`, brand: 'برند-ایزوله', model: 'مدل-Z', capacity: '64GB', color: 'سفید',
    };
    const offerX = await makeApprovedOffer(sellerX.auth, admin.auth, category.id, { ...identity, price: 30000, stock: 2 });
    const offerY = await makeApprovedOffer(sellerY.auth, admin.auth, category.id, { ...identity, price: 31000, stock: 6 });
    const sharedId = offerX.productId;
    expect(offerY.productId).toBe(sharedId);

    // Reject X's offer with a reason.
    await api.patch(`${PREFIX}/products/${offerX.id}/moderate`).set('Authorization', admin.auth)
      .send({ status: 'REJECTED', note: 'قیمت نامعتبر' });

    const res = await api.get(`${PREFIX}/products/${sharedId}/offers`);
    // Rejected offer X no longer meets the APPROVED filter, so it's hidden;
    // offer Y (still APPROVED) is completely unaffected.
    expect(res.body.data.offers).toHaveLength(1);
    expect(res.body.data.offers[0].store.id).toBe(storeY.id);
    expect(Number(res.body.data.offers[0].price)).toBe(31000);
    expect(res.body.data.offers[0].id).toBe(offerY.id);

    const offerXAfter = await prisma.storeProduct.findUnique({ where: { id: offerX.id } });
    expect(offerXAfter.status).toBe('REJECTED');
    expect(offerXAfter.rejectReason).toBe('قیمت نامعتبر');
    const offerYAfter = await prisma.storeProduct.findUnique({ where: { id: offerY.id } });
    expect(offerYAfter.status).toBe('APPROVED');
    expect(offerYAfter.rejectReason).toBeNull();
  });
});
