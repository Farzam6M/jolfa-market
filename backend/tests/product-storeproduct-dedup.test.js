/**
 * Product / StoreProduct dedup test suite.
 *
 * Covers the exact scenarios required by the task:
 *   A. Store A creates iPhone 16 Pro                 -> 1 Product, 1 StoreProduct
 *   B. Store B creates an identical iPhone 16 Pro     -> 1 Product, 2 StoreProducts
 *   C. Store A submits the identical product again    -> 1 Product, 2 StoreProducts,
 *                                                         Store A's own offer updated (not duplicated)
 *   D. Store A and Store B use different prices        -> prices stay independent
 *
 * Plus: identityKey normalization (whitespace/case-insensitivity, distinct
 * products staying distinct) and a concurrent-creation race test (point 6 —
 * the DB unique constraint, not the findFirst-then-create check, is what
 * actually prevents a duplicate Product/StoreProduct row).
 *
 * Requires a real Postgres database (DATABASE_URL) with the schema migrated
 * (`npx prisma migrate deploy`) and roles seeded (`npm run seed`) before running:
 *
 *   NODE_ENV=test npm test -- product-storeproduct-dedup
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');
const { buildIdentityKey } = require('../src/modules/products/products.service');

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

const IPHONE = {
  name: 'iPhone 16 Pro', brand: 'Apple', model: '16 Pro', capacity: '256GB', color: 'Black',
};

beforeAll(async () => {
  const roleRows = await prisma.role.findMany();
  roles = Object.fromEntries(roleRows.map((r) => [r.key, r]));
  if (!roles.CUSTOMER || !roles.SELLER || !roles.ADMIN || !roles.SUPER_ADMIN) {
    throw new Error('Roles are not seeded — run `npm run seed` against the test database first.');
  }
  category = await prisma.category.upsert({
    where: { slug: 'test-category-dedup' },
    update: {},
    create: { name: 'دسته تست دیدوپ', slug: 'test-category-dedup' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('buildIdentityKey() normalization', () => {
  test('trims, lowercases, and collapses whitespace deterministically', () => {
    const a = buildIdentityKey({
      name: '  iPhone   16 Pro ', brand: 'Apple', model: '16 Pro', capacity: '256GB', color: 'Black',
    });
    const b = buildIdentityKey({
      name: 'iphone 16 pro', brand: 'APPLE', model: '16 PRO', capacity: '256gb', color: 'black',
    });
    expect(a).toBe(b);
  });

  test('missing/undefined fields normalize the same as empty string', () => {
    const a = buildIdentityKey({ name: 'AirPods', brand: undefined, model: null, capacity: undefined, color: '' });
    const b = buildIdentityKey({ name: 'AirPods', brand: '', model: '', capacity: '', color: '' });
    expect(a).toBe(b);
  });

  test('different identity fields produce different keys', () => {
    const black = buildIdentityKey({ ...IPHONE, color: 'Black' });
    const blue = buildIdentityKey({ ...IPHONE, color: 'Blue' });
    expect(black).not.toBe(blue);
  });
});

describe('Product/StoreProduct creation & dedup (task scenarios A–D)', () => {
  let sellerA;
  let sellerB;
  let storeA;
  let storeB;

  beforeAll(async () => {
    const suffix = Math.floor(Math.random() * 9e7).toString();
    sellerA = await makeUser('SELLER', `3${suffix}`.slice(0, 9));
    sellerB = await makeUser('SELLER', `4${suffix}`.slice(0, 9));
    storeA = await makeApprovedStore(sellerA.user.id, `فروشگاه دیدوپ الف ${suffix}`);
    storeB = await makeApprovedStore(sellerB.user.id, `فروشگاه دیدوپ ب ${suffix}`);
  });

  test('A. Store A creates iPhone 16 Pro -> 1 Product, 1 StoreProduct', async () => {
    const res = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      ...IPHONE, categoryId: category.id, price: 90000000, stock: 5,
    });
    expect(res.status).toBe(201);

    const identityKey = buildIdentityKey(IPHONE);
    const products = await prisma.product.findMany({ where: { identityKey } });
    expect(products).toHaveLength(1);

    const offers = await prisma.storeProduct.findMany({ where: { productId: products[0].id } });
    expect(offers).toHaveLength(1);
    expect(offers[0].storeId).toBe(storeA.id);
  });

  test('B. Store B creates an identical iPhone 16 Pro -> still 1 Product, now 2 StoreProducts', async () => {
    const res = await api.post(`${PREFIX}/products`).set('Authorization', sellerB.auth).send({
      ...IPHONE, categoryId: category.id, price: 91500000, stock: 3,
    });
    expect(res.status).toBe(201);

    const identityKey = buildIdentityKey(IPHONE);
    const products = await prisma.product.findMany({ where: { identityKey } });
    expect(products).toHaveLength(1); // still exactly one global Product — reused, not duplicated

    const offers = await prisma.storeProduct.findMany({ where: { productId: products[0].id } });
    expect(offers).toHaveLength(2);
    expect(offers.map((o) => o.storeId).sort()).toEqual([storeA.id, storeB.id].sort());
  });

  test('C. Store A submits the identical product again -> still 1 Product, still 2 StoreProducts, Store A offer updated', async () => {
    const res = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      ...IPHONE, categoryId: category.id, price: 89000000, stock: 8, warranty: '۱۸ ماهه',
    });
    expect(res.status).toBe(201);

    const identityKey = buildIdentityKey(IPHONE);
    const product = await prisma.product.findUnique({ where: { identityKey } });
    expect(product).not.toBeNull();

    const offers = await prisma.storeProduct.findMany({ where: { productId: product.id } });
    expect(offers).toHaveLength(2); // no new row — Store A's existing offer was updated in place

    const storeAOffer = offers.find((o) => o.storeId === storeA.id);
    expect(Number(storeAOffer.price)).toBe(89000000);
    expect(storeAOffer.stock).toBe(8);
    expect(storeAOffer.warranty).toBe('۱۸ ماهه');
    expect(storeAOffer.status).toBe('PENDING'); // re-submission goes back through moderation, same as update()
  });

  test('D. Store A and Store B keep independent prices for the same global product', async () => {
    const identityKey = buildIdentityKey(IPHONE);
    const product = await prisma.product.findUnique({ where: { identityKey } });
    const offers = await prisma.storeProduct.findMany({ where: { productId: product.id } });

    const storeAOffer = offers.find((o) => o.storeId === storeA.id);
    const storeBOffer = offers.find((o) => o.storeId === storeB.id);
    expect(Number(storeAOffer.price)).toBe(89000000); // from scenario C
    expect(Number(storeBOffer.price)).toBe(91500000); // untouched by A's resubmission
    expect(Number(storeAOffer.price)).not.toBe(Number(storeBOffer.price));
  });

  test('a differently-specced product (different color) is NOT merged into the same Product row', async () => {
    const res = await api.post(`${PREFIX}/products`).set('Authorization', sellerA.auth).send({
      ...IPHONE, color: 'Blue Titanium', categoryId: category.id, price: 90000000, stock: 2,
    });
    expect(res.status).toBe(201);

    const blackKey = buildIdentityKey(IPHONE);
    const blueKey = buildIdentityKey({ ...IPHONE, color: 'Blue Titanium' });
    const [blackProduct, blueProduct] = await Promise.all([
      prisma.product.findUnique({ where: { identityKey: blackKey } }),
      prisma.product.findUnique({ where: { identityKey: blueKey } }),
    ]);
    expect(blackProduct.id).not.toBe(blueProduct.id);
  });
});

describe('Concurrency (point 6: DB constraint is the real guard, not findFirst->create)', () => {
  test('two simultaneous submissions of a brand-new product from different stores still resolve to exactly 1 Product and 2 StoreProducts', async () => {
    const suffix = Math.floor(Math.random() * 9e7).toString();
    const sellerC = await makeUser('SELLER', `5${suffix}`.slice(0, 9));
    const sellerD = await makeUser('SELLER', `6${suffix}`.slice(0, 9));
    const storeC = await makeApprovedStore(sellerC.user.id, `فروشگاه همزمان ج ${suffix}`);
    const storeD = await makeApprovedStore(sellerD.user.id, `فروشگاه همزمان د ${suffix}`);

    const RACE_PRODUCT = {
      name: 'Galaxy S25 Ultra', brand: 'Samsung', model: 'S25 Ultra', capacity: '512GB', color: 'Titanium Gray',
    };

    // Fired concurrently — this is what actually exercises the race, unlike
    // sequential requests which would never hit the findUnique/create gap.
    const [resC, resD] = await Promise.all([
      api.post(`${PREFIX}/products`).set('Authorization', sellerC.auth).send({
        ...RACE_PRODUCT, categoryId: category.id, price: 55000000, stock: 4,
      }),
      api.post(`${PREFIX}/products`).set('Authorization', sellerD.auth).send({
        ...RACE_PRODUCT, categoryId: category.id, price: 56000000, stock: 6,
      }),
    ]);
    expect(resC.status).toBe(201);
    expect(resD.status).toBe(201);

    const identityKey = buildIdentityKey(RACE_PRODUCT);
    const products = await prisma.product.findMany({ where: { identityKey } });
    expect(products).toHaveLength(1); // the unique(identityKey) constraint prevented a duplicate

    const offers = await prisma.storeProduct.findMany({ where: { productId: products[0].id } });
    expect(offers).toHaveLength(2);
    expect(offers.map((o) => o.storeId).sort()).toEqual([storeC.id, storeD.id].sort());
  });
});
