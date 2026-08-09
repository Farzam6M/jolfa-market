/**
 * Test suite for Phase 4: Refund / Cancellation.
 *
 * Covers two distinct refund paths, both layered on top of Phase 2/3's
 * settlement machinery without touching it:
 *
 *  A) Pre-delivery cancellation (orders.service.js#updateStatus, CANCELLED
 *     branch) — reverses whatever payment actually succeeded:
 *       - COD is never SUCCESS before delivery, so cancelling it produces
 *         no refund at all.
 *       - WALLET is refunded immediately (money lives entirely in-app) and
 *         the Payment flips to REFUNDED once fully covered.
 *       - GATEWAY only gets a REQUESTED PaymentRefund — no outbound gateway
 *         call exists — confirmed later by an admin via
 *         PATCH /admin/payment-refunds/:id/mark-processed.
 *     Idempotency (retried cancel) and "already refunded" rejection are
 *     both enforced by payments.service.js#refundWallet/refundGateway's
 *     own idempotencyKey guard, exercised here directly.
 *
 *  B) Delivered-order refund (orders.service.js#refundDeliveredOrder) —
 *     full or partial, per-item, all-or-nothing across every affected
 *     seller's wallet, at Serializable isolation. The original
 *     OrderItemSettlement snapshot is only ever read, never mutated;
 *     commission reversal is bookkeeping-only (OrderItemSettlementReversal
 *     row), never a wallet movement.
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
const paymentsService = require('../src/modules/payments/payments.service');

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
    name: 'محصول استرداد تست', categoryId, price: 20000, stock: 10, ...overrides,
  });
  const id = created.body.data.id;
  await api.patch(`${PREFIX}/products/${id}/moderate`).set('Authorization', adminAuth).send({ status: 'APPROVED' });
  return prisma.storeProduct.findUnique({ where: { id } });
}

/** items: [{ storeProduct, qty }, ...] — supports multi-seller carts. Leaves the order PENDING (unpaid). */
async function addToCartAndCheckout(customerAuth, items) {
  // eslint-disable-next-line no-restricted-syntax
  for (const it of items) {
    // eslint-disable-next-line no-await-in-loop
    await api.post(`${PREFIX}/cart/items`).set('Authorization', customerAuth).send({ productId: it.storeProduct.id, qty: it.qty });
  }
  const order = await api.post(`${PREFIX}/orders/checkout`).set('Authorization', customerAuth).send({});
  return order.body.data;
}

async function payWallet(customerAuth, orderId) {
  const res = await api.post(`${PREFIX}/payments`).set('Authorization', customerAuth).send({ orderId, method: 'WALLET' });
  return res.body.data;
}

async function payCOD(customerAuth, orderId) {
  const res = await api.post(`${PREFIX}/payments`).set('Authorization', customerAuth).send({ orderId, method: 'CASH_ON_DELIVERY' });
  return res.body.data;
}

/** Pays via GATEWAY and immediately delivers a successful signed callback, leaving the order CONFIRMED and the Payment SUCCESS. */
async function payGatewayAndConfirm(customerAuth, orderId) {
  const res = await api.post(`${PREFIX}/payments`).set('Authorization', customerAuth).send({ orderId, method: 'GATEWAY' });
  const body = { transactionRef: res.body.data.transactionRef, success: true };
  const { signature } = signGatewayPayload(body);
  await api.post(`${PREFIX}/payments/gateway/callback`).set('x-gateway-signature', signature).send(body);
  return res.body.data;
}

async function cancelOrder(orderId, adminAuth) {
  return api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'CANCELLED' });
}

/** Order is already CONFIRMED (post-payment) — drives it the rest of the way to DELIVERED, triggering settlement. */
async function advanceToDelivered(orderId, adminAuth) {
  await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'PREPARING' });
  await api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'SENT' });
  return api.patch(`${PREFIX}/orders/${orderId}/status`).set('Authorization', adminAuth).send({ status: 'DELIVERED' });
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

describe('Pre-delivery cancellation refunds', () => {
  let customer;
  let seller;
  let admin;
  let category;
  let product;

  beforeAll(async () => {
    customer = await makeUser('CUSTOMER', '54000000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: customer.user.id, balance: 100000000 } });
    seller = await makeUser('SELLER', '54010000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '54020000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه لغو تست');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته لغو تست', slug: `cancel-refund-cat-${Date.now()}` });
    category = cat.body.data;
    product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 100000, stock: 100 });
  });

  test('COD cancellation produces no refund — COD is never SUCCESS before delivery', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payCOD(customer.auth, order.id);

    const cancelled = await cancelOrder(order.id, admin.auth);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const refunds = await prisma.paymentRefund.findMany({ where: { orderId: order.id } });
    expect(refunds.length).toBe(0);

    const payment = await prisma.payment.findFirst({ where: { orderId: order.id } });
    expect(payment.status).toBe('PENDING'); // untouched — nothing was ever charged
  });

  test('WALLET cancellation credits the customer wallet back and marks the Payment REFUNDED', async () => {
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payWallet(customer.auth, order.id);

    const walletAfterPay = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(walletAfterPay.balance)).toBe(Number(walletBefore.balance) - 100000);

    const cancelled = await cancelOrder(order.id, admin.auth);
    expect(cancelled.status).toBe(200);

    const walletAfterCancel = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(walletAfterCancel.balance)).toBe(Number(walletBefore.balance)); // fully back to where it started

    const paymentAfter = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe('REFUNDED');

    const refund = await prisma.paymentRefund.findFirst({ where: { paymentId: payment.id } });
    expect(refund.status).toBe('PROCESSED');
    expect(Number(refund.amount)).toBe(100000);
  });

  test('GATEWAY cancellation records a REQUESTED PaymentRefund and credits no wallet', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payGatewayAndConfirm(customer.auth, order.id);
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });

    const cancelled = await cancelOrder(order.id, admin.auth);
    expect(cancelled.status).toBe(200);

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance)); // GATEWAY never credits a wallet

    const paymentAfter = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe('SUCCESS'); // stays SUCCESS — only REFUNDED once an admin confirms

    const refund = await prisma.paymentRefund.findFirst({ where: { paymentId: payment.id } });
    expect(refund.status).toBe('REQUESTED');
    expect(Number(refund.amount)).toBe(100000);
  });

  test('a retried refundWallet call with the same idempotencyKey is a no-op, not a double credit', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payWallet(customer.auth, order.id);
    const walletAfterPay = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });

    const idempotencyKey = `test-idem-${payment.id}`;
    const first = await paymentsService.refundWallet(payment.id, Number(payment.amount), idempotencyKey, admin.user);
    const second = await paymentsService.refundWallet(payment.id, Number(payment.amount), idempotencyKey, admin.user);
    expect(second.id).toBe(first.id); // the exact same row, not a new one

    const refunds = await prisma.paymentRefund.findMany({ where: { paymentId: payment.id } });
    expect(refunds.length).toBe(1);

    const walletAfterRefund = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(walletAfterRefund.balance)).toBe(Number(walletAfterPay.balance) + Number(payment.amount)); // credited exactly once
  });

  test('refunding an already-fully-refunded payment is rejected', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payWallet(customer.auth, order.id);
    const cancelled = await cancelOrder(order.id, admin.auth); // fully refunds and flips the Payment to REFUNDED
    expect(cancelled.status).toBe(200);

    const paymentAfter = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe('REFUNDED');

    await expect(
      paymentsService.refundWallet(payment.id, Number(payment.amount), `another-key-${payment.id}`, admin.user),
    ).rejects.toThrow();
  });

  test('PATCH /admin/payment-refunds/:id/mark-processed confirms a REQUESTED gateway refund and only then flips the Payment to REFUNDED', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payGatewayAndConfirm(customer.auth, order.id);
    await cancelOrder(order.id, admin.auth);

    const paymentBefore = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentBefore.status).toBe('SUCCESS'); // not yet REFUNDED — refund is only REQUESTED so far
    const refund = await prisma.paymentRefund.findFirst({ where: { paymentId: payment.id } });
    expect(refund.status).toBe('REQUESTED');

    const forbidden = await api.patch(`${PREFIX}/admin/payment-refunds/${refund.id}/mark-processed`).set('Authorization', customer.auth);
    expect(forbidden.status).toBe(403); // customer has no orders:refund permission

    const confirmed = await api.patch(`${PREFIX}/admin/payment-refunds/${refund.id}/mark-processed`).set('Authorization', admin.auth);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('PROCESSED');

    const paymentAfter = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe('REFUNDED'); // its only refund is now fully PROCESSED

    // Idempotent: a second confirmation is a graceful no-op, not a double-processed row.
    const again = await api.patch(`${PREFIX}/admin/payment-refunds/${refund.id}/mark-processed`).set('Authorization', admin.auth);
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('PROCESSED');
  });
});

describe('Delivered-order refund (settlement clawback)', () => {
  let customer;
  let seller;
  let seller2;
  let admin;
  let category;
  let product;
  let product2;

  beforeAll(async () => {
    customer = await makeUser('CUSTOMER', '54100000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: customer.user.id, balance: 100000000 } });
    seller = await makeUser('SELLER', '54110000' + Math.floor(Math.random() * 9));
    seller2 = await makeUser('SELLER', '54120000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '54130000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه استرداد ۱');
    const store2 = await makeApprovedStore(seller2.user.id, 'فروشگاه استرداد ۲');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته استرداد تست', slug: `delivered-refund-cat-${Date.now()}` });
    category = cat.body.data;
    product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 100000, stock: 100 });
    product2 = await makeApprovedProduct(seller2.auth, admin.auth, category.id, { price: 100000, stock: 100 });
    // Sanity — makeApprovedProduct returns the seller2 store's own product, not the other seller's store.
    expect(product2.storeId).toBe(store2.id);

    // No GLOBAL CommissionRule exists in a freshly seeded DB — settlement on
    // DELIVERED requires one to resolve against, same as order-settlement.test.js.
    const rule = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth)
      .send({ scope: 'GLOBAL', rate: 10 });
    expect(rule.status).toBe(201);
  });

  test('refunding a delivered order credits the customer and debits the seller wallet by exactly sellerEarning', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 2 }]);
    await payWallet(customer.auth, order.id);
    const delivered = await advanceToDelivered(order.id, admin.auth);
    expect(delivered.status).toBe(200);

    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });

    const customerWalletBefore = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    const sellerWalletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });

    const refundRes = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 2 }], reason: 'تست استرداد کامل' });
    expect(refundRes.status).toBe(200);

    const customerWalletAfter = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(customerWalletAfter.balance)).toBe(Number(customerWalletBefore.balance) + Number(settlement.grossAmount));

    const sellerWalletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(sellerWalletAfter.balance)).toBe(Number(sellerWalletBefore.balance) - Number(settlement.sellerEarning));

    const reversal = await prisma.orderItemSettlementReversal.findFirst({ where: { settlementId: settlement.id } });
    expect(reversal).not.toBeNull();
    expect(Number(reversal.refundedGrossAmount)).toBe(Number(settlement.grossAmount));
    expect(Number(reversal.refundedCommissionAmount)).toBe(Number(settlement.commissionAmount));
    expect(Number(reversal.refundedSellerEarning)).toBe(Number(settlement.sellerEarning));

    const payment = await prisma.payment.findFirst({ where: { orderId: order.id } });
    expect(payment.status).toBe('REFUNDED'); // fully covered by this one refund
  });

  test('the original OrderItemSettlement row is left untouched by a refund', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const before = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });

    const refundRes = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(refundRes.status).toBe(200);

    const after = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });
    expect(Number(after.grossAmount)).toBe(Number(before.grossAmount));
    expect(Number(after.commissionAmount)).toBe(Number(before.commissionAmount));
    expect(Number(after.sellerEarning)).toBe(Number(before.sellerEarning));
    expect(after.commissionRate.toString()).toBe(before.commissionRate.toString());
  });

  test('commission reversal is bookkeeping only — the seller wallet is debited by sellerEarning alone, never a separate commission movement', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });

    const sellerWalletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    const refundRes = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(refundRes.status).toBe(200);
    const sellerWalletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });

    expect(Number(sellerWalletBefore.balance) - Number(sellerWalletAfter.balance)).toBe(Number(settlement.sellerEarning));

    const sellerTxs = await prisma.walletTransaction.findMany({
      where: { walletId: sellerWalletAfter.id, reason: { contains: order.orderNumber } },
    });
    expect(sellerTxs.length).toBe(1); // exactly one movement for this refund — none for platform commission
    expect(sellerTxs[0].type).toBe('DEBIT');
    expect(Number(sellerTxs[0].amount)).toBe(Number(settlement.sellerEarning));
  });

  test('refunding one seller\'s item in a multi-seller order never touches the other seller\'s wallet or settlement', async () => {
    const order = await addToCartAndCheckout(customer.auth, [
      { storeProduct: product, qty: 1 },
      { storeProduct: product2, qty: 1 },
    ]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);

    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item1 = orderWithItems.items.find((i) => i.storeId === product.storeId);
    const item2 = orderWithItems.items.find((i) => i.storeId === product2.storeId);

    const settlement2Before = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item2.id } });
    const seller2WalletBefore = await prisma.wallet.findUnique({ where: { userId: seller2.user.id } });

    const refundRes = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item1.id, qty: 1 }] });
    expect(refundRes.status).toBe(200);

    const settlement2After = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item2.id } });
    expect(Number(settlement2After.sellerEarning)).toBe(Number(settlement2Before.sellerEarning));
    const reversal2 = await prisma.orderItemSettlementReversal.findFirst({ where: { settlementId: settlement2Before.id } });
    expect(reversal2).toBeNull(); // seller2's item was never touched by this refund

    const seller2WalletAfter = await prisma.wallet.findUnique({ where: { userId: seller2.user.id } });
    expect(Number(seller2WalletAfter.balance)).toBe(Number(seller2WalletBefore.balance));
  });

  test('a partial refund reverses only the requested quantity and leaves the rest refundable', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 3 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });
    const perUnitGross = Number(settlement.grossAmount) / 3;

    const customerWalletBefore = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    const firstRefund = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(firstRefund.status).toBe(200);

    const customerWalletAfter = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(customerWalletAfter.balance)).toBe(Number(customerWalletBefore.balance) + perUnitGross);

    // 2 units remain refundable — a second partial refund for the rest succeeds.
    const secondRefund = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 2 }] });
    expect(secondRefund.status).toBe(200);

    const reversals = await prisma.orderItemSettlementReversal.findMany({ where: { settlementId: settlement.id } });
    expect(reversals.length).toBe(2);
    expect(reversals.reduce((s, r) => s + r.refundedQty, 0)).toBe(3);
  });

  test('requesting a refund qty greater than what remains is rejected, with nothing partially applied', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 2 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];

    const over = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 3 }] });
    expect(over.status).toBe(409);

    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });
    const reversal = await prisma.orderItemSettlementReversal.findFirst({ where: { settlementId: settlement.id } });
    expect(reversal).toBeNull(); // rejected batch left nothing behind
  });

  test('insufficient seller balance rejects the refund and rolls back all money movement', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];

    // Drain the seller's wallet so it can't cover the clawback.
    await prisma.wallet.update({ where: { userId: seller.user.id }, data: { balance: 0 } });
    const customerWalletBefore = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });

    const res = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(res.status).toBe(409);

    const sellerWallet = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(sellerWallet.balance)).toBe(0); // untouched, never driven negative

    const customerWalletAfter = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(customerWalletAfter.balance)).toBe(Number(customerWalletBefore.balance)); // customer never credited either

    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });
    const reversal = await prisma.orderItemSettlementReversal.findFirst({ where: { settlementId: settlement.id } });
    expect(reversal).toBeNull();
  });

  test('in a multi-seller refund, one seller\'s insufficient balance rolls back the OTHER seller\'s already-applied debit too', async () => {
    const order = await addToCartAndCheckout(customer.auth, [
      { storeProduct: product, qty: 1 },
      { storeProduct: product2, qty: 1 },
    ]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item1 = orderWithItems.items.find((i) => i.storeId === product.storeId);
    const item2 = orderWithItems.items.find((i) => i.storeId === product2.storeId);

    const seller1WalletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    // seller1 can afford it; seller2 cannot.
    await prisma.wallet.update({ where: { userId: seller2.user.id }, data: { balance: 0 } });

    const res = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item1.id, qty: 1 }, { orderItemId: item2.id, qty: 1 }] });
    expect(res.status).toBe(409);

    const seller1WalletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(seller1WalletAfter.balance)).toBe(Number(seller1WalletBefore.balance)); // rolled back even though seller1 alone could have afforded it

    const settlement1 = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item1.id } });
    const reversal1 = await prisma.orderItemSettlementReversal.findFirst({ where: { settlementId: settlement1.id } });
    expect(reversal1).toBeNull(); // nothing left behind for either store
  });

  test('two concurrent refund requests for the same item: only one succeeds, never a double refund', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];

    const [first, second] = await Promise.all([
      api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth).send({ items: [{ orderItemId: item.id, qty: 1 }] }),
      api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth).send({ items: [{ orderItemId: item.id, qty: 1 }] }),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses[0]).toBe(200); // exactly one wins
    expect(statuses[1]).toBe(409); // the other loses the Serializable race and gets a clean 409

    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });
    const reversals = await prisma.orderItemSettlementReversal.findMany({ where: { settlementId: settlement.id } });
    expect(reversals.length).toBe(1); // exactly one refund landed, never two
  });
});
