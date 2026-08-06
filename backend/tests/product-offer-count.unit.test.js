/**
 * Unit tests for `offerCount` — the number of visible stores selling a
 * given Product, attached to every item in the public (deduplicated)
 * GET /products response (products.service.js#buildProductLevelPage).
 *
 * offerCount must count ONLY visible offers, using EXACTLY the same
 * visibility rule as the rest of the public catalogue (VISIBLE_OFFER_WHERE
 * in products.service.js):
 *   - StoreProduct.status === 'APPROVED'
 *   - StoreProduct.isActive === true
 *   - Store.status !== 'SUSPENDED'
 *   - seller.deletedAt === null
 *
 * It's computed with a single `groupBy` aggregate scoped to the current
 * page's productIds (not a per-item query) — no N+1.
 *
 * Like products-list-dedup.unit.test.js, this mocks '../src/config/database'
 * so it runs without a Prisma engine/DB.
 *
 * Run: NODE_ENV=test npx jest product-offer-count.unit --runInBand
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
  id, productId, price, createdAt, storeId = 'store-1', name = 'Product',
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

// Reproduces buildProductLevelPage's two `distinct` queries (pageAnchors +
// allMatches) that run before the offers/groupBy pair.
function mockAnchors(productIds) {
  const rows = productIds.map((productId) => ({ productId }));
  mockStoreProductFindMany.mockImplementationOnce(async () => rows); // pageAnchors
  mockStoreProductFindMany.mockImplementationOnce(async () => rows); // allMatches
}

beforeEach(() => {
  mockStoreProductFindMany.mockReset();
  mockStoreProductCount.mockReset();
  mockStoreProductGroupBy.mockReset();
  mockStoreFindUnique.mockReset();
});

describe('offerCount on the public GET /products listing', () => {
  test('1 store selling a product -> offerCount is 1', async () => {
    const offer = makeOffer({
      id: 'sp-1', productId: 'prod-1', price: 100000, createdAt: new Date('2026-01-01'), storeId: 'store-1',
    });
    mockAnchors(['prod-1']);
    mockStoreProductFindMany.mockImplementationOnce(async () => [offer]); // offers query
    mockStoreProductGroupBy.mockImplementationOnce(async () => [
      { productId: 'prod-1', _count: { _all: 1 } },
    ]);

    const result = await service.list({ page: 1, pageSize: 24 }, null);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].offerCount).toBe(1);
  });

  test('2 stores selling the same product -> offerCount is 2, cheapest offer still represents the card', async () => {
    const cheap = makeOffer({
      id: 'sp-cheap', productId: 'prod-2', price: 89000000, createdAt: new Date('2026-01-01'), storeId: 'store-a',
    });
    const pricey = makeOffer({
      id: 'sp-pricey', productId: 'prod-2', price: 95000000, createdAt: new Date('2026-01-02'), storeId: 'store-b',
    });
    mockAnchors(['prod-2']);
    mockStoreProductFindMany.mockImplementationOnce(async () => [cheap, pricey]); // price-asc order
    mockStoreProductGroupBy.mockImplementationOnce(async () => [
      { productId: 'prod-2', _count: { _all: 2 } },
    ]);

    const result = await service.list({ page: 1, pageSize: 24 }, null);

    expect(result.items).toHaveLength(1); // still deduplicated to one card
    expect(result.items[0].id).toBe('sp-cheap'); // cheapest offer still wins the representative slot
    expect(result.items[0].price.toString()).toBe('89000000');
    expect(result.items[0].offerCount).toBe(2);
  });

  test('a hidden (non-APPROVED) offer for the same product is not counted', async () => {
    // Only the visible offer is fetched for the representative slot (matches
    // the public `where`); groupBy is mocked to reflect that the hidden
    // (e.g. PENDING) sibling row was excluded by VISIBLE_OFFER_WHERE.
    const visible = makeOffer({
      id: 'sp-visible', productId: 'prod-3', price: 50000, createdAt: new Date('2026-01-01'), storeId: 'store-a',
    });
    mockAnchors(['prod-3']);
    mockStoreProductFindMany.mockImplementationOnce(async () => [visible]);
    mockStoreProductGroupBy.mockImplementationOnce(async () => [
      { productId: 'prod-3', _count: { _all: 1 } }, // the PENDING sibling is excluded, not counted
    ]);

    const result = await service.list({ page: 1, pageSize: 24 }, null);

    expect(result.items[0].offerCount).toBe(1);
  });

  test('the groupBy aggregate is scoped by VISIBLE_OFFER_WHERE (status/isActive/store/seller)', async () => {
    mockAnchors(['prod-4']);
    mockStoreProductFindMany.mockImplementationOnce(async () => [
      makeOffer({
        id: 'sp-4', productId: 'prod-4', price: 10000, createdAt: new Date('2026-01-01'),
      }),
    ]);
    mockStoreProductGroupBy.mockImplementationOnce(async () => [{ productId: 'prod-4', _count: { _all: 1 } }]);

    await service.list({ page: 1, pageSize: 24 }, null);

    const groupByArgs = mockStoreProductGroupBy.mock.calls[0][0];
    expect(groupByArgs.by).toEqual(['productId']);
    expect(groupByArgs.where.status).toBe('APPROVED');
    expect(groupByArgs.where.isActive).toBe(true);
    expect(groupByArgs.where.store).toEqual({ status: { not: 'SUSPENDED' }, seller: { deletedAt: null } });
    expect(groupByArgs.where.productId).toEqual({ in: ['prod-4'] });
  });

  test('a suspended store\'s offer is excluded from offerCount for a product also sold elsewhere', async () => {
    // Product sold by store-a (visible) and store-b (suspended store, hidden).
    // Only store-a's offer is fetched for the representative slot; groupBy
    // reflects that store-b's row never satisfies VISIBLE_OFFER_WHERE.
    const visible = makeOffer({
      id: 'sp-a', productId: 'prod-5', price: 30000, createdAt: new Date('2026-01-01'), storeId: 'store-a',
    });
    mockAnchors(['prod-5']);
    mockStoreProductFindMany.mockImplementationOnce(async () => [visible]);
    mockStoreProductGroupBy.mockImplementationOnce(async () => [
      { productId: 'prod-5', _count: { _all: 1 } }, // store-b (suspended) not counted
    ]);

    const result = await service.list({ page: 1, pageSize: 24 }, null);

    expect(result.items[0].offerCount).toBe(1);
  });

  test('a deleted seller\'s offer is excluded from offerCount for a product also sold elsewhere', async () => {
    const visible = makeOffer({
      id: 'sp-a', productId: 'prod-6', price: 40000, createdAt: new Date('2026-01-01'), storeId: 'store-a',
    });
    mockAnchors(['prod-6']);
    mockStoreProductFindMany.mockImplementationOnce(async () => [visible]);
    mockStoreProductGroupBy.mockImplementationOnce(async () => [
      { productId: 'prod-6', _count: { _all: 1 } }, // store-c (soft-deleted seller) not counted
    ]);

    const result = await service.list({ page: 1, pageSize: 24 }, null);

    expect(result.items[0].offerCount).toBe(1);
  });

  test('an inactive (seller-paused) offer is excluded from offerCount for a product also sold elsewhere', async () => {
    const visible = makeOffer({
      id: 'sp-a', productId: 'prod-7', price: 60000, createdAt: new Date('2026-01-01'), storeId: 'store-a',
    });
    mockAnchors(['prod-7']);
    mockStoreProductFindMany.mockImplementationOnce(async () => [visible]);
    mockStoreProductGroupBy.mockImplementationOnce(async () => [
      { productId: 'prod-7', _count: { _all: 1 } }, // store-d's isActive=false offer not counted
    ]);

    const result = await service.list({ page: 1, pageSize: 24 }, null);

    expect(result.items[0].offerCount).toBe(1);
  });

  test('offerCount is computed with exactly ONE extra aggregate query per page, regardless of page size (no N+1)', async () => {
    const ids = ['prod-a', 'prod-b', 'prod-c', 'prod-d', 'prod-e'];
    mockAnchors(ids);
    mockStoreProductFindMany.mockImplementationOnce(async () => ids.map((id, i) => makeOffer({
      id: `sp-${id}`, productId: id, price: 1000 * (i + 1), createdAt: new Date('2026-01-01'),
    })));
    mockStoreProductGroupBy.mockImplementationOnce(async () => ids.map((id) => ({ productId: id, _count: { _all: 1 } })));

    await service.list({ page: 1, pageSize: 24 }, null);

    // 2 distinct/anchor queries + 1 offers query = 3 findMany calls total,
    // plus exactly 1 groupBy call — never one groupBy per item.
    expect(mockStoreProductFindMany).toHaveBeenCalledTimes(3);
    expect(mockStoreProductGroupBy).toHaveBeenCalledTimes(1);
  });
});
