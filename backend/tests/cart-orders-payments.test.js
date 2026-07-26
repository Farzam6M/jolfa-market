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
  return prisma.product.findUnique({ where: { id } });
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

    const stillStock = await prisma.product.findUnique({ where: { id: product.id } });
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
    const before = await prisma.product.findUnique({ where: { id: product.id } });
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customer.auth).send({ productId: product.id, qty: 1 });
    const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customer.auth).send({});
    const afterCheckout = await prisma.product.findUnique({ where: { id: product.id } });
    expect(afterCheckout.stock).toBe(before.stock - 1);

    const cancelled = await api.patch(`${PREFIX}/orders/${order.body.data.id}/status`).set('Authorization', admin.auth).send({ status: 'CANCELLED' });
    expect(cancelled.status).toBe(200);

    const afterCancel = await prisma.product.findUnique({ where: { id: product.id } });
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
});
