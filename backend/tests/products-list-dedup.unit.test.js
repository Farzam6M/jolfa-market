/**
 * Unit-level test for products.service.js::list() — specifically the
 * Product-level de-duplication added for public/customer browsing (global
 * search, category pages, the general catalogue).
 *
 * This suite does NOT hit a real database — it mocks `../../src/config/database`
 * so it can run without a Prisma-generated client/engine (useful in sandboxed
 * environments where the Prisma engine binary can't be downloaded). It verifies:
 *   - the exact Prisma calls list() makes (where/distinct/orderBy/skip/take),
 *   - that multiple StoreProduct rows for the same Product collapse into one
 *     item in the response,
 *   - that the cheapest matching offer is the one chosen to represent the
 *     product,
 *   - that `total`/pagination reflect distinct Product count, not row count,
 *   - that the staff/owner (ownRequest) path is UNCHANGED — still one row per
 *     StoreProduct, still uses the plain findMany+count pair.
 *
 * Run: NODE_ENV=test npx jest products-list-dedup.unit --runInBand
 * (does not require DATABASE_URL / a running Postgres / `prisma generate`).
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

// Every transitive dependency of products.service.js that touches the DB
// goes through the same mocked '../../config/database' module (Jest mocks
// by resolved path, so admin.service/notifications.service/categories.service/
// realtime/socket all get the mock too) — no further mocking needed for
// list() specifically, since it doesn't call logAdminActivity/pushNotification.
const service = require('../src/modules/products/products.service');

function makeOffer({
  id, productId, price, createdAt, storeId = 'store-1',
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
      id: productId,
      name: 'iPhone 16 Pro',
      brand: 'Apple',
      model: '16 Pro',
      slug: `iphone-16-pro-${productId}`,
      category: null,
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
  mockStoreProductGroupBy.mockResolvedValue([]); // default: offerCount tests live in storefront-store-products.unit.test.js / product-offer-count.unit.test.js
  mockStoreFindUnique.mockReset();
});

describe('list() — public/customer browsing (ownRequest = false) de-duplicates by Product', () => {
  test('3 stores selling the same Product -> exactly 1 item in the response, cheapest offer wins', async () => {
    const offerA = makeOffer({
      id: 'sp-a', productId: 'prod-1', price: 91500000, createdAt: new Date('2026-01-01'), storeId: 'store-a',
    });
    const offerB = makeOffer({
      id: 'sp-b', productId: 'prod-1', price: 89000000, createdAt: new Date('2026-01-02'), storeId: 'store-b',
    });
    const offerC = makeOffer({
      id: 'sp-c', productId: 'prod-1', price: 90000000, createdAt: new Date('2026-01-03'), storeId: 'store-c',
    });

    // Call 1 (inside buildProductLevelPage): distinct anchor query -> one row per productId
    mockStoreProductFindMany.mockImplementationOnce(async () => [{ productId: 'prod-1' }]);
    // Call 2: unpaginated distinct query used only for total count
    mockStoreProductFindMany.mockImplementationOnce(async () => [{ productId: 'prod-1' }]);
    // Call 3: full offers for the page's productIds, ordered by price asc
    mockStoreProductFindMany.mockImplementationOnce(async () => [offerB, offerC, offerA]);

    const result = await service.list({
      q: 'iPhone 16 Pro', page: 1, pageSize: 24,
    }, null); // null requester -> anonymous/public

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1); // 1 distinct Product, not 3 StoreProduct rows
    expect(result.items[0].id).toBe('sp-b'); // the cheapest offer (89,000,000) represents the product
    expect(result.items[0].price.toString()).toBe('89000000');
    expect(result.items[0].name).toBe('iPhone 16 Pro'); // global Product field present
    expect(mockStoreProductCount).not.toHaveBeenCalled(); // dedup path never uses the plain count()
  });

  test('the anchor/distinct query is called with distinct:["productId"] and the public where-clause', async () => {
    mockStoreProductFindMany.mockImplementationOnce(async () => []);
    mockStoreProductFindMany.mockImplementationOnce(async () => []);

    await service.list({ categoryId: 'cat-1', page: 2, pageSize: 10 }, null);

    const firstCallArgs = mockStoreProductFindMany.mock.calls[0][0];
    expect(firstCallArgs.distinct).toEqual(['productId']);
    expect(firstCallArgs.skip).toBe(10); // (page 2 - 1) * pageSize 10
    expect(firstCallArgs.take).toBe(10);
    expect(firstCallArgs.where.status).toBe('APPROVED'); // public browsing forces APPROVED
    expect(firstCallArgs.where.isActive).toBe(true); // public browsing hides paused/suspended offers
    expect(firstCallArgs.where.product).toEqual({ categoryId: 'cat-1' });
  });

  test('empty result set short-circuits without a third query', async () => {
    mockStoreProductFindMany.mockImplementationOnce(async () => []); // no anchors
    mockStoreProductFindMany.mockImplementationOnce(async () => []); // no matches at all

    const result = await service.list({ page: 1, pageSize: 24 }, null);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(mockStoreProductFindMany).toHaveBeenCalledTimes(2); // never reaches the 3rd (offers) query
  });
});

describe('list() — staff/owner browsing (ownRequest = true) is unchanged: 1 row per StoreProduct', () => {
  test('admin moderation view (status=PENDING) still returns one item per StoreProduct, uses count()', async () => {
    const offerA = makeOffer({
      id: 'sp-a', productId: 'prod-1', price: 91500000, createdAt: new Date('2026-01-01'), storeId: 'store-a',
    });
    const offerB = makeOffer({
      id: 'sp-b', productId: 'prod-1', price: 89000000, createdAt: new Date('2026-01-02'), storeId: 'store-b',
    });
    offerA.status = 'PENDING';
    offerB.status = 'PENDING';

    mockStoreProductFindMany.mockImplementationOnce(async () => [offerB, offerA]); // findMany (paginated, no distinct)
    mockStoreProductCount.mockImplementationOnce(async () => 2);

    const staffRequester = { id: 'admin-1', permissions: ['products:moderate'] };
    const result = await service.list({ status: 'PENDING', page: 1, pageSize: 24 }, staffRequester);

    expect(result.items).toHaveLength(2); // both stores' PENDING submissions are individually visible
    expect(result.total).toBe(2);
    expect(mockStoreProductCount).toHaveBeenCalledTimes(1);
    const findManyArgs = mockStoreProductFindMany.mock.calls[0][0];
    expect(findManyArgs.distinct).toBeUndefined(); // no dedup for the moderation path
    expect(findManyArgs.where.status).toBe('PENDING');
  });

  test("seller viewing their own store's offers (storeId + status, ownRequest via ownership) is unchanged", async () => {
    const offer = makeOffer({
      id: 'sp-owner', productId: 'prod-1', price: 89000000, createdAt: new Date('2026-01-02'), storeId: 'store-owner',
    });
    offer.status = 'REJECTED';

    mockStoreFindUnique.mockImplementationOnce(async () => ({ id: 'store-owner', sellerId: 'seller-1' }));
    mockStoreProductFindMany.mockImplementationOnce(async () => [offer]);
    mockStoreProductCount.mockImplementationOnce(async () => 1);

    const sellerRequester = { id: 'seller-1', permissions: ['products:create_own'] };
    const result = await service.list({
      storeId: 'store-owner', status: 'REJECTED', page: 1, pageSize: 24,
    }, sellerRequester);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].status).toBe('REJECTED'); // seller can see their own rejected offer
    const findManyArgs = mockStoreProductFindMany.mock.calls[0][0];
    expect(findManyArgs.distinct).toBeUndefined();
  });
});
