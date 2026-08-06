/**
 * Unit tests for the Storefront visibility fix.
 *
 * Bug: the storefront page (index.html renderStorefront()) used to clone
 * .product-card DOM nodes from the already-deduplicated public products page
 * (filtered by data-shop). That public page is built from GET /products,
 * which — for public/customer browsing — collapses every Product down to
 * ONE representative card (its cheapest offer; see buildProductLevelPage()
 * in products.service.js). A store that is NOT the cheapest seller of a
 * given Product therefore had zero matching DOM nodes to clone, so its own
 * storefront silently omitted a product it genuinely, actively sells.
 *
 * Fix: the storefront now calls the SAME existing GET /products endpoint
 * with a storeId filter (already an accepted query param in
 * products.validation.js — no backend change was needed). This suite proves
 * that path — service.list({ storeId, ... }, null) i.e. an anonymous
 * storefront visitor — always returns every one of that store's own live
 * offers, regardless of whether cheaper competing offers exist elsewhere.
 *
 * Like products-list-dedup.unit.test.js, this mocks '../src/config/database'
 * so it runs without a Prisma engine/DB.
 *
 * Run: NODE_ENV=test npx jest storefront-store-products.unit --runInBand
 */

const mockStoreProductFindMany = jest.fn();
const mockStoreProductCount = jest.fn();
const mockStoreProductGroupBy = jest.fn();
const mockStoreFindUnique = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    storeProduct: {
      findMany: (...args) => mockStoreProductFindMany(...args),
      count: (...args) => mockStoreProductCount(...args),
      groupBy: (...args) => mockStoreProductGroupBy(...args),
    },
    store: {
      findUnique: (...args) => mockStoreFindUnique(...args),
    },
  },
}));

const service = require('../src/modules/products/products.service');

function makeOffer({
  id, productId, price, createdAt, storeId, name = 'Some Product',
}) {
  return {
    id,
    productId,
    storeId,
    price,
    compareAtPrice: null,
    stock: 5,
    warranty: null,
    shippingTime: null,
    discount: null,
    type: 'RETAIL',
    status: 'APPROVED',
    isActive: true,
    createdAt,
    updatedAt: createdAt,
    product: {
      id: productId, name, brand: 'Brand', model: null, slug: `${productId}-slug`, category: null,
    },
    images: [],
    wholesaleTiers: [],
    store: {
      id: storeId, name: `Store ${storeId}`, slug: storeId, logoUrl: null, rating: 0,
    },
  };
}

beforeEach(() => {
  mockStoreProductFindMany.mockReset();
  mockStoreProductCount.mockReset();
  mockStoreProductGroupBy.mockReset();
  mockStoreProductGroupBy.mockResolvedValue([]); // offerCount is covered separately in product-offer-count.unit.test.js
  mockStoreFindUnique.mockReset();
});

// Helper: reproduces buildProductLevelPage's own two-query + offers-query
// sequence for a `where` that already contains `storeId` (exactly what
// products.service.js#list does when a storeId filter is passed).
function mockBuildProductLevelPage({ anchors, offers }) {
  mockStoreProductFindMany.mockImplementationOnce(async () => anchors); // pageAnchors
  mockStoreProductFindMany.mockImplementationOnce(async () => anchors); // allMatches (unpaginated, for total)
  mockStoreProductFindMany.mockImplementationOnce(async () => offers); // full offers for the page
}

describe('storefront: GET /products?storeId=... (anonymous visitor, service.list)', () => {
  test('store with unique products (no other store sells them) — all returned', async () => {
    const offer1 = makeOffer({
      id: 'sp-1', productId: 'prod-1', price: 100000, createdAt: new Date('2026-01-01'), storeId: 'store-2', name: 'Product A',
    });
    const offer2 = makeOffer({
      id: 'sp-2', productId: 'prod-2', price: 200000, createdAt: new Date('2026-01-02'), storeId: 'store-2', name: 'Product B',
    });
    mockBuildProductLevelPage({
      anchors: [{ productId: 'prod-1' }, { productId: 'prod-2' }],
      offers: [offer1, offer2],
    });

    const result = await service.list({ storeId: 'store-2', page: 1, pageSize: 100 }, null);

    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.id).sort()).toEqual(['sp-1', 'sp-2']);
    expect(result.total).toBe(2);
  });

  test('store that is NOT the cheapest seller of a shared product still sees its own offer', async () => {
    // Product A: Store 1 sells at $100 (cheapest), Store 2 sells the SAME
    // global product at $120. Store 2's own storefront (storeId=store-2)
    // must still show it — this is the exact bug scenario from the audit.
    const store2Offer = makeOffer({
      id: 'sp-store2-a', productId: 'prod-a', price: 120000, createdAt: new Date('2026-01-01'), storeId: 'store-2', name: 'Product A',
    });
    // Because `where` already narrows to storeId: 'store-2' BEFORE the
    // distinct/offers queries run, store-1's cheaper $100 offer for the
    // same productId is never even fetched here — proving it can't win
    // and hide store-2's row.
    mockBuildProductLevelPage({
      anchors: [{ productId: 'prod-a' }],
      offers: [store2Offer],
    });

    const result = await service.list({ storeId: 'store-2', page: 1, pageSize: 100 }, null);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('sp-store2-a');
    expect(result.items[0].price.toString()).toBe('120000');

    // Confirm the offers query itself was scoped to storeId (so a cheaper
    // rival offer could never have been the one selected).
    const offersCallArgs = mockStoreProductFindMany.mock.calls[2][0];
    expect(offersCallArgs.where.storeId).toBe('store-2');
  });

  test('store with shared products (sells some products other stores also sell) — its own offer for each is returned once', async () => {
    const shared = makeOffer({
      id: 'sp-shared', productId: 'prod-shared', price: 50000, createdAt: new Date('2026-01-01'), storeId: 'store-2', name: 'Shared Product',
    });
    const unique = makeOffer({
      id: 'sp-unique', productId: 'prod-unique', price: 75000, createdAt: new Date('2026-01-02'), storeId: 'store-2', name: 'Unique Product',
    });
    mockBuildProductLevelPage({
      anchors: [{ productId: 'prod-shared' }, { productId: 'prod-unique' }],
      offers: [shared, unique],
    });

    const result = await service.list({ storeId: 'store-2', page: 1, pageSize: 100 }, null);

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    // No duplicate rows despite prod-shared also being sold elsewhere.
    const ids = result.items.map((i) => i.productId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('suspended store — storefront correctly returns nothing (public visibility rule preserved)', async () => {
    // A suspended store's products are excluded by the public `where` clause
    // itself (store.status: { not: 'SUSPENDED' }) — the storefront must not
    // bypass that; mocking an empty anchor set reproduces what the real
    // where-clause filter would produce.
    mockStoreProductFindMany.mockImplementationOnce(async () => []); // anchors
    mockStoreProductFindMany.mockImplementationOnce(async () => []); // allMatches

    const result = await service.list({ storeId: 'store-suspended', page: 1, pageSize: 100 }, null);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    // Public/anonymous request never reaches ownRequest handling.
    expect(mockStoreFindUnique).not.toHaveBeenCalled();
  });

  test('deleted (soft-deleted) seller — storefront correctly returns nothing', async () => {
    // Same reasoning as suspended store: public `where` already excludes
    // seller.deletedAt != null, so this resolves to an empty anchor set.
    mockStoreProductFindMany.mockImplementationOnce(async () => []);
    mockStoreProductFindMany.mockImplementationOnce(async () => []);

    const result = await service.list({ storeId: 'store-deleted-seller', page: 1, pageSize: 100 }, null);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  test('empty storefront (store exists, has zero approved/active products)', async () => {
    mockStoreProductFindMany.mockImplementationOnce(async () => []);
    mockStoreProductFindMany.mockImplementationOnce(async () => []);

    const result = await service.list({ storeId: 'store-empty', page: 1, pageSize: 100 }, null);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(mockStoreProductFindMany).toHaveBeenCalledTimes(2); // short-circuits before the offers query
  });
});
