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
 *     full or partial, per-item, at Serializable isolation. The original
 *     OrderItemSettlement snapshot is only ever read, never mutated;
 *     commission reversal is bookkeeping-only (OrderItemSettlementReversal
 *     row), never a wallet movement. The customer-side refund always
 *     completes: if a seller's wallet can't fully cover its clawback
 *     (e.g. already withdrawn via a payout — see payouts.test.js), the
 *     shortfall is collected down to zero and the uncollected remainder is
 *     tracked as a SellerPayoutLiability instead of blocking the refund.
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

  test('WALLET cancellation credits the customer wallet back and marks the Payment REFUNDED', async () => {
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payWallet(customer.auth, order.id);

    const walletAfterPay = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(walletAfterPay.balance)).toBe(Number(walletBefore.balance) - Number(payment.amount));

    const cancelled = await cancelOrder(order.id, admin.auth);
    expect(cancelled.status).toBe(200);

    const walletAfterCancel = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(walletAfterCancel.balance)).toBe(Number(walletBefore.balance)); // fully back to where it started

    const paymentAfter = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe('REFUNDED');

    const refund = await prisma.paymentRefund.findFirst({ where: { paymentId: payment.id } });
    expect(refund.status).toBe('PROCESSED');
    expect(Number(refund.amount)).toBe(Number(payment.amount));
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
    expect(Number(refund.amount)).toBe(Number(payment.amount));
  });

  test('a retried refundWallet call with the same idempotencyKey is a no-op, not a double credit', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payWallet(customer.auth, order.id);
    const walletAfterPay = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });

    const idempotencyKey = `test-idem-${payment.id}`;
    const first = await paymentsService.refundWallet(payment.id, Number(payment.amount), idempotencyKey, admin.user, 'PRE_DELIVERY_CANCELLATION');
    const second = await paymentsService.refundWallet(payment.id, Number(payment.amount), idempotencyKey, admin.user, 'PRE_DELIVERY_CANCELLATION');
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
      paymentsService.refundWallet(payment.id, Number(payment.amount), `another-key-${payment.id}`, admin.user, 'PRE_DELIVERY_CANCELLATION'),
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
    await prisma.wallet.create({ data: { userId: seller.user.id } });
    await prisma.wallet.create({ data: { userId: seller2.user.id } });
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
      where: { walletId: sellerWalletAfter.id, type: 'DEBIT', reason: { contains: order.orderNumber } },
    });
    expect(sellerTxs.length).toBe(1); // exactly one DEBIT for this refund — none for platform commission
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

  test('insufficient seller balance no longer blocks the refund: the customer is still made whole, the wallet is drained to zero (never negative), and the uncollected remainder becomes an OUTSTANDING SellerPayoutLiability', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });

    // Drain the seller's wallet so it can't cover the clawback.
    await prisma.wallet.update({ where: { userId: seller.user.id }, data: { balance: 0 } });
    const customerWalletBefore = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });

    const res = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(res.status).toBe(200); // the customer refund succeeds despite the seller shortfall

    const sellerWallet = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(sellerWallet.balance)).toBe(0); // drained to zero, never negative

    const customerWalletAfter = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(customerWalletAfter.balance)).toBe(Number(customerWalletBefore.balance) + Number(settlement.grossAmount)); // customer made whole

    const reversal = await prisma.orderItemSettlementReversal.findFirst({ where: { settlementId: settlement.id } });
    expect(reversal).not.toBeNull(); // the refund itself still recorded normally

    const liability = await prisma.sellerPayoutLiability.findFirst({ where: { orderId: order.id, sellerId: seller.user.id } });
    expect(liability).not.toBeNull();
    expect(liability.status).toBe('OUTSTANDING');
    expect(Number(liability.amount)).toBe(Number(settlement.sellerEarning)); // the whole clawback was uncollected (wallet started at 0)

    // No WalletTransaction DEBIT was recorded for this refund — nothing was actually collectible.
    const debit = await prisma.walletTransaction.findFirst({
      where: { walletId: sellerWallet.id, refId: item.storeId, reason: { contains: order.orderNumber } },
    });
    expect(debit).toBeNull();
  });

  test('a partial shortfall collects what the wallet has, debits exactly that, and records only the remainder as a liability', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });
    const clawback = Number(settlement.sellerEarning);
    const partialBalance = Math.floor(clawback / 3); // leave the wallet able to cover only part of the clawback

    await prisma.wallet.update({ where: { userId: seller.user.id }, data: { balance: partialBalance } });
    const customerWalletBefore = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });

    const res = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(res.status).toBe(200);

    const sellerWallet = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(sellerWallet.balance)).toBe(0); // fully drained, never negative

    const customerWalletAfter = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(customerWalletAfter.balance)).toBe(Number(customerWalletBefore.balance) + Number(settlement.grossAmount));

    const debit = await prisma.walletTransaction.findFirst({
      where: { walletId: sellerWallet.id, refId: item.storeId, reason: { contains: order.orderNumber } },
    });
    expect(debit).not.toBeNull();
    expect(Number(debit.amount)).toBe(partialBalance); // collected exactly what was available

    const liability = await prisma.sellerPayoutLiability.findFirst({ where: { orderId: order.id, sellerId: seller.user.id } });
    expect(liability).not.toBeNull();
    expect(Number(liability.amount)).toBe(clawback - partialBalance); // exactly the uncollected remainder
  });

  test('retrying the same over-refund is rejected by the existing quantity guard, so a shortfall refund is never double-applied', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];

    await prisma.wallet.update({ where: { userId: seller.user.id }, data: { balance: 0 } });

    const first = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(first.status).toBe(200);

    // Same item, already fully refunded — the pre-existing over-refund guard rejects it, same as before this fix.
    const retry = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(retry.status).toBe(409);

    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });
    const reversals = await prisma.orderItemSettlementReversal.findMany({ where: { settlementId: settlement.id } });
    expect(reversals.length).toBe(1); // exactly one refund effect, never two

    const liabilities = await prisma.sellerPayoutLiability.findMany({ where: { orderId: order.id, sellerId: seller.user.id } });
    expect(liabilities.length).toBe(1); // exactly one liability row, never duplicated
  });

  test('seller withdraws their full settlement via a payout, then a later refund on the same order still succeeds and the shortfall is tracked', async () => {
    // Isolated seller/store/product fixture — `seller` is shared across every
    // other test in this describe block and, by the time this test runs, may
    // already carry an OUTSTANDING SellerPayoutLiability from an earlier
    // shortfall test. recoverSellerLiabilities correctly consumes a seller's
    // NEXT settlement against any such liability before crediting their
    // wallet (see orders.service.js#settleDeliveredOrder) — so reusing the
    // shared `seller` here would non-deterministically zero out the wallet
    // this test expects to withdraw from. A dedicated seller with no
    // liability history keeps this test about the payout/refund interaction
    // it's actually named for.
    const withdrawSeller = await makeUser('SELLER', '54150000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: withdrawSeller.user.id } });
    await makeApprovedStore(withdrawSeller.user.id, 'فروشگاه استرداد برداشت');
    const withdrawProduct = await makeApprovedProduct(withdrawSeller.auth, admin.auth, category.id, { price: 100000, stock: 100 });

    const withdrawOrder = await addToCartAndCheckout(customer.auth, [{ storeProduct: withdrawProduct, qty: 1 }]);
    await payWallet(customer.auth, withdrawOrder.id);
    await advanceToDelivered(withdrawOrder.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: withdrawOrder.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });

    // Seller withdraws exactly what this order settled — a legitimate Phase 5 payout.
    const sellerWalletBeforePayout = await prisma.wallet.findUnique({ where: { userId: withdrawSeller.user.id } });
    const payout = await api.post(`${PREFIX}/payouts`).set('Authorization', withdrawSeller.auth).send({
      amount: Number(sellerWalletBeforePayout.balance),
      bankAccountHolder: 'علی رضایی',
      bankIban: 'IR820540102680020817909002',
    });
    expect(payout.status).toBe(201);
    const sellerWalletAfterPayout = await prisma.wallet.findUnique({ where: { userId: withdrawSeller.user.id } });
    expect(Number(sellerWalletAfterPayout.balance)).toBe(0);

    const customerWalletBefore = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    const refundRes = await api.post(`${PREFIX}/orders/${withdrawOrder.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(refundRes.status).toBe(200); // customer refund succeeds even though the seller already withdrew the money

    const customerWalletAfter = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(Number(customerWalletAfter.balance)).toBe(Number(customerWalletBefore.balance) + Number(settlement.grossAmount));

    const sellerWalletFinal = await prisma.wallet.findUnique({ where: { userId: withdrawSeller.user.id } });
    expect(Number(sellerWalletFinal.balance)).toBe(0); // never went negative

    const liability = await prisma.sellerPayoutLiability.findFirst({ where: { orderId: withdrawOrder.id, sellerId: withdrawSeller.user.id } });
    expect(liability).not.toBeNull();
    expect(liability.status).toBe('OUTSTANDING');
    expect(Number(liability.amount)).toBe(Number(settlement.sellerEarning));
  });

  test('in a multi-seller refund, one seller\'s shortfall never affects the OTHER seller\'s normal debit', async () => {
    // Isolated seller/store/product fixture for the "seller1" role — `seller`
    // is shared across every other test in this describe block and, by the
    // time this test runs, may already carry an OUTSTANDING
    // SellerPayoutLiability from an earlier shortfall test.
    // recoverSellerLiabilities correctly consumes a seller's NEXT settlement
    // against any such liability before crediting their wallet (see
    // orders.service.js#settleDeliveredOrder) — so reusing the shared
    // `seller` here would non-deterministically zero out the wallet this
    // test expects to see debited normally, even though this test never
    // touches that liability itself. A dedicated seller with no liability
    // history keeps this test about the multi-seller shortfall isolation
    // it's actually named for (mirrors the `withdrawSeller` isolation used
    // a few tests down for the same reason).
    const sellerA = await makeUser('SELLER', '54140000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: sellerA.user.id } });
    await makeApprovedStore(sellerA.user.id, 'فروشگاه استرداد چندفروشنده');
    const productA = await makeApprovedProduct(sellerA.auth, admin.auth, category.id, { price: 100000, stock: 100 });

    const order = await addToCartAndCheckout(customer.auth, [
      { storeProduct: productA, qty: 1 },
      { storeProduct: product2, qty: 1 },
    ]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item1 = orderWithItems.items.find((i) => i.storeId === productA.storeId);
    const item2 = orderWithItems.items.find((i) => i.storeId === product2.storeId);
    const settlement1 = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item1.id } });

    const seller1WalletBefore = await prisma.wallet.findUnique({ where: { userId: sellerA.user.id } });
    // seller1 can afford it; seller2 cannot.
    await prisma.wallet.update({ where: { userId: seller2.user.id }, data: { balance: 0 } });

    const res = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item1.id, qty: 1 }, { orderItemId: item2.id, qty: 1 }] });
    expect(res.status).toBe(200); // the whole refund succeeds — seller2's shortfall no longer blocks seller1's normal debit

    const seller1WalletAfter = await prisma.wallet.findUnique({ where: { userId: sellerA.user.id } });
    expect(Number(seller1WalletAfter.balance)).toBe(Number(seller1WalletBefore.balance) - Number(settlement1.sellerEarning)); // seller1 debited normally, in full

    const seller2Wallet = await prisma.wallet.findUnique({ where: { userId: seller2.user.id } });
    expect(Number(seller2Wallet.balance)).toBe(0); // seller2 drained, never negative

    const liability1 = await prisma.sellerPayoutLiability.findFirst({ where: { orderId: order.id, sellerId: sellerA.user.id } });
    expect(liability1).toBeNull(); // seller1 had no shortfall

    const liability2 = await prisma.sellerPayoutLiability.findFirst({ where: { orderId: order.id, sellerId: seller2.user.id } });
    expect(liability2).not.toBeNull(); // seller2's uncollected clawback is tracked
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

/**
 * P2.4 — Ledger integration around Payment / PaymentRefund.
 *
 * Exercises the Ledger side effects layered on top of Phase 4's refund/
 * cancellation flows above: PAYMENT_CONFIRMED (WALLET variant) on payment,
 * PAYMENT_REVERSED on pre-delivery cancellation (immediate for WALLET,
 * deferred to markGatewayRefundProcessed for GATEWAY), and REFUND on a
 * delivered-order refund (immediate for WALLET when the seller clawback
 * fully succeeds, deferred to markGatewayRefundProcessed for GATEWAY —
 * and, either way, never fabricated when the clawback left a
 * SellerPayoutLiability shortfall). See payments.service.js#refundWallet/
 * refundGateway/markGatewayRefundProcessed and orders.service.js#
 * updateStatus/refundDeliveredOrder for the implementation this exercises.
 */
describe('P2.4 — Ledger integration', () => {
  let customer;
  let seller;
  let admin;
  let category;
  let product;

  async function findJournal(eventType, eventId) {
    return prisma.journal.findUnique({ where: { eventType_eventId: { eventType, eventId } } });
  }

  async function entriesFor(journalId) {
    return prisma.ledgerEntry.findMany({ where: { journalId }, include: { account: true } });
  }

  beforeAll(async () => {
    customer = await makeUser('CUSTOMER', '54200000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: customer.user.id, balance: 100000000 } });
    seller = await makeUser('SELLER', '54210000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: seller.user.id } });
    admin = await makeUser('ADMIN', '54220000' + Math.floor(Math.random() * 9));
    await makeApprovedStore(seller.user.id, 'فروشگاه لجر تست');
    const cat = await api.post(`${PREFIX}/categories`).set('Authorization', admin.auth)
      .send({ name: 'دسته لجر تست', slug: `ledger-integration-cat-${Date.now()}` });
    category = cat.body.data;
    product = await makeApprovedProduct(seller.auth, admin.auth, category.id, { price: 100000, stock: 100 });

    // A GLOBAL CommissionRule is required for settlement on DELIVERED — same
    // requirement as the "Delivered-order refund" describe block above.
    const existingGlobal = await prisma.commissionRule.findFirst({ where: { scope: 'GLOBAL' } });
    if (!existingGlobal) {
      const rule = await api.post(`${PREFIX}/admin/commission-rules`).set('Authorization', admin.auth)
        .send({ scope: 'GLOBAL', rate: 10 });
      expect(rule.status).toBe(201);
    }
  });

  test('A) WALLET payment posts a PAYMENT_CONFIRMED Journal (CUSTOMER_WALLET debit / PLATFORM_CASH credit) and a retried payment attempt does not duplicate it', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payWallet(customer.auth, order.id);

    const journal = await findJournal('PAYMENT_CONFIRMED', payment.id);
    expect(journal).not.toBeNull();

    const entries = await entriesFor(journal.id);
    expect(entries).toHaveLength(2);
    const debit = entries.find((e) => e.direction === 'DEBIT');
    const credit = entries.find((e) => e.direction === 'CREDIT');
    expect(debit.account.ownerType).toBe('CUSTOMER_WALLET');
    expect(debit.account.ownerId).toBe(customer.user.id);
    expect(credit.account.ownerType).toBe('PLATFORM_CASH');
    expect(Number(debit.amount)).toBe(Number(payment.amount));
    expect(Number(credit.amount)).toBe(Number(payment.amount));

    // Retried payment attempt: the order is no longer PENDING, so this is
    // rejected before payWithWallet (and therefore postWalletPaymentConfirmed)
    // ever runs again — the existing Journal must be untouched.
    const retry = await api.post(`${PREFIX}/payments`).set('Authorization', customer.auth).send({ orderId: order.id, method: 'WALLET' });
    expect(retry.status).toBe(409);

    const journalsAfter = await prisma.journal.findMany({ where: { eventType: 'PAYMENT_CONFIRMED', eventId: payment.id } });
    expect(journalsAfter).toHaveLength(1);
  });

  test('B) WALLET pre-delivery cancellation: origin is PRE_DELIVERY_CANCELLATION and a PAYMENT_REVERSED Journal is posted immediately', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payWallet(customer.auth, order.id);

    const cancelled = await cancelOrder(order.id, admin.auth);
    expect(cancelled.status).toBe(200);

    const refund = await prisma.paymentRefund.findFirst({ where: { paymentId: payment.id } });
    expect(refund.origin).toBe('PRE_DELIVERY_CANCELLATION');

    const journal = await findJournal('PAYMENT_REVERSED', payment.id);
    expect(journal).not.toBeNull();

    const entries = await entriesFor(journal.id);
    expect(entries).toHaveLength(2);
    const debit = entries.find((e) => e.direction === 'DEBIT');
    const credit = entries.find((e) => e.direction === 'CREDIT');
    expect(debit.account.ownerType).toBe('PLATFORM_CASH');
    expect(credit.account.ownerType).toBe('CUSTOMER_WALLET');
    expect(credit.account.ownerId).toBe(customer.user.id);
    expect(Number(credit.amount)).toBe(Number(payment.amount));
  });

  test('C) GATEWAY pre-delivery cancellation: the PAYMENT_REVERSED Journal is deferred until markGatewayRefundProcessed confirms it', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payGatewayAndConfirm(customer.auth, order.id);

    const cancelled = await cancelOrder(order.id, admin.auth);
    expect(cancelled.status).toBe(200);

    const refund = await prisma.paymentRefund.findFirst({ where: { paymentId: payment.id } });
    expect(refund.status).toBe('REQUESTED');
    expect(refund.origin).toBe('PRE_DELIVERY_CANCELLATION');

    const journalBefore = await findJournal('PAYMENT_REVERSED', payment.id);
    expect(journalBefore).toBeNull(); // not posted yet — no real gateway reversal has been confirmed

    const confirmed = await api.patch(`${PREFIX}/admin/payment-refunds/${refund.id}/mark-processed`).set('Authorization', admin.auth);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('PROCESSED');

    const journalAfter = await findJournal('PAYMENT_REVERSED', payment.id);
    expect(journalAfter).not.toBeNull();
    const entries = await entriesFor(journalAfter.id);
    const debit = entries.find((e) => e.direction === 'DEBIT');
    const credit = entries.find((e) => e.direction === 'CREDIT');
    expect(debit.account.ownerType).toBe('PLATFORM_CASH');
    expect(credit.account.ownerType).toBe('PAYMENT_GATEWAY_CLEARING');
  });

  test('D) delivered WALLET refund with no shortfall: origin/ledgerStatus persisted and a REFUND Journal is posted immediately with correct legs', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });

    const refundRes = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(refundRes.status).toBe(200);

    const refund = await prisma.paymentRefund.findUnique({ where: { id: refundRes.body.data.refund.id } });
    expect(refund.origin).toBe('POST_DELIVERY_REFUND');
    expect(refund.ledgerStatus).toBe('POSTED'); // WALLET + no shortfall posts immediately

    const journal = await findJournal('REFUND', refund.id);
    expect(journal).not.toBeNull();
    const entries = await entriesFor(journal.id);
    const customerLeg = entries.find((e) => e.account.ownerType === 'CUSTOMER_WALLET');
    const sellerLeg = entries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    const revenueLeg = entries.find((e) => e.account.ownerType === 'PLATFORM_REVENUE');
    expect(customerLeg.direction).toBe('CREDIT');
    expect(customerLeg.account.ownerId).toBe(customer.user.id);
    expect(Number(customerLeg.amount)).toBe(Number(settlement.grossAmount));
    expect(sellerLeg.direction).toBe('DEBIT');
    expect(sellerLeg.account.ownerId).toBe(seller.user.id);
    expect(Number(sellerLeg.amount)).toBe(Number(settlement.sellerEarning));
    expect(revenueLeg.direction).toBe('DEBIT');
    expect(Number(revenueLeg.amount)).toBe(Number(settlement.commissionAmount));
  });

  test('E) delivered WALLET refund with a shortfall: ledgerStatus is POSTED, the liability links to its exact PLATFORM_RECEIVABLE LedgerEntry, and the REFUND Journal balances (P2.9 — Model C)', async () => {
    // Dedicated seller/store/product fixture for this test only. `seller` is
    // shared across every other test in this describe block (A, B, C, D, F,
    // G, H) — forcing a shortfall on it here would leave a lingering
    // OUTSTANDING SellerPayoutLiability that recoverSellerLiabilities would
    // then silently consume out of that seller's NEXT settlement (see
    // orders.service.js#settleDeliveredOrder), corrupting whichever later
    // test happens to run next (e.g. test F, which expects a clean
    // ledgerStatus = POSTABLE with no pre-existing liability in play). A
    // seller isolated to this test keeps the shortfall — and the liability
    // it creates — from ever touching the shared seller.
    const sellerE = await makeUser('SELLER', '54230000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: sellerE.user.id } });
    await makeApprovedStore(sellerE.user.id, 'فروشگاه لجر تست E');
    const productE = await makeApprovedProduct(sellerE.auth, admin.auth, category.id, { price: 100000, stock: 100 });

    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: productE, qty: 1 }]);
    await payWallet(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });

    await prisma.wallet.update({ where: { userId: sellerE.user.id }, data: { balance: 0 } }); // force a full shortfall

    const refundRes = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(refundRes.status).toBe(200);

    const refund = await prisma.paymentRefund.findUnique({ where: { id: refundRes.body.data.refund.id } });
    expect(refund.origin).toBe('POST_DELIVERY_REFUND');
    // P2.9 — the anyShortfall gate is removed: a WALLET refund's REFUND
    // Journal now posts unconditionally, including on a full shortfall.
    expect(refund.ledgerStatus).toBe('POSTED');

    const liability = await prisma.sellerPayoutLiability.findFirst({ where: { orderId: order.id, sellerId: sellerE.user.id, refundId: refund.id } });
    expect(liability).not.toBeNull();
    expect(liability.refundId).toBe(refund.id);
    // originalAmount is immutable and set at creation; amount here is the
    // still-outstanding remainder (no recovery has happened yet, so equal).
    expect(Number(liability.originalAmount)).toBe(Number(settlement.sellerEarning));
    expect(Number(liability.amount)).toBe(Number(settlement.sellerEarning));
    expect(liability.ledgerReceivableEntryId).not.toBeNull();

    const journal = await findJournal('REFUND', refund.id);
    expect(journal).not.toBeNull(); // P2.9 — no longer suppressed by the shortfall

    const entries = await entriesFor(journal.id);
    const customerLeg = entries.find((e) => e.account.ownerType === 'CUSTOMER_WALLET');
    const sellerLeg = entries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    const revenueLeg = entries.find((e) => e.account.ownerType === 'PLATFORM_REVENUE');
    const receivableLeg = entries.find((e) => e.account.ownerType === 'PLATFORM_RECEIVABLE');

    expect(customerLeg.direction).toBe('CREDIT');
    expect(Number(customerLeg.amount)).toBe(Number(settlement.grossAmount));
    // Full shortfall (wallet balance forced to 0) — no SELLER_WALLET leg at all.
    expect(sellerLeg).toBeUndefined();
    expect(revenueLeg.direction).toBe('DEBIT');
    expect(Number(revenueLeg.amount)).toBe(Number(settlement.commissionAmount));
    expect(receivableLeg.direction).toBe('DEBIT');
    expect(Number(receivableLeg.amount)).toBe(Number(settlement.sellerEarning));
    expect(receivableLeg.id).toBe(liability.ledgerReceivableEntryId);

    // Balanced: CREDIT total === DEBIT total.
    const creditTotal = entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + Number(e.amount), 0);
    const debitTotal = entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + Number(e.amount), 0);
    expect(debitTotal).toBe(creditTotal);
  });

  test('F) delivered GATEWAY refund with no shortfall: the REFUND Journal is deferred until markGatewayRefundProcessed confirms it', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payGatewayAndConfirm(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });

    const refundRes = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(refundRes.status).toBe(200);
    const refundId = refundRes.body.data.refund.id;

    const refundBefore = await prisma.paymentRefund.findUnique({ where: { id: refundId } });
    expect(refundBefore.origin).toBe('POST_DELIVERY_REFUND');
    expect(refundBefore.ledgerStatus).toBe('POSTABLE');
    expect(refundBefore.status).toBe('REQUESTED');

    const journalBefore = await findJournal('REFUND', refundId);
    expect(journalBefore).toBeNull();

    const confirmed = await api.patch(`${PREFIX}/admin/payment-refunds/${refundId}/mark-processed`).set('Authorization', admin.auth);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('PROCESSED');

    const refundAfter = await prisma.paymentRefund.findUnique({ where: { id: refundId } });
    expect(refundAfter.ledgerStatus).toBe('POSTED');

    const journalAfter = await findJournal('REFUND', refundId);
    expect(journalAfter).not.toBeNull();
    const entries = await entriesFor(journalAfter.id);
    const sellerLeg = entries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    expect(Number(sellerLeg.amount)).toBe(Number(settlement.sellerEarning));
  });

  test('G) delivered GATEWAY refund with a shortfall: REFUND Journal is posted at markGatewayRefundProcessed confirmation, reconstructed from originalAmount, with a PLATFORM_RECEIVABLE leg (P2.9 — Model C)', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    await payGatewayAndConfirm(customer.auth, order.id);
    await advanceToDelivered(order.id, admin.auth);
    const orderWithItems = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    const item = orderWithItems.items[0];
    const settlement = await prisma.orderItemSettlement.findUnique({ where: { orderItemId: item.id } });

    await prisma.wallet.update({ where: { userId: seller.user.id }, data: { balance: 0 } }); // force a full shortfall

    const refundRes = await api.post(`${PREFIX}/orders/${order.id}/refund`).set('Authorization', admin.auth)
      .send({ items: [{ orderItemId: item.id, qty: 1 }] });
    expect(refundRes.status).toBe(200);
    const refundId = refundRes.body.data.refund.id;

    const refundBefore = await prisma.paymentRefund.findUnique({ where: { id: refundId } });
    expect(refundBefore.origin).toBe('POST_DELIVERY_REFUND');
    expect(refundBefore.ledgerStatus).toBe('SHORTFALL_HELD');

    const liabilityBefore = await prisma.sellerPayoutLiability.findFirst({ where: { orderId: order.id, sellerId: seller.user.id, refundId } });
    expect(liabilityBefore).not.toBeNull();
    expect(Number(liabilityBefore.originalAmount)).toBe(Number(settlement.sellerEarning));
    expect(liabilityBefore.ledgerReceivableEntryId).toBeNull(); // not yet posted — GATEWAY defers Ledger posting

    // Journal must not exist before gateway confirmation, GATEWAY posting is
    // deferred either way (unchanged by P2.9 — see markGatewayRefundProcessed).
    const journalBefore = await findJournal('REFUND', refundId);
    expect(journalBefore).toBeNull();

    const confirmed = await api.patch(`${PREFIX}/admin/payment-refunds/${refundId}/mark-processed`).set('Authorization', admin.auth);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('PROCESSED');

    const refundAfter = await prisma.paymentRefund.findUnique({ where: { id: refundId } });
    // P2.9 — Case A/B are merged: shortfall no longer blocks posting.
    expect(refundAfter.ledgerStatus).toBe('POSTED');

    const journal = await findJournal('REFUND', refundId);
    expect(journal).not.toBeNull();

    const entries = await entriesFor(journal.id);
    const sellerLeg = entries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    const receivableLeg = entries.find((e) => e.account.ownerType === 'PLATFORM_RECEIVABLE');
    expect(sellerLeg).toBeUndefined(); // full shortfall — nothing was collectible
    expect(receivableLeg).not.toBeUndefined();
    expect(Number(receivableLeg.amount)).toBe(Number(settlement.sellerEarning));

    const liabilityAfter = await prisma.sellerPayoutLiability.findUnique({ where: { id: liabilityBefore.id } });
    expect(liabilityAfter.ledgerReceivableEntryId).toBe(receivableLeg.id);
  });

  test('H) a legacy PaymentRefund (origin/ledgerStatus NULL) still processes money movement via markGatewayRefundProcessed without any inferred Ledger posting', async () => {
    const order = await addToCartAndCheckout(customer.auth, [{ storeProduct: product, qty: 1 }]);
    const payment = await payGatewayAndConfirm(customer.auth, order.id);

    // Bypass refundGateway (which now enforces a required origin) to
    // simulate a row created before the P2.4 origin/ledgerStatus columns
    // existed — exactly the case markGatewayRefundProcessed's Case D exists
    // for.
    const legacyRefund = await prisma.paymentRefund.create({
      data: {
        paymentId: payment.id,
        orderId: order.id,
        amount: payment.amount,
        status: 'REQUESTED',
        reason: 'استرداد قدیمی بدون origin',
        idempotencyKey: `legacy-${payment.id}`,
        requestedById: admin.user.id,
        // origin / ledgerStatus deliberately omitted — NULL, as a real
        // pre-P2.4 row would be.
      },
    });
    expect(legacyRefund.origin).toBeNull();
    expect(legacyRefund.ledgerStatus).toBeNull();

    const confirmed = await api.patch(`${PREFIX}/admin/payment-refunds/${legacyRefund.id}/mark-processed`).set('Authorization', admin.auth);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('PROCESSED'); // money-movement transition still applies

    const paymentAfter = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe('REFUNDED'); // fully covered by this one legacy refund

    // No Ledger journal was guessed for it, under either eventType it could
    // conceivably have been (PAYMENT_REVERSED keyed by Payment.id, or REFUND
    // keyed by PaymentRefund.id) — origin was never inferred from settlement
    // existence, and no shortfall was inferred from current Wallet.balance.
    const reversedJournal = await findJournal('PAYMENT_REVERSED', payment.id);
    const refundJournal = await findJournal('REFUND', legacyRefund.id);
    expect(reversedJournal).toBeNull();
    expect(refundJournal).toBeNull();

    const refundAfter = await prisma.paymentRefund.findUnique({ where: { id: legacyRefund.id } });
    expect(refundAfter.origin).toBeNull();
    expect(refundAfter.ledgerStatus).toBeNull(); // left untouched, not guessed
  });
});
