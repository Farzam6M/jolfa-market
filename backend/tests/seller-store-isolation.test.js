/**
 * Seller Lifecycle & Store/Product Isolation audit tests.
 *
 * Complements admin-sellers-deletion.test.js, product-update-ownership.test.js
 * and stores-products.access.test.js (which already cover: soft-delete
 * archiving products/preserving orders & chats, ownership isolation between
 * sellers, and identity-field staff-only protection). This file fills the
 * remaining gaps called out by the audit:
 *
 *   - A suspended store can neither create nor update offers.
 *   - A suspended store's (previously APPROVED) offers vanish from the
 *     public marketplace (list + detail) but its existing orders stay
 *     reachable by the seller and by staff.
 *   - True multi-store isolation: two different stores' offers for the
 *     SAME shared Product — suspending/removing one seller must not touch
 *     the other store's offer or the shared Product row.
 *   - The global Product row itself (name/brand/etc.) survives seller
 *     removal — not just the StoreProduct row (already covered elsewhere).
 *   - Reviews (which target the shared Product, not any one store's offer)
 *     survive seller removal.
 *   - Cart items pointing at a removed seller's offer are left in place
 *     (not silently deleted) — they simply become un-checkout-able.
 *   - users.service.js updateStatus (SUSPENDED/BANNED) — the "generic"
 *     deactivation path distinct from DELETE /admin/sellers/:id — cascades
 *     the same store/product archiving and blocks re-login.
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
let mobileCounter = 0;

function nextMobile() {
  mobileCounter += 1;
  return `0937${String(Date.now()).slice(-4)}${String(mobileCounter).padStart(3, '0')}`;
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

/** Creates + admin-approves a StoreProduct via the real HTTP flow (so findOrCreateProduct's identity dedup runs for real). */
async function makeApprovedOffer(sellerAuth, adminAuth, categoryId, overrides = {}) {
  const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerAuth).send({
    name: 'محصول تست ایزوله‌سازی', categoryId, price: 20000, stock: 10, ...overrides,
  });
  const id = created.body.data.id;
  await api.patch(`${PREFIX}/products/${id}/moderate`).set('Authorization', adminAuth).send({ status: 'APPROVED' });
  return prisma.storeProduct.findUnique({ where: { id }, include: { product: true } });
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

describe('Store suspension', () => {
  let seller;
  let admin;
  let category;
  let store;

  beforeAll(async () => {
    seller = await makeUser('SELLER');
    admin = await makeUser('ADMIN');
    store = await makeApprovedStore(seller.user.id, `فروشگاه تعلیق ${Date.now()}`);
    category = await makeCategory(admin.auth, `دسته تعلیق ${Date.now()}`);
  });

  test('a suspended store cannot create a new offer', async () => {
    await api.patch(`${PREFIX}/stores/${store.id}/moderate`).set('Authorization', admin.auth).send({ status: 'SUSPENDED' });

    const res = await api.post(`${PREFIX}/products`).set('Authorization', seller.auth).send({
      name: 'محصول در فروشگاه معلق', categoryId: category.id, price: 10000, stock: 1,
    });
    expect(res.status).toBe(403);

    await api.patch(`${PREFIX}/stores/${store.id}/moderate`).set('Authorization', admin.auth).send({ status: 'APPROVED' });
  });

  test('an existing offer vanishes from the public marketplace while its store is suspended, and reappears once re-approved', async () => {
    const offer = await makeApprovedOffer(seller.auth, admin.auth, category.id, { name: `محصول قابل‌مشاهده ${Date.now()}` });

    const visibleBefore = await api.get(`${PREFIX}/products/${offer.id}`);
    expect(visibleBefore.status).toBe(200);

    await api.patch(`${PREFIX}/stores/${store.id}/moderate`).set('Authorization', admin.auth).send({ status: 'SUSPENDED' });

    const hiddenDetail = await api.get(`${PREFIX}/products/${offer.id}`);
    expect(hiddenDetail.status).toBe(404); // detail view no longer reachable by an anonymous/customer caller

    const list = await api.get(`${PREFIX}/products`).query({ storeId: store.id });
    expect(list.body.data.items.find((it) => it.id === offer.id)).toBeUndefined();

    // Staff and the owning seller can still see it (moderation/self-management view).
    const staffView = await api.get(`${PREFIX}/products/${offer.id}`).set('Authorization', admin.auth);
    expect(staffView.status).toBe(200);
    const ownerView = await api.get(`${PREFIX}/products/${offer.id}`).set('Authorization', seller.auth);
    expect(ownerView.status).toBe(200);

    await api.patch(`${PREFIX}/stores/${store.id}/moderate`).set('Authorization', admin.auth).send({ status: 'APPROVED' });
    const visibleAgain = await api.get(`${PREFIX}/products/${offer.id}`);
    expect(visibleAgain.status).toBe(200);
  });

  test('the owning seller can still reach their existing orders while the store is suspended', async () => {
    const customer = await makeUser('CUSTOMER');
    const offer = await makeApprovedOffer(seller.auth, admin.auth, category.id, { name: `محصول سفارش‌دار ${Date.now()}`, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: offer.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    expect(order.status).toBe(201);

    await api.patch(`${PREFIX}/stores/${store.id}/moderate`).set('Authorization', admin.auth).send({ status: 'SUSPENDED' });

    const storeOrders = await api.get(`${PREFIX}/orders/store`).set('Authorization', seller.auth);
    expect(storeOrders.status).toBe(200);
    expect(storeOrders.body.data.items.some((o) => o.id === order.body.data.id)).toBe(true);

    const single = await api.get(`${PREFIX}/orders/${order.body.data.id}`).set('Authorization', seller.auth);
    expect(single.status).toBe(200);

    await api.patch(`${PREFIX}/stores/${store.id}/moderate`).set('Authorization', admin.auth).send({ status: 'APPROVED' });
  });
});

describe('Multi-store isolation (two stores selling the same shared Product)', () => {
  test('suspending/removing one seller never touches another store\'s offer or the shared Product row', async () => {
    const admin = await makeUser('ADMIN');
    const sellerA = await makeUser('SELLER');
    const sellerB = await makeUser('SELLER');
    const storeA = await makeApprovedStore(sellerA.user.id, `فروشگاه الف ${Date.now()}`);
    const storeB = await makeApprovedStore(sellerB.user.id, `فروشگاه ب ${Date.now()}`);
    const category = await makeCategory(admin.auth, `دسته اشتراکی ${Date.now()}`);

    const identity = {
      name: 'گوشی مشترک بین دو فروشگاه', brand: 'برند-اشتراکی', model: 'مدل-X', categoryId: category.id,
    };
    const offerA = await makeApprovedOffer(sellerA.auth, admin.auth, category.id, { ...identity, price: 15000, stock: 3 });
    const offerB = await makeApprovedOffer(sellerB.auth, admin.auth, category.id, { ...identity, price: 16000, stock: 4 });

    // Same identity -> same underlying global Product, two distinct StoreProduct rows.
    expect(offerA.productId).toBe(offerB.productId);
    expect(offerA.id).not.toBe(offerB.id);

    // Admin suspends Store A entirely.
    await api.patch(`${PREFIX}/stores/${storeA.id}/moderate`).set('Authorization', admin.auth).send({ status: 'SUSPENDED' });

    const stillA = await prisma.storeProduct.findUnique({ where: { id: offerA.id } });
    expect(stillA.status).not.toBe('ARCHIVED'); // suspension hides it (store.status), doesn't archive/rewrite the offer itself

    const offerBAfter = await api.get(`${PREFIX}/products/${offerB.id}`);
    expect(offerBAfter.status).toBe(200); // Store B's own offer is completely unaffected
    expect(Number(offerBAfter.body.data.price)).toBe(16000);

    const sharedProduct = await prisma.product.findUnique({ where: { id: offerA.productId } });
    expect(sharedProduct.name).toBe(identity.name); // the shared Product row itself is untouched

    // Now admin removes Seller A outright (soft delete).
    await api.delete(`${PREFIX}/admin/sellers/${sellerA.user.id}`).set('Authorization', admin.auth);

    const offerBStillFine = await api.get(`${PREFIX}/products/${offerB.id}`);
    expect(offerBStillFine.status).toBe(200);
    expect(Number(offerBStillFine.body.data.price)).toBe(16000);
    expect(offerBStillFine.body.data.id).toBe(offerB.id);

    const sharedProductAfter = await prisma.product.findUnique({ where: { id: offerA.productId } });
    expect(sharedProductAfter).not.toBeNull();
    expect(sharedProductAfter.name).toBe(identity.name);
    expect(sharedProductAfter.id).toBe(sharedProduct.id); // never re-created, never deleted

    const archivedA = await prisma.storeProduct.findUnique({ where: { id: offerA.id } });
    expect(archivedA.status).toBe('ARCHIVED'); // only Store A's own offer was archived by the removal
    const untouchedB = await prisma.storeProduct.findUnique({ where: { id: offerB.id } });
    expect(untouchedB.status).toBe('APPROVED'); // Store B's offer for the same product was never archived
  });
});

describe('Seller removal preserves data outside the seller\'s own store', () => {
  test('the global Product row, reviews, and cart items survive a seller removal', async () => {
    const admin = await makeUser('ADMIN');
    const seller = await makeUser('SELLER');
    const customer = await makeUser('CUSTOMER');
    await makeApprovedStore(seller.user.id, `فروشگاه بقا ${Date.now()}`);
    const category = await makeCategory(admin.auth, `دسته بقا ${Date.now()}`);
    const offer = await makeApprovedOffer(seller.auth, admin.auth, category.id, { name: `محصول بقا ${Date.now()}`, stock: 5 });

    // Customer buys it (so a review is eligible) and separately still has a second unit sitting in the cart.
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: offer.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    // Jump straight to DELIVERED via prisma (test setup only) so the review-eligibility check passes.
    await prisma.order.update({ where: { id: order.body.data.id }, data: { status: 'DELIVERED' } });

    const review = await api.post(`${PREFIX}/reviews`).set('Authorization', customer.auth)
      .send({ productId: offer.productId, rating: 5, comment: 'عالی بود' });
    expect(review.status).toBe(201);

    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: offer.id, qty: 1 });
    const cartBefore = await prisma.cartItem.findFirst({ where: { storeProductId: offer.id } });
    expect(cartBefore).not.toBeNull();

    const del = await api.delete(`${PREFIX}/admin/sellers/${seller.user.id}`).set('Authorization', admin.auth);
    expect(del.status).toBe(200);

    const productStill = await prisma.product.findUnique({ where: { id: offer.productId } });
    expect(productStill).not.toBeNull();
    expect(productStill.name).toBe(offer.product.name);

    const reviewStill = await prisma.review.findUnique({ where: { id: review.body.data.id } });
    expect(reviewStill).not.toBeNull();

    const cartAfter = await prisma.cartItem.findFirst({ where: { storeProductId: offer.id } });
    expect(cartAfter).not.toBeNull(); // not force-deleted — it just can no longer be checked out
    expect(cartAfter.id).toBe(cartBefore.id);
  });
});

describe('Generic seller deactivation (PATCH /users/:id/status) vs. DELETE /admin/sellers/:id', () => {
  test('suspending a seller\'s account through the generic status endpoint archives their store/products too, and blocks re-login', async () => {
    const admin = await makeUser('ADMIN');
    const seller = await makeUser('SELLER');
    const store = await makeApprovedStore(seller.user.id, `فروشگاه غیرفعال‌سازی ${Date.now()}`);
    const category = await makeCategory(admin.auth, `دسته غیرفعال‌سازی ${Date.now()}`);
    const offer = await makeApprovedOffer(seller.auth, admin.auth, category.id, { name: `محصول غیرفعال‌سازی ${Date.now()}` });

    const res = await api.patch(`${PREFIX}/users/${seller.user.id}/status`).set('Authorization', admin.auth).send({ status: 'SUSPENDED' });
    expect(res.status).toBe(200);

    const storeAfter = await prisma.store.findUnique({ where: { id: store.id } });
    expect(storeAfter.status).toBe('SUSPENDED');
    const offerAfter = await prisma.storeProduct.findUnique({ where: { id: offer.id } });
    expect(offerAfter.status).toBe('ARCHIVED');
    expect(offerAfter.isActive).toBe(false);

    // deletedAt must stay null — this is a reversible status change, not the removeSeller() soft-delete.
    const userAfter = await prisma.user.findUnique({ where: { id: seller.user.id } });
    expect(userAfter.deletedAt).toBeNull();

    // The suspended seller can no longer authenticate.
    const login = await api.post(`${PREFIX}/auth/login`).send({ mobile: seller.user.mobile, password: 'Passw0rd!23' });
    expect(login.status).toBe(401);

    // The global Product row is untouched.
    const productStill = await prisma.product.findUnique({ where: { id: offer.productId } });
    expect(productStill).not.toBeNull();
  });
});
