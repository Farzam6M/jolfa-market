/**
 * Access-control + real-time test suite for Support Chat, Store Chat,
 * Notifications and the Socket.io realtime layer.
 *
 * Requires a real Postgres database (DATABASE_URL) with the schema migrated
 * (`npx prisma migrate deploy`) and roles seeded (`npm run seed`) before running:
 *
 *   NODE_ENV=test npm test
 */
const http = require('http');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');
const { initRealtime } = require('../src/realtime/socket');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

let roles;
let server;
let socketUrl;

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

/** Gives `customer` a purchase history with `store` so store-chat's
 *  purchase-relationship guard is satisfied — mirrors a real checkout
 *  closely enough for the FK constraints without going through cart/orders. */
async function makePurchaseRelation(customer, store) {
  const category = await prisma.category.upsert({
    where: { slug: 'chat-test-category' },
    update: {},
    create: { name: 'دسته تست چت', slug: 'chat-test-category' },
  });
  const name = `Chat Test Product ${Date.now()}`;
  const slug = `chat-test-product-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const globalProduct = await prisma.product.create({
    data: {
      categoryId: category.id, name, slug, identityKey: slug,
    },
  });
  const product = await prisma.storeProduct.create({
    data: {
      storeId: store.id, productId: globalProduct.id, price: 10000, stock: 10, status: 'APPROVED',
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `TST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      userId: customer.id,
      subtotal: 10000,
      shippingFee: 0,
      total: 10000,
      status: 'CONFIRMED',
      items: {
        create: [{
          storeProductId: product.id, storeId: store.id, nameSnapshot: name, priceSnapshot: 10000, qty: 1,
        }],
      },
    },
  });
  return order;
}

function connectSocket(token) {
  return ioClient(socketUrl, {
    path: '/socket.io',
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

beforeAll(async () => {
  const roleRows = await prisma.role.findMany();
  roles = Object.fromEntries(roleRows.map((r) => [r.key, r]));
  if (!roles.CUSTOMER || !roles.SELLER || !roles.ADMIN || !roles.SUPER_ADMIN) {
    throw new Error('Roles are not seeded — run `npm run seed` against the test database first.');
  }
  server = http.createServer(app);
  initRealtime(server);
  await new Promise((resolve) => { server.listen(0, resolve); });
  const { port } = server.address();
  socketUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ─────────────────────────── Support Chat ───────────────────────────
describe('Support chat', () => {
  test('user sends a message and it is visible in their own ticket', async () => {
    const customer = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const res = await api.post(`${PREFIX}/chat/support`).set('Authorization', customer.auth).send({ body: 'سلام، مشکلی دارم' });
    expect(res.status).toBe(201);

    const mine = await api.get(`${PREFIX}/chat/support`).set('Authorization', customer.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data.messages.length).toBe(1);
  });

  test('admin can reply to an existing ticket but not create one out of thin air', async () => {
    const customer = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const admin = await makeUser('ADMIN', `${Date.now()}`.slice(-9));

    const noTicket = await api.post(`${PREFIX}/chat/support/${customer.user.id}/reply`).set('Authorization', admin.auth).send({ body: 'پاسخ' });
    expect(noTicket.status).toBe(404);

    await api.post(`${PREFIX}/chat/support`).set('Authorization', customer.auth).send({ body: 'اول من پیام میدم' });
    const reply = await api.post(`${PREFIX}/chat/support/${customer.user.id}/reply`).set('Authorization', admin.auth).send({ body: 'در خدمتم' });
    expect(reply.status).toBe(201);
  });

  test('read/unread watermark: unread count drops to 0 after admin marks read', async () => {
    const customer = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const admin = await makeUser('ADMIN', `${Date.now()}`.slice(-9));
    await api.post(`${PREFIX}/chat/support`).set('Authorization', customer.auth).send({ body: 'پیام تستی' });

    const before = await api.get(`${PREFIX}/chat/support/all`).set('Authorization', admin.auth);
    const ticketBefore = before.body.data.find((t) => t.user_id === customer.user.id);
    expect(ticketBefore.unread).toBeGreaterThan(0);

    await api.post(`${PREFIX}/chat/support/${customer.user.id}/read`).set('Authorization', admin.auth);
    const after = await api.get(`${PREFIX}/chat/support/all`).set('Authorization', admin.auth);
    const ticketAfter = after.body.data.find((t) => t.user_id === customer.user.id);
    expect(ticketAfter.unread).toBe(0);
  });

  test('a plain customer cannot reach the staff-only endpoints', async () => {
    const customer = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const res = await api.get(`${PREFIX}/chat/support/all`).set('Authorization', customer.auth);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────── Store Chat ───────────────────────────
describe('Store chat', () => {
  test('customer with no purchase history from a store cannot open a chat with it', async () => {
    const seller = await makeUser('SELLER', `${Date.now()}`.slice(-9));
    const store = await makeApprovedStore(seller.user.id, `Store A ${Date.now()}`);
    const stranger = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));

    const res = await api.get(`${PREFIX}/chat/store/${store.id}`).set('Authorization', stranger.auth);
    expect(res.status).toBe(403);

    const sendRes = await api.post(`${PREFIX}/chat/store/${store.id}`).set('Authorization', stranger.auth).send({ body: 'سلام' });
    expect(sendRes.status).toBe(403);
  });

  test('customer WITH a purchase from the store can open a chat and send messages', async () => {
    const seller = await makeUser('SELLER', `${Date.now()}`.slice(-9));
    const store = await makeApprovedStore(seller.user.id, `Store B ${Date.now()}`);
    const customer = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    await makePurchaseRelation(customer.user, store);

    const send = await api.post(`${PREFIX}/chat/store/${store.id}`).set('Authorization', customer.auth).send({ body: 'محصول کی میرسه؟' });
    expect(send.status).toBe(201);

    const conv = await api.get(`${PREFIX}/chat/store/${store.id}`).set('Authorization', customer.auth);
    expect(conv.status).toBe(200);
    expect(conv.body.data.messages.length).toBe(1);
  });

  test('seller only sees conversations for their own store, never another seller\'s', async () => {
    const sellerA = await makeUser('SELLER', `${Date.now()}`.slice(-9));
    const storeA = await makeApprovedStore(sellerA.user.id, `Store C ${Date.now()}`);
    const sellerB = await makeUser('SELLER', `${Date.now()}`.slice(-9));
    await makeApprovedStore(sellerB.user.id, `Store D ${Date.now()}`);

    const customer = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    await makePurchaseRelation(customer.user, storeA);
    await api.post(`${PREFIX}/chat/store/${storeA.id}`).set('Authorization', customer.auth).send({ body: 'پیام برای فروشگاه A' });

    const listA = await api.get(`${PREFIX}/chat/store-owner/conversations`).set('Authorization', sellerA.auth);
    expect(listA.status).toBe(200);
    expect(listA.body.data.length).toBe(1);

    const listB = await api.get(`${PREFIX}/chat/store-owner/conversations`).set('Authorization', sellerB.auth);
    expect(listB.status).toBe(200);
    expect(listB.body.data.length).toBe(0);
  });

  test('a seller cannot reply into another seller\'s store conversation', async () => {
    const sellerA = await makeUser('SELLER', `${Date.now()}`.slice(-9));
    const storeA = await makeApprovedStore(sellerA.user.id, `Store E ${Date.now()}`);
    const sellerB = await makeUser('SELLER', `${Date.now()}`.slice(-9));

    const customer = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    await makePurchaseRelation(customer.user, storeA);
    await api.post(`${PREFIX}/chat/store/${storeA.id}`).set('Authorization', customer.auth).send({ body: 'سوال' });

    const conv = await prisma.storeConversation.findUnique({ where: { storeId_customerId: { storeId: storeA.id, customerId: customer.user.id } } });
    const hijack = await api.post(`${PREFIX}/chat/store-owner/${conv.id}/reply`).set('Authorization', sellerB.auth).send({ body: 'من فروشنده دیگه‌ای هستم' });
    expect(hijack.status).toBe(403);
  });
});

// ─────────────────────────── Notifications ───────────────────────────
describe('Notifications', () => {
  test('a USER-scoped notification is visible only to its target user', async () => {
    const target = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const other = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const admin = await makeUser('ADMIN', `${Date.now()}`.slice(-9));

    const broadcast = await api.post(`${PREFIX}/notifications/broadcast`).set('Authorization', admin.auth).send({
      icon: 'i-test', text: 'پیام اختصاصی', scope: 'USER', targetUserId: target.user.id,
    });
    expect(broadcast.status).toBe(201);

    const targetList = await api.get(`${PREFIX}/notifications`).set('Authorization', target.auth);
    expect(targetList.body.data.some((n) => n.text === 'پیام اختصاصی')).toBe(true);

    const otherList = await api.get(`${PREFIX}/notifications`).set('Authorization', other.auth);
    expect(otherList.body.data.some((n) => n.text === 'پیام اختصاصی')).toBe(false);
  });

  test('markRead only affects the caller\'s own read state, and mark-all-read clears their unread', async () => {
    const user = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const admin = await makeUser('ADMIN', `${Date.now()}`.slice(-9));
    await api.post(`${PREFIX}/notifications/broadcast`).set('Authorization', admin.auth).send({
      icon: 'i-test', text: 'اطلاعیه عمومی برای همه', scope: 'ALL',
    });

    const before = await api.get(`${PREFIX}/notifications`).set('Authorization', user.auth);
    expect(before.body.data.some((n) => !n.read)).toBe(true);

    const markAll = await api.post(`${PREFIX}/notifications/read-all`).set('Authorization', user.auth);
    expect(markAll.status).toBe(200);

    const after = await api.get(`${PREFIX}/notifications`).set('Authorization', user.auth);
    expect(after.body.data.every((n) => n.read)).toBe(true);
  });

  test('a non-admin cannot broadcast notifications', async () => {
    const customer = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const res = await api.post(`${PREFIX}/notifications/broadcast`).set('Authorization', customer.auth).send({
      icon: 'i-test', text: 'تلاش غیرمجاز', scope: 'ALL',
    });
    expect(res.status).toBe(403);
  });

  test('a user cannot mark-read or dismiss a notification that was never addressed to them (IDOR guard)', async () => {
    const target = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const attacker = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const admin = await makeUser('ADMIN', `${Date.now()}`.slice(-9));

    const broadcast = await api.post(`${PREFIX}/notifications/broadcast`).set('Authorization', admin.auth).send({
      icon: 'i-test', text: 'پیام فقط برای هدف', scope: 'USER', targetUserId: target.user.id,
    });
    const notificationId = broadcast.body.data.id;

    const readAttempt = await api.patch(`${PREFIX}/notifications/${notificationId}/read`).set('Authorization', attacker.auth);
    expect(readAttempt.status).toBe(404);

    const dismissAttempt = await api.delete(`${PREFIX}/notifications/${notificationId}`).set('Authorization', attacker.auth);
    expect(dismissAttempt.status).toBe(404);
  });
});

// ─────────────────────────── Socket.io realtime layer ───────────────────────────
describe('Socket.io', () => {
  test('connects successfully with a valid JWT', async () => {
    const customer = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const socket = connectSocket(customer.token);
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    expect(socket.connected).toBe(true);
    socket.disconnect();
  });

  test('rejects a connection with no token / an invalid token', async () => {
    const badSocket = connectSocket('this-is-not-a-real-jwt');
    const err = await new Promise((resolve) => {
      badSocket.on('connect', () => resolve(null));
      badSocket.on('connect_error', (e) => resolve(e));
    });
    expect(err).not.toBeNull();
    badSocket.disconnect();
  });

  test('room isolation: customer B never receives customer A\'s support-chat event', async () => {
    const customerA = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const customerB = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const admin = await makeUser('ADMIN', `${Date.now()}`.slice(-9));

    const socketA = connectSocket(customerA.token);
    const socketB = connectSocket(customerB.token);
    await Promise.all([
      new Promise((r) => socketA.on('connect', r)),
      new Promise((r) => socketB.on('connect', r)),
    ]);

    let bReceived = false;
    socketB.on('chat:support:message', () => { bReceived = true; });

    const aMessage = new Promise((resolve) => socketA.on('chat:support:message', resolve));
    await api.post(`${PREFIX}/chat/support`).set('Authorization', customerA.auth).send({ body: 'پیام محرمانه A' });
    await aMessage;

    // give any (incorrect) broadcast a moment to arrive before asserting it didn't
    await new Promise((r) => setTimeout(r, 200));
    expect(bReceived).toBe(false);

    socketA.disconnect();
    socketB.disconnect();
    void admin; // referenced only to document who the message target actually is (ADMIN_STAFF room)
  });

  test('real-time delivery: admin staff room receives a new support message live', async () => {
    const customer = await makeUser('CUSTOMER', `${Date.now()}`.slice(-9));
    const admin = await makeUser('ADMIN', `${Date.now()}`.slice(-9));
    const adminSocket = connectSocket(admin.token);
    await new Promise((r) => adminSocket.on('connect', r));

    const received = new Promise((resolve) => adminSocket.on('chat:support:message', resolve));
    await api.post(`${PREFIX}/chat/support`).set('Authorization', customer.auth).send({ body: 'لطفا کمک کنید' });
    const payload = await received;
    expect(payload.userId).toBe(customer.user.id);

    adminSocket.disconnect();
  });
});
