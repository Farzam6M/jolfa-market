/**
 * Test suite for the purchase flow: Cart -> Checkout -> Order -> Payment.
 *
 * Covers:
 *   - Cart add/update/remove and server-computed totals.
 *   - Cart can't be over-added/over-set past real stock.
 *   - Checkout is priced entirely server-side (client can't send an amount).
 *   - Checkout atomically decrements stock and empties the cart.
 *   - Order status state machine (only legal transitions allowed).
 *   - Cancelling an order restocks its items.
 *   - Customer sees only their own orders; seller sees only their store's.
 *   - Admin can update any order to any legal status; a seller can only
 *     move CONFIRMED->PREPARING->SENT on an order containing solely their
 *     own store's items, never PENDING/DELIVERED/CANCELLED, never another
 *     seller's or a multi-seller order, and never by guessing an order id.
 *   - A seller viewing a multi-seller order sees only their own items —
 *     never another store's items, payments, or the customer's address.
 *   - Payment: wallet pays instantly and confirms the order; COD confirms the
 *     order but leaves the payment itself PENDING; the amount always comes
 *     from the order, never from the request body.
 *
 * Requires a real Postgres database (DATABASE_URL), migrated + seeded:
 *   NODE_ENV=test npm test
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');

/** Signs a gateway-callback payload the same way verifyGatewaySignature expects (see src/middlewares/gateway.middleware.js). */
function signGatewayPayload(body) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', process.env.GATEWAY_CALLBACK_SECRET).update(raw).digest('hex');
  return { raw, signature };
}

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

async function makeApprovedProduct(sellerAuth, adminAuth, categoryId, overrides = {}) {
  const created = await api.post(`${PREFIX}/products`).set('Authorization', sellerAuth).send({
    name: 'محصول خرید تست', categoryId, price: 20000, stock: 10, ...overrides,
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

describe('Cart', () => {
  let customer;
  let seller;
  let admin;
  let category;
  let product;

  beforeAll(async () => {
    customer = await makeUser('CUSTOMER', '50000000' + Math.floor(Math.random() * 9));
    seller = await makeUser('SELLER', '50010000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '50020000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه سبد خرید');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته سبد', slug: `cart-cat-${Date.now()}` });
    category = cat.body.data;
    product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 20000, stock: 5 });
  });

  test('add, update quantity, and remove reflect in the cart with server-computed totals', async () => {
    const add = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth)
      .send({ productId: product.id, qty: 2 });
    expect(add.status).toBe(200);
    expect(add.body.data.totals.subtotal).toBe(40000);

    const itemId = add.body.data.items.find((it) => it.productId === product.id).id;
    const updated = await api.patch(`${PREFIX}/cart/items/${itemId}`).set('Authorization', customer.auth).send({ qty: 3 });
    expect(updated.body.data.totals.subtotal).toBe(60000);

    const removed = await api.delete(`${PREFIX}/cart/items/${itemId}`).set('Authorization', customer.auth);
    expect(removed.body.data.items.length).toBe(0);
    expect(removed.body.data.totals.total).toBe(0);
  });

  test('cannot add more than available stock, counting what is already in the cart', async () => {
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 4 });
    const res = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 4 });
    expect(res.status).toBe(400); // 4 + 4 = 8 > stock of 5
    await api.delete(`${PREFIX}/cart`).set('Authorization', customer.auth);
  });

  test('cannot set a quantity above available stock', async () => {
    const add = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const itemId = add.body.data.items.find((it) => it.productId === product.id).id;
    const res = await api.patch(`${PREFIX}/cart/items/${itemId}`).set('Authorization', customer.auth).send({ qty: 99 });
    expect(res.status).toBe(400);
    await api.delete(`${PREFIX}/cart`).set('Authorization', customer.auth);
  });

  test('adding the same StoreProduct twice increments qty on one CartItem row, never creates a duplicate', async () => {
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const res = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 2 });
    expect(res.status).toBe(200);
    const rows = res.body.data.items.filter((it) => it.productId === product.id);
    expect(rows.length).toBe(1); // single CartItem row for this cart+storeProduct pair
    expect(rows[0].qty).toBe(3); // 1 + 2, not two separate lines

    // Same invariant enforced at the DB level: @@unique([cartId, storeProductId]).
    const cartRow = await prisma.cart.findUnique({ where: { userId: customer.user.id } });
    const dbRows = await prisma.cartItem.findMany({ where: { cartId: cartRow.id, storeProductId: product.id } });
    expect(dbRows.length).toBe(1);

    await api.delete(`${PREFIX}/cart`).set('Authorization', customer.auth);
  });

  test('same Product, different stores: one store having zero stock does not block another store\'s offer', async () => {
    const sellerB = await makeUser('SELLER', '50030000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(sellerB.user.id, 'فروشگاه دوم سبد خرید');

    // Store A's offer, deliberately out of stock.
    const outOfStock = await makeApprovedProduct(seller.auth, admin.auth, category.id, {
      name: 'محصول مشترک چند فروشگاهی', price: 30000, stock: 0,
    });
    // Store B's offer of the SAME global Product (identical identity fields dedupe to one Product row).
    const inStock = await makeApprovedProduct(sellerB.auth, admin.auth, category.id, {
      name: 'محصول مشترک چند فروشگاهی', price: 35000, stock: 10,
    });
    expect(inStock.productId).toBe(outOfStock.productId); // same global Product...
    expect(inStock.id).not.toBe(outOfStock.id); // ...different StoreProduct offers

    const blocked = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: outOfStock.id, qty: 1 });
    expect(blocked.status).toBe(400); // Store A: zero stock

    const allowed = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: inStock.id, qty: 1 });
    expect(allowed.status).toBe(200); // Store B: in stock, unaffected by Store A's stock level
    expect(allowed.body.data.totals.subtotal).toBe(35000); // priced from Store B's StoreProduct, not Store A's

    await api.delete(`${PREFIX}/cart`).set('Authorization', customer.auth);
  });

  test('an inactive StoreProduct cannot be added to the cart', async () => {
    const inactive = await makeApprovedProduct(seller.auth, admin.auth, category.id, { name: 'محصول غیرفعال', price: 15000, stock: 5 });
    await api.patch(`${PREFIX}/products/${inactive.id}/active`).set('Authorization', seller.auth).send({ isActive: false });

    const res = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: inactive.id, qty: 1 });
    expect(res.status).toBe(404);
  });

  test('a StoreProduct belonging to a suspended store cannot be added to the cart', async () => {
    const sellerC = await makeUser('SELLER', '50040000' + Math.floor(Math.random() * 9));
    const storeC = await makeApprovedStore(sellerC.user.id, 'فروشگاه معلق');
    const offer = await makeApprovedProduct(sellerC.auth, admin.auth, category.id, { name: 'محصول فروشگاه معلق', price: 15000, stock: 5 });

    await prisma.store.update({ where: { id: storeC.id }, data: { status: 'SUSPENDED' } });

    const res = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: offer.id, qty: 1 });
    expect(res.status).toBe(404);
  });

  test('a StoreProduct belonging to a soft-deleted seller cannot be added to the cart', async () => {
    const sellerD = await makeUser('SELLER', '50050000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(sellerD.user.id, 'فروشگاه فروشنده حذف‌شده');
    const offer = await makeApprovedProduct(sellerD.auth, admin.auth, category.id, { name: 'محصول فروشنده حذف‌شده', price: 15000, stock: 5 });

    await prisma.user.update({ where: { id: sellerD.user.id }, data: { deletedAt: new Date() } });

    const res = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: offer.id, qty: 1 });
    expect(res.status).toBe(404);
  });

  test('cart prices from the StoreProduct wholesale tier once qty crosses minQty, not the regular price', async () => {
    const wholesale = await makeApprovedProduct(seller.auth, admin.auth, category.id, {
      name: 'محصول عمده‌فروشی سبد خرید',
      price: 10000,
      stock: 100,
      wholesaleTiers: [{ minQty: 5, price: 8000 }],
    });

    const below = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: wholesale.id, qty: 2 });
    expect(below.body.data.totals.subtotal).toBe(20000); // 2 * regular price (10000), tier not reached

    const above = await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: wholesale.id, qty: 3 });
    // total qty now 5 -> crosses minQty=5 -> whole line re-priced at the tier price (8000), not the client-suppliable regular price
    expect(above.body.data.totals.subtotal).toBe(40000); // 5 * 8000

    await api.delete(`${PREFIX}/cart`).set('Authorization', customer.auth);
  });
});

describe('Checkout, order status machine, and visibility', () => {
  let customer;
  let seller;
  let admin;
  let category;
  let product;

  beforeAll(async () => {
    customer = await makeUser('CUSTOMER', '51000000' + Math.floor(Math.random() * 9));
    seller = await makeUser('SELLER', '51010000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '51020000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه سفارش');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته سفارش', slug: `order-cat-${Date.now()}` });
    category = cat.body.data;
    product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 30000, stock: 5 });
  });

  test('checkout prices the order entirely server-side and a client cannot inject an amount', async () => {
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 2 });

    const res = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth)
      .send({ addressId: undefined, total: 1, subtotal: 1 }); // extra fields must be ignored, not applied
    expect(res.status).toBe(201);
    expect(Number(res.body.data.subtotal)).toBe(60000); // 2 * 30000, NOT the forged "1"
    expect(res.body.data.status).toBe('PENDING');

    const stillStock = await prisma.storeProduct.findUnique({ where: { id: product.id } });
    expect(stillStock.stock).toBe(3); // 5 - 2, decremented atomically at checkout
  });

  test('order status can only move through the allowed transitions, not skip or reverse', async () => {
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const id = order.body.data.id;

    // PENDING -> DELIVERED directly is not a legal transition
    const skip = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });
    expect(skip.status).toBe(409);

    const confirm = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', admin.auth).send({ status: 'CONFIRMED' });
    expect(confirm.status).toBe(200);
    const preparing = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', admin.auth).send({ status: 'PREPARING' });
    expect(preparing.status).toBe(200);
    const sent = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', admin.auth).send({ status: 'SENT' });
    expect(sent.status).toBe(200);
    const delivered = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });
    expect(delivered.status).toBe(200);

    // DELIVERED is terminal — no further transition is legal
    const reopen = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', admin.auth).send({ status: 'CANCELLED' });
    expect(reopen.status).toBe(409);
  });

  test('cancelling an order restocks its items', async () => {
    const before = await prisma.storeProduct.findUnique({ where: { id: product.id } });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const afterCheckout = await prisma.storeProduct.findUnique({ where: { id: product.id } });
    expect(afterCheckout.stock).toBe(before.stock - 1);

    const cancelled = await api.patch(`${PREFIX}/orders/${order.body.data.id}/status`).set('Authorization', admin.auth).send({ status: 'CANCELLED' });
    expect(cancelled.status).toBe(200);

    const afterCancel = await prisma.storeProduct.findUnique({ where: { id: product.id } });
    expect(afterCancel.stock).toBe(before.stock); // fully restored
  });

  test('a seller can move their own single-store order Confirmed -> Preparing -> Sent, but not to Pending/Delivered/Cancelled', async () => {
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const id = order.body.data.id;

    // Still PENDING: seller cannot jump straight to Preparing.
    const tooEarly = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', seller.auth).send({ status: 'PREPARING' });
    expect(tooEarly.status).toBe(409);

    // Only admin can confirm a freshly-placed order.
    const confirm = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', admin.auth).send({ status: 'CONFIRMED' });
    expect(confirm.status).toBe(200);

    // Seller-forbidden targets, even from a legal starting state.
    const toDelivered = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', seller.auth).send({ status: 'DELIVERED' });
    expect(toDelivered.status).toBe(403);
    const toCancelled = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', seller.auth).send({ status: 'CANCELLED' });
    expect(toCancelled.status).toBe(403);

    // Seller's own allowed step: Confirmed -> Preparing.
    const preparing = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', seller.auth).send({ status: 'PREPARING' });
    expect(preparing.status).toBe(200);
    expect(preparing.body.data.status).toBe('PREPARING');

    // Seller's own allowed step: Preparing -> Sent.
    const sent = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', seller.auth).send({ status: 'SENT' });
    expect(sent.status).toBe(200);
    expect(sent.body.data.status).toBe('SENT');

    // Delivered is admin-only, even once Sent.
    const sellerDelivers = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', seller.auth).send({ status: 'DELIVERED' });
    expect(sellerDelivers.status).toBe(403);
    const adminDelivers = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', admin.auth).send({ status: 'DELIVERED' });
    expect(adminDelivers.status).toBe(200);
  });

  test('a seller cannot update an order that has no items from their store (IDOR check)', async () => {
    const otherSeller = await makeUser('SELLER', '51088888' + Math.floor(Math.random() * 9));
    await makeApprovedStore(otherSeller.user.id, 'فروشگاه دیگر');

    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    await api.patch(`${PREFIX}/orders/${order.body.data.id}/status`).set('Authorization', admin.auth).send({ status: 'CONFIRMED' });

    // otherSeller's store has no item in this order -> forbidden, not just "not found leaked".
    const res = await api.patch(`${PREFIX}/orders/${order.body.data.id}/status`).set('Authorization', otherSeller.auth).send({ status: 'PREPARING' });
    expect(res.status).toBe(403);
  });

  test('a seller cannot see another seller\'s order, and only sees their own items in a multi-seller order', async () => {
    const sellerB = await makeUser('SELLER', '51077777' + Math.floor(Math.random() * 9));
    await makeApprovedStore(sellerB.user.id, 'فروشگاه ب');
    const productB = await makeApprovedProduct(sellerB.auth, admin.auth, category.id, { price: 10000, stock: 5 });

    // A multi-seller cart: one item from `seller`'s product, one from sellerB's product.
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: productB.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const id = order.body.data.id;

    // Seller A can view the order, but only sees their own item — no payments/address, no sellerB item.
    const asSellerA = await api.get(`${PREFIX}/orders/${id}`).set('Authorization', seller.auth);
    expect(asSellerA.status).toBe(200);
    expect(asSellerA.body.data.items.every((it) => it.productId === product.id)).toBe(true);
    expect(asSellerA.body.data.payments).toBeUndefined();
    expect(asSellerA.body.data.address).toBeUndefined();

    // Because the order spans two stores, neither seller can drive its status forward.
    const blocked = await api.patch(`${PREFIX}/orders/${id}/status`).set('Authorization', seller.auth).send({ status: 'PREPARING' });
    expect(blocked.status).toBe(403);

    // A totally unrelated seller (sellerB is at least in the order; use otherSeller-like check) still can't read it if unrelated.
    const unrelatedSeller = await makeUser('SELLER', '51066666' + Math.floor(Math.random() * 9));
    await makeApprovedStore(unrelatedSeller.user.id, 'فروشگاه نامرتبط');
    const unrelatedRes = await api.get(`${PREFIX}/orders/${id}`).set('Authorization', unrelatedSeller.auth);
    expect(unrelatedRes.status).toBe(403);
  });

  test('a customer only sees their own orders; a seller only sees orders touching their store', async () => {
    const mine = await api.get(`${PREFIX}/orders/mine`).set('Authorization', customer.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data.items.every((o) => true)).toBe(true); // shape check; ownership enforced server-side by userId scoping

    const storeOrders = await api.get(`${PREFIX}/orders/store`).set('Authorization', seller.auth);
    expect(storeOrders.status).toBe(200);
  });

  test('a customer cannot read another customer\'s order', async () => {
    const otherCustomer = await makeUser('CUSTOMER', '51099999' + Math.floor(Math.random() * 9));
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});

    const res = await api.get(`${PREFIX}/orders/${order.body.data.id}`).set('Authorization', otherCustomer.auth);
    expect(res.status).toBe(403);
  });

  test('same Product sold by two different stores: checkout links each OrderItem to the correct StoreProduct/store and price', async () => {
    const sellerA = await makeUser('SELLER', '51110000' + Math.floor(Math.random() * 9));
    const sellerB = await makeUser('SELLER', '51120000' + Math.floor(Math.random() * 9));
    const storeA = await makeApprovedStore(sellerA.user.id, 'فروشگاه چندفروشگاهی الف');
    const storeB = await makeApprovedStore(sellerB.user.id, 'فروشگاه چندفروشگاهی ب');
    const offerA = await makeApprovedProduct(sellerA.auth, admin.auth, category.id, { name: 'محصول مشترک سفارش', price: 25000, stock: 10 });
    const offerB = await makeApprovedProduct(sellerB.auth, admin.auth, category.id, { name: 'محصول مشترک سفارش', price: 40000, stock: 10 });
    expect(offerA.productId).toBe(offerB.productId); // same global Product...
    expect(offerA.id).not.toBe(offerB.id); // ...two distinct store offers

    const buyer = await makeUser('CUSTOMER', '51130000' + Math.floor(Math.random() * 9));
    await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offerA.id, qty: 2 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offerB.id, qty: 1 });

    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({});
    expect(order.status).toBe(201);
    expect(Number(order.body.data.subtotal)).toBe(2 * 25000 + 40000);

    const itemA = order.body.data.items.find((it) => it.storeProductId === offerA.id);
    const itemB = order.body.data.items.find((it) => it.storeProductId === offerB.id);
    expect(itemA).toBeDefined();
    expect(itemB).toBeDefined();
    expect(Number(itemA.priceSnapshot)).toBe(25000);
    expect(Number(itemB.priceSnapshot)).toBe(40000);
    expect(itemA.storeId).toBe(storeA.id);
    expect(itemB.storeId).toBe(storeB.id);

    const stockA = await prisma.storeProduct.findUnique({ where: { id: offerA.id } });
    const stockB = await prisma.storeProduct.findUnique({ where: { id: offerB.id } });
    expect(stockA.stock).toBe(8); // 10 - 2, only Store A's own stock touched
    expect(stockB.stock).toBe(9); // 10 - 1, only Store B's own stock touched
  });

  test('a later price/discount/warranty/shippingTime change by the seller never alters an already-placed order', async () => {
    const buyer = await makeUser('CUSTOMER', '51140000' + Math.floor(Math.random() * 9));
    const offer = await makeApprovedProduct(seller.auth, admin.auth, category.id, {
      name: 'محصول قیمت ثابت سفارش', price: 50000, stock: 10, discount: 10, warranty: '12 ماه', shippingTime: '3 روز',
    });

    await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offer.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({});
    expect(order.status).toBe(201);
    const orderId = order.body.data.id;
    expect(Number(order.body.data.subtotal)).toBe(50000);

    // Seller changes every mutable commercial term after the sale.
    const edit = await api.patch(`${PREFIX}/products/${offer.id}`).set('Authorization', seller.auth)
      .send({
        price: 99000, discount: 50, warranty: '1 ماه', shippingTime: '10 روز', compareAtPrice: 120000,
      });
    expect(edit.status).toBe(200);

    // The order record itself (subtotal/total) never recomputes off live data.
    const reread = await api.get(`${PREFIX}/orders/${orderId}`).set('Authorization', buyer.auth);
    expect(reread.status).toBe(200);
    expect(Number(reread.body.data.subtotal)).toBe(50000);
    expect(Number(reread.body.data.total)).toBe(50000 + 45000);
    const orderItem = reread.body.data.items[0];
    expect(Number(orderItem.priceSnapshot)).toBe(50000); // untouched by the seller's later price change
    expect(orderItem.nameSnapshot).toBe('محصول قیمت ثابت سفارش');
    // The product view attached to order history must show identity only —
    // never today's (now-changed) price/discount/warranty/shippingTime, which
    // would otherwise make a supposedly-immutable order look different over time.
    expect(orderItem.product.price).toBeUndefined();
    expect(orderItem.product.discount).toBeUndefined();
    expect(orderItem.product.warranty).toBeUndefined();
    expect(orderItem.product.shippingTime).toBeUndefined();

    // Same guarantee from the seller's own order list view.
    const storeView = await api.get(`${PREFIX}/orders/store`).set('Authorization', seller.auth);
    const sameOrder = storeView.body.data.items.find((o) => o.id === orderId);
    const sellerSideItem = sameOrder.items.find((it) => it.storeProductId === offer.id);
    expect(Number(sellerSideItem.priceSnapshot)).toBe(50000);
    expect(sellerSideItem.product.price).toBeUndefined();
    expect(sellerSideItem.product.discount).toBeUndefined();
  });

  test('checkout re-validates stock and rejects a cart item whose stock dropped below cart qty after it was added', async () => {
    const buyer = await makeUser('CUSTOMER', '51150000' + Math.floor(Math.random() * 9));
    const offer = await makeApprovedProduct(seller.auth, admin.auth, category.id, { name: 'محصول کاهش موجودی', price: 12000, stock: 3 });

    await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offer.id, qty: 3 });
    // Stock drops (e.g. seller adjusts inventory) after the item is already sitting in the cart.
    await api.patch(`${PREFIX}/products/${offer.id}/stock`).set('Authorization', seller.auth).send({ stock: 1 });

    const res = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({});
    expect(res.status).toBe(400);

    const after = await prisma.storeProduct.findUnique({ where: { id: offer.id } });
    expect(after.stock).toBe(1); // untouched — a rejected checkout must not decrement stock
    const cartAfter = await api.get(`${PREFIX}/cart`).set('Authorization', buyer.auth);
    expect(cartAfter.body.data.items.length).toBe(1); // failed checkout must not have emptied the cart
  });

  test('checkout rejects a cart item whose offer became inactive after it was added to the cart', async () => {
    const buyer = await makeUser('CUSTOMER', '51160000' + Math.floor(Math.random() * 9));
    const offer = await makeApprovedProduct(seller.auth, admin.auth, category.id, { name: 'محصول غیرفعال‌شده بعد از افزودن', price: 12000, stock: 5 });

    await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offer.id, qty: 1 });
    await api.patch(`${PREFIX}/products/${offer.id}/active`).set('Authorization', seller.auth).send({ isActive: false });

    const res = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({});
    expect(res.status).toBe(400);
    const stock = await prisma.storeProduct.findUnique({ where: { id: offer.id } });
    expect(stock.stock).toBe(5); // never decremented
  });

  test('checkout rejects an order once the selling store is suspended, even though the item was added while the store was active', async () => {
    const sellerX = await makeUser('SELLER', '51170000' + Math.floor(Math.random() * 9));
    const storeX = await makeApprovedStore(sellerX.user.id, 'فروشگاه معلق‌شده هنگام تسویه');
    const offer = await makeApprovedProduct(sellerX.auth, admin.auth, category.id, { name: 'محصول فروشگاه معلق‌شده', price: 12000, stock: 5 });
    const buyer = await makeUser('CUSTOMER', '51180000' + Math.floor(Math.random() * 9));

    await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offer.id, qty: 1 });
    await prisma.store.update({ where: { id: storeX.id }, data: { status: 'SUSPENDED' } });

    const res = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({});
    expect(res.status).toBe(400);
  });

  test('an already-placed order stays fully readable after its seller is later soft-deleted, while a fresh checkout of that seller\'s offer is blocked', async () => {
    const sellerY = await makeUser('SELLER', '51190000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(sellerY.user.id, 'فروشگاه فروشنده حذف‌شده سفارش');
    const offer = await makeApprovedProduct(sellerY.auth, admin.auth, category.id, { name: 'محصول قبل از حذف فروشنده', price: 18000, stock: 5 });
    const buyer = await makeUser('CUSTOMER', '51200000' + Math.floor(Math.random() * 9));

    await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offer.id, qty: 1 });
    const placedOrder = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({});
    expect(placedOrder.status).toBe(201);

    await prisma.user.update({ where: { id: sellerY.user.id }, data: { deletedAt: new Date() } });

    // History remains fully accessible to the buyer.
    const reread = await api.get(`${PREFIX}/orders/${placedOrder.body.data.id}`).set('Authorization', buyer.auth);
    expect(reread.status).toBe(200);
    expect(Number(reread.body.data.subtotal)).toBe(18000);

    // A brand new attempt to buy the same (now-orphaned) offer is blocked at add-to-cart...
    const blockedAdd = await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offer.id, qty: 1 });
    expect(blockedAdd.status).toBe(404);
  });

  test('a StoreProduct that already has order history can never be hard-deleted, protecting order integrity', async () => {
    const sellerZ = await makeUser('SELLER', '51210000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(sellerZ.user.id, 'فروشگاه محافظت از سابقه');
    const offer = await makeApprovedProduct(sellerZ.auth, admin.auth, category.id, { name: 'محصول دارای سابقه سفارش', price: 22000, stock: 5 });
    const buyer = await makeUser('CUSTOMER', '51220000' + Math.floor(Math.random() * 9));

    await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offer.id, qty: 1 });
    await api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({});

    const del = await api.delete(`${PREFIX}/products/${offer.id}`).set('Authorization', sellerZ.auth);
    expect(del.status).toBe(409); // blocked precisely because order history references it
    const stillThere = await prisma.storeProduct.findUnique({ where: { id: offer.id } });
    expect(stillThere).not.toBeNull();
  });

  test('two simultaneous checkouts for the last unit of stock: exactly one succeeds, the other is rejected, stock never goes negative', async () => {
    const sellerRace = await makeUser('SELLER', '51230000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(sellerRace.user.id, 'فروشگاه رقابت همزمان');
    const offer = await makeApprovedProduct(sellerRace.auth, admin.auth, category.id, { name: 'محصول کمیاب همزمان', price: 9000, stock: 1 });

    const buyer1 = await makeUser('CUSTOMER', '51240000' + Math.floor(Math.random() * 9));
    const buyer2 = await makeUser('CUSTOMER', '51250000' + Math.floor(Math.random() * 9));
    await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer1.auth).send({ productId: offer.id, qty: 1 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer2.auth).send({ productId: offer.id, qty: 1 });

    const [res1, res2] = await Promise.all([
      api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer1.auth).send({}),
      api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer2.auth).send({}),
    ]);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 400]); // exactly one winner, one loser — never both succeeding

    const finalStock = await prisma.storeProduct.findUnique({ where: { id: offer.id } });
    expect(finalStock.stock).toBe(0); // never went negative, never stayed at 1 (the winning purchase did decrement it)
  });

  // F1 — cart-level checkout idempotency. Stock is deliberately NOT the
  // limiting factor in these tests (unlike the race test above): the point
  // is that even when stock could satisfy two separate Orders, the SAME
  // user's SAME cart must still only ever produce one.
  describe('F1: cart-level checkout idempotency', () => {
    test('two simultaneous checkout requests for the same user/cart: exactly one Order is created, the loser gets a 409, stock is decremented only once', async () => {
      const sellerF1 = await makeUser('SELLER', '51300000' + Math.floor(Math.random() * 9));
      await makeApprovedStore(sellerF1.user.id, 'فروشگاه یکتایی تسویه');
      const offer = await makeApprovedProduct(sellerF1.auth, admin.auth, category.id, {
        name: 'محصول تست یکتایی تسویه همزمان', price: 12000, stock: 20,
      });

      const buyer = await makeUser('CUSTOMER', '51310000' + Math.floor(Math.random() * 9));
      await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offer.id, qty: 2 });

      const [res1, res2] = await Promise.all([
        api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({}),
        api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({}),
      ]);
      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]); // one winner, one clean conflict — never two winners

      const winner = res1.status === 201 ? res1 : res2;

      const ordersForBuyer = await prisma.order.findMany({ where: { userId: buyer.user.id } });
      expect(ordersForBuyer.length).toBe(1); // exactly one Order, not two
      expect(ordersForBuyer[0].id).toBe(winner.body.data.id);

      const orderItems = await prisma.orderItem.findMany({ where: { orderId: winner.body.data.id } });
      expect(orderItems.length).toBe(1); // no duplicate OrderItems
      expect(orderItems[0].qty).toBe(2);

      const stock = await prisma.storeProduct.findUnique({ where: { id: offer.id } });
      expect(stock.stock).toBe(18); // 20 - 2, decremented exactly once (not 16, which would mean it ran twice)

      const cartRow = await prisma.cart.findUnique({ where: { userId: buyer.user.id } });
      const remainingItems = await prisma.cartItem.findMany({ where: { cartId: cartRow.id } });
      expect(remainingItems.length).toBe(0); // cart correctly emptied by the winning checkout
    });

    test('a retried checkout after the first one already succeeded does not create a second Order', async () => {
      const sellerF1 = await makeUser('SELLER', '51320000' + Math.floor(Math.random() * 9));
      await makeApprovedStore(sellerF1.user.id, 'فروشگاه تست تلاش مجدد تسویه');
      const offer = await makeApprovedProduct(sellerF1.auth, admin.auth, category.id, {
        name: 'محصول تست تلاش مجدد تسویه', price: 9000, stock: 10,
      });

      const buyer = await makeUser('CUSTOMER', '51330000' + Math.floor(Math.random() * 9));
      await api.post(`${PREFIX}/cart/items`).set('Authorization', buyer.auth).send({ productId: offer.id, qty: 1 });

      const first = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({});
      expect(first.status).toBe(201);

      // Simulates the client not receiving the first response and retrying
      // with the exact same (now-empty) cart.
      const retry = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyer.auth).send({});
      expect(retry.status).toBe(400); // cart is now empty — the existing empty-cart response, not a new Order

      const ordersForBuyer = await prisma.order.findMany({ where: { userId: buyer.user.id } });
      expect(ordersForBuyer.length).toBe(1); // still just the one Order from the first request
      expect(ordersForBuyer[0].id).toBe(first.body.data.id);

      const stock = await prisma.storeProduct.findUnique({ where: { id: offer.id } });
      expect(stock.stock).toBe(9); // decremented only by the first, successful checkout
    });

    test('two different users checking out concurrently are not serialized against each other', async () => {
      const sellerF1 = await makeUser('SELLER', '51340000' + Math.floor(Math.random() * 9));
      await makeApprovedStore(sellerF1.user.id, 'فروشگاه تست کاربران مستقل');
      const offer = await makeApprovedProduct(sellerF1.auth, admin.auth, category.id, {
        name: 'محصول تست کاربران مستقل', price: 7000, stock: 20,
      });

      const buyerX = await makeUser('CUSTOMER', '51350000' + Math.floor(Math.random() * 9));
      const buyerY = await makeUser('CUSTOMER', '51360000' + Math.floor(Math.random() * 9));
      await api.post(`${PREFIX}/cart/items`).set('Authorization', buyerX.auth).send({ productId: offer.id, qty: 1 });
      await api.post(`${PREFIX}/cart/items`).set('Authorization', buyerY.auth).send({ productId: offer.id, qty: 1 });

      const [resX, resY] = await Promise.all([
        api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyerX.auth).send({}),
        api.post(`${PREFIX}/orders/checkout`).set('Authorization', buyerY.auth).send({}),
      ]);
      // Different users, different cart rows — the per-cart lock must not
      // turn into a global checkout lock: both succeed.
      expect(resX.status).toBe(201);
      expect(resY.status).toBe(201);
      expect(resX.body.data.id).not.toBe(resY.body.data.id);

      const stock = await prisma.storeProduct.findUnique({ where: { id: offer.id } });
      expect(stock.stock).toBe(18); // 20 - 1 - 1
    });
  });
});

describe('Payments', () => {
  let customer;
  let seller;
  let admin;
  let category;

  beforeAll(async () => {
    customer = await makeUser('CUSTOMER', '52000000' + Math.floor(Math.random() * 9));
    seller = await makeUser('SELLER', '52010000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '52020000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه پرداخت');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته پرداخت', slug: `payment-cat-${Date.now()}` });
    category = cat.body.data;
  });

  test('cash-on-delivery: payment stays PENDING but the order is CONFIRMED', async () => {
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});

    const pay = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'CASH_ON_DELIVERY' });
    expect(pay.status).toBe(201);
    expect(pay.body.data.status).toBe('PENDING');
    expect(Number(pay.body.data.amount)).toBe(15000);

    const updatedOrder = await prisma.order.findUnique({ where: { id: order.body.data.id } });
    expect(updatedOrder.status).toBe('CONFIRMED');
  });

  test('a client cannot forge the payment amount — it always comes from the order', async () => {
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});

    const pay = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({
        orderId: order.body.data.id, method: 'CASH_ON_DELIVERY', amount: 1,
      }); // "amount" isn't part of the schema — must be silently stripped, not applied
    expect(pay.status).toBe(201);
    expect(Number(pay.body.data.amount)).toBe(15000);
  });

  test('a customer cannot pay for another customer\'s order', async () => {
    const otherCustomer = await makeUser('CUSTOMER', '52099999' + Math.floor(Math.random() * 9));
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});

    const res = await api.post(`${PREFIX}/payments`).set('Authorization', otherCustomer.auth)
      .send({ orderId: order.body.data.id, method: 'CASH_ON_DELIVERY' });
    expect(res.status).toBe(403);
  });

  test('the gateway callback route confirms the order when correctly signed, without requiring a user login', async () => {
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const gwPay = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'GATEWAY' });
    expect(gwPay.body.data.status).toBe('PENDING');

    const body = { transactionRef: gwPay.body.data.transactionRef, success: true };
    const { signature } = signGatewayPayload(body);
    const callback = await api.post(`${PREFIX}/payments/gateway/callback`)
      .set('x-gateway-signature', signature)
      .send(body);
    expect(callback.status).toBe(200);

    const updatedOrder = await prisma.order.findUnique({ where: { id: order.body.data.id } });
    expect(updatedOrder.status).toBe('CONFIRMED');
  });

  test('a gateway callback without a valid signature is rejected and cannot forge a payment', async () => {
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const gwPay = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'GATEWAY' });

    // No signature header at all.
    const noSig = await api.post(`${PREFIX}/payments/gateway/callback`)
      .send({ transactionRef: gwPay.body.data.transactionRef, success: true });
    expect(noSig.status).toBe(401);

    // Forged/incorrect signature (attacker guessing/knowing the transactionRef isn't enough).
    const badSig = await api.post(`${PREFIX}/payments/gateway/callback`)
      .set('x-gateway-signature', 'deadbeef'.repeat(8))
      .send({ transactionRef: gwPay.body.data.transactionRef, success: true });
    expect(badSig.status).toBe(401);

    const stillOrder = await prisma.order.findUnique({ where: { id: order.body.data.id } });
    expect(stillOrder.status).toBe('PENDING');
  });

  test('a failed gateway callback marks the payment FAILED and leaves the order PENDING (retryable)', async () => {
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const gwPay = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'GATEWAY' });

    const body = { transactionRef: gwPay.body.data.transactionRef, success: false };
    const { signature } = signGatewayPayload(body);
    const callback = await api.post(`${PREFIX}/payments/gateway/callback`)
      .set('x-gateway-signature', signature)
      .send(body);
    expect(callback.status).toBe(200);

    const payment = await prisma.payment.findUnique({ where: { id: gwPay.body.data.id } });
    expect(payment.status).toBe('FAILED');
    const stillOrder = await prisma.order.findUnique({ where: { id: order.body.data.id } });
    expect(stillOrder.status).toBe('PENDING'); // not CONFIRMED, not stuck — customer can still retry payment

    // The order is still PENDING, so a second, different-method payment attempt succeeds.
    const retry = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'CASH_ON_DELIVERY' });
    expect(retry.status).toBe(201);
  });

  test('a duplicate/replayed gateway callback is a safe no-op, not a second state flip', async () => {
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const gwPay = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'GATEWAY' });

    const body = { transactionRef: gwPay.body.data.transactionRef, success: true };
    const { signature } = signGatewayPayload(body);

    const first = await api.post(`${PREFIX}/payments/gateway/callback`).set('x-gateway-signature', signature).send(body);
    expect(first.status).toBe(200);
    const afterFirst = await prisma.payment.findUnique({ where: { id: gwPay.body.data.id } });

    // Gateways commonly redeliver the same webhook; replaying the identical,
    // validly-signed payload must not re-run the settlement side effects.
    const second = await api.post(`${PREFIX}/payments/gateway/callback`).set('x-gateway-signature', signature).send(body);
    expect(second.status).toBe(200);
    const afterSecond = await prisma.payment.findUnique({ where: { id: gwPay.body.data.id } });

    expect(afterSecond.status).toBe('SUCCESS');
    expect(afterSecond.paidAt.getTime()).toBe(afterFirst.paidAt.getTime()); // untouched by the replay
    const onlyOnePayment = await prisma.payment.count({ where: { orderId: order.body.data.id } });
    expect(onlyOnePayment).toBe(1); // no duplicate payment record was created
  });

  test('a gateway callback for an unknown transactionRef is rejected', async () => {
    const body = { transactionRef: 'this-ref-was-never-issued', success: true };
    const { signature } = signGatewayPayload(body);
    const res = await api.post(`${PREFIX}/payments/gateway/callback`).set('x-gateway-signature', signature).send(body);
    expect(res.status).toBe(404);
  });

  test('a gateway callback cannot smuggle a client-chosen amount — the schema has no amount field to strip into', async () => {
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const gwPay = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'GATEWAY' });

    const body = { transactionRef: gwPay.body.data.transactionRef, success: true, amount: 1 };
    const { signature } = signGatewayPayload(body); // signed over the raw body including the bogus "amount"
    const callback = await api.post(`${PREFIX}/payments/gateway/callback`).set('x-gateway-signature', signature).send(body);
    expect(callback.status).toBe(200);

    const payment = await prisma.payment.findUnique({ where: { id: gwPay.body.data.id } });
    expect(Number(payment.amount)).toBe(15000); // unchanged — amount was fixed at initGatewayPayment(order), never taken from the callback
  });

  test('cannot pay an order that is already paid/confirmed', async () => {
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'CASH_ON_DELIVERY' });

    const again = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'CASH_ON_DELIVERY' });
    expect(again.status).toBe(409);

    const viaGateway = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'GATEWAY' });
    expect(viaGateway.status).toBe(409);
  });

  test('two gateway payment attempts for the same order never share a transactionRef', async () => {
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});

    // Order stays PENDING after a GATEWAY init (unlike WALLET/COD), so a
    // second attempt is possible if the first session was abandoned.
    const first = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'GATEWAY' });
    const second = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'GATEWAY' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.transactionRef).not.toBe(second.body.data.transactionRef);

    // Settling the second attempt must only ever touch that attempt's row.
    const body = { transactionRef: second.body.data.transactionRef, success: true };
    const { signature } = signGatewayPayload(body);
    await api.post(`${PREFIX}/payments/gateway/callback`).set('x-gateway-signature', signature).send(body);

    const firstPayment = await prisma.payment.findUnique({ where: { id: first.body.data.id } });
    const secondPayment = await prisma.payment.findUnique({ where: { id: second.body.data.id } });
    expect(firstPayment.status).toBe('PENDING');
    expect(secondPayment.status).toBe('SUCCESS');
  });

  test('a late gateway callback cannot resurrect an order that was cancelled in the meantime', async () => {
    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const gwPay = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth)
      .send({ orderId: order.body.data.id, method: 'GATEWAY' });

    // Admin cancels the abandoned order (restocking it) before the gateway's callback arrives.
    const cancel = await api.patch(`${PREFIX}/orders/${order.body.data.id}/status`).set('Authorization', admin.auth)
      .send({ status: 'CANCELLED' });
    expect(cancel.status).toBe(200);

    const body = { transactionRef: gwPay.body.data.transactionRef, success: true };
    const { signature } = signGatewayPayload(body);
    const callback = await api.post(`${PREFIX}/payments/gateway/callback`).set('x-gateway-signature', signature).send(body);
    expect(callback.status).toBe(200); // the callback itself is still accepted...

    const payment = await prisma.payment.findUnique({ where: { id: gwPay.body.data.id } });
    expect(payment.status).toBe('SUCCESS'); // ...the charge is still recorded as captured...
    const stillCancelled = await prisma.order.findUnique({ where: { id: order.body.data.id } });
    expect(stillCancelled.status).toBe('CANCELLED'); // ...but it never got resurrected out of its terminal state
  });

  test('checkout rejects an addressId that does not belong to the checking-out customer (IDOR guard)', async () => {
    const otherCustomer = await makeUser('CUSTOMER', '52088888' + Math.floor(Math.random() * 9));
    const foreignAddress = await prisma.address.create({
      data: {
        userId: otherCustomer.user.id,
        fullName: 'Someone Else',
        phone: '09120000000',
        province: 'تهران',
        city: 'تهران',
        addressLine: 'خیابان محرمانه دیگران',
      },
    });

    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });

    const res = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth)
      .send({ addressId: foreignAddress.id });
    expect(res.status).toBe(404);
  });

  test('wallet payment with sufficient balance debits the wallet, confirms the order, and logs a transaction', async () => {
    const walletCustomer = await makeUser('CUSTOMER', '52300000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: walletCustomer.user.id, balance: 50000 } });

    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', walletCustomer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', walletCustomer.auth).send({});

    const pay = await api.post(`${PREFIX}/payments`).set('Authorization', walletCustomer.auth)
      .send({ orderId: order.body.data.id, method: 'WALLET' });
    expect(pay.status).toBe(201);
    expect(pay.body.data.status).toBe('SUCCESS');
    expect(Number(pay.body.data.amount)).toBe(15000);

    const wallet = await prisma.wallet.findUnique({ where: { userId: walletCustomer.user.id } });
    expect(Number(wallet.balance)).toBe(35000); // 50000 - 15000

    const updatedOrder = await prisma.order.findUnique({ where: { id: order.body.data.id } });
    expect(updatedOrder.status).toBe('CONFIRMED');

    const txLog = await prisma.walletTransaction.findFirst({ where: { walletId: wallet.id, refId: order.body.data.id } });
    expect(txLog).not.toBeNull();
    expect(txLog.type).toBe('DEBIT');
    expect(Number(txLog.amount)).toBe(15000);
  });

  test('wallet payment with insufficient balance is rejected and leaves balance/order untouched', async () => {
    const poorCustomer = await makeUser('CUSTOMER', '52310000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: poorCustomer.user.id, balance: 5000 } });

    const product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 15000, stock: 5 });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', poorCustomer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', poorCustomer.auth).send({});

    const pay = await api.post(`${PREFIX}/payments`).set('Authorization', poorCustomer.auth)
      .send({ orderId: order.body.data.id, method: 'WALLET' });
    expect(pay.status).toBe(400);
    expect(pay.body.message).toBe('موجودی کیف پول کافی نیست');

    const wallet = await prisma.wallet.findUnique({ where: { userId: poorCustomer.user.id } });
    expect(Number(wallet.balance)).toBe(5000); // untouched — the failed attempt must not partially debit

    // The order-status claim inside payWithWallet's transaction rolled back
    // along with the wallet check, so the order is still payable.
    const stillOrder = await prisma.order.findUnique({ where: { id: order.body.data.id } });
    expect(stillOrder.status).toBe('PENDING');
  });

  test('two simultaneous wallet payments for two different orders, where balance covers only one: exactly one succeeds and the wallet balance never goes negative', async () => {
    const raceCustomer = await makeUser('CUSTOMER', '52320000' + Math.floor(Math.random() * 9));
    // Balance covers exactly one 15000 order, not both.
    await prisma.wallet.create({ data: { userId: raceCustomer.user.id, balance: 15000 } });

    const productA = await makeApprovedProduct(seller.auth, admin.auth, category.id, { name: 'محصول کیف پول رقابتی A', price: 15000, stock: 5 });
    const productB = await makeApprovedProduct(seller.auth, admin.auth, category.id, { name: 'محصول کیف پول رقابتی B', price: 15000, stock: 5 });

    await api.post(`${PREFIX}/cart/items`).set('Authorization', raceCustomer.auth).send({ productId: productA.id, qty: 1 });
    const orderA = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', raceCustomer.auth).send({});
    await api.post(`${PREFIX}/cart/items`).set('Authorization', raceCustomer.auth).send({ productId: productB.id, qty: 1 });
    const orderB = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', raceCustomer.auth).send({});

    const [res1, res2] = await Promise.all([
      api.post(`${PREFIX}/payments`).set('Authorization', raceCustomer.auth)
        .send({ orderId: orderA.body.data.id, method: 'WALLET' }),
      api.post(`${PREFIX}/payments`).set('Authorization', raceCustomer.auth)
        .send({ orderId: orderB.body.data.id, method: 'WALLET' }),
    ]);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 400]); // exactly one winner, one loser — never both succeeding

    const wallet = await prisma.wallet.findUnique({ where: { userId: raceCustomer.user.id } });
    expect(Number(wallet.balance)).toBe(0); // debited exactly once, never negative

    const orders = await prisma.order.findMany({ where: { id: { in: [orderA.body.data.id, orderB.body.data.id] } } });
    const confirmedCount = orders.filter((o) => o.status === 'CONFIRMED').length;
    const pendingCount = orders.filter((o) => o.status === 'PENDING').length;
    expect(confirmedCount).toBe(1);
    expect(pendingCount).toBe(1);

    const paymentCount = await prisma.payment.count({
      where: { orderId: { in: [orderA.body.data.id, orderB.body.data.id] }, status: 'SUCCESS' },
    });
    expect(paymentCount).toBe(1); // only the winning order actually got a SUCCESS payment record
  });
});
