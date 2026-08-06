/**
 * Integration test suite for DELETE /admin/sellers/:sellerId.
 *
 * Covers the rules requested:
 *   - Admin (with sellers:delete) and super_admin (wildcard) can delete a seller.
 *   - Customers and sellers (no permission) get 403.
 *   - A seller with products/orders/chats can be deleted without corrupting
 *     that history: products are archived (not destroyed), orders/order items/
 *     payments/store conversations are left completely untouched.
 *   - Deleting a non-existent seller -> 404.
 *   - Deleting a non-seller (e.g. a customer) -> 400.
 *   - Deleting the super_admin -> 403.
 *   - Deleting yourself -> 400.
 *   - Deleting an already-deleted seller -> 409.
 *
 * Requires a real Postgres database (DATABASE_URL) with the schema migrated
 * (`npx prisma migrate deploy`) and roles seeded (`npm run seed`) before running:
 *
 *   NODE_ENV=test npm test
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/tokens');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

let roles; // { CUSTOMER, SELLER, ADMIN, SUPER_ADMIN } -> role row
let mobileCounter = 0;

function nextMobile() {
  mobileCounter += 1;
  return `0938${String(Date.now()).slice(-4)}${String(mobileCounter).padStart(3, '0')}`;
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

async function makeStore(sellerId, name) {
  return prisma.store.create({
    data: {
      sellerId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: 'APPROVED',
    },
  });
}

async function makeProduct(storeId, name) {
  const slug = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const product = await prisma.product.create({
    data: { name, slug, identityKey: slug },
  });
  return prisma.storeProduct.create({
    data: {
      storeId,
      productId: product.id,
      price: 100000,
      status: 'APPROVED',
      isActive: true,
    },
  });
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

describe('DELETE /admin/sellers/:sellerId', () => {
  test('admin deletes a plain seller (no products/orders): bans account, suspends store', async () => {
    const admin = await makeUser('ADMIN');
    const seller = await makeUser('SELLER');
    const store = await makeStore(seller.user.id, 'Plain Seller Store');

    const res = await api
      .delete(`${PREFIX}/admin/sellers/${seller.user.id}`)
      .set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const updatedUser = await prisma.user.findUnique({ where: { id: seller.user.id } });
    expect(updatedUser.status).toBe('BANNED');
    expect(updatedUser.deletedAt).not.toBeNull();
    expect(updatedUser.deletedById).toBe(admin.user.id);

    const updatedStore = await prisma.store.findUnique({ where: { id: store.id } });
    expect(updatedStore.status).toBe('SUSPENDED');
  });

  test('super_admin deletes a seller successfully', async () => {
    const superAdmin = await makeUser('SUPER_ADMIN');
    const seller = await makeUser('SELLER');
    await makeStore(seller.user.id, 'Super Admin Target Store');

    const res = await api
      .delete(`${PREFIX}/admin/sellers/${seller.user.id}`)
      .set('Authorization', superAdmin.auth);

    expect(res.status).toBe(200);
    const updatedUser = await prisma.user.findUnique({ where: { id: seller.user.id } });
    expect(updatedUser.status).toBe('BANNED');
    expect(updatedUser.deletedById).toBe(superAdmin.user.id);
  });

  test('a normal customer gets 403', async () => {
    const customer = await makeUser('CUSTOMER');
    const seller = await makeUser('SELLER');
    await makeStore(seller.user.id, 'Customer Attempt Store');

    const res = await api
      .delete(`${PREFIX}/admin/sellers/${seller.user.id}`)
      .set('Authorization', customer.auth);

    expect(res.status).toBe(403);
    const untouched = await prisma.user.findUnique({ where: { id: seller.user.id } });
    expect(untouched.status).toBe('ACTIVE');
    expect(untouched.deletedAt).toBeNull();
  });

  test('a seller trying to delete another seller gets 403', async () => {
    const actingSeller = await makeUser('SELLER');
    await makeStore(actingSeller.user.id, 'Acting Seller Store');
    const targetSeller = await makeUser('SELLER');
    await makeStore(targetSeller.user.id, 'Target Seller Store');

    const res = await api
      .delete(`${PREFIX}/admin/sellers/${targetSeller.user.id}`)
      .set('Authorization', actingSeller.auth);

    expect(res.status).toBe(403);
  });

  test('deleting a seller with products archives them instead of destroying them', async () => {
    const admin = await makeUser('ADMIN');
    const seller = await makeUser('SELLER');
    const store = await makeStore(seller.user.id, 'Store With Products');
    const product = await makeProduct(store.id, 'Some Product');

    const res = await api
      .delete(`${PREFIX}/admin/sellers/${seller.user.id}`)
      .set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    const updatedProduct = await prisma.storeProduct.findUnique({ where: { id: product.id } });
    expect(updatedProduct).not.toBeNull(); // row still exists — not hard-deleted
    expect(updatedProduct.status).toBe('ARCHIVED');
    expect(updatedProduct.isActive).toBe(false);
  });

  test('deleting a seller with existing order history succeeds and leaves orders/payments intact', async () => {
    const admin = await makeUser('ADMIN');
    const seller = await makeUser('SELLER');
    const customer = await makeUser('CUSTOMER');
    const store = await makeStore(seller.user.id, 'Store With Orders');
    const productName = 'Ordered Product';
    const product = await makeProduct(store.id, productName);

    const order = await prisma.order.create({
      data: {
        orderNumber: `ORD-${Date.now()}`,
        userId: customer.user.id,
        subtotal: 100000,
        shippingFee: 0,
        total: 100000,
        status: 'DELIVERED',
        items: {
          create: [{
            storeProductId: product.id,
            storeId: store.id,
            nameSnapshot: productName,
            priceSnapshot: 100000,
            qty: 1,
          }],
        },
      },
      include: { items: true },
    });
    const payment = await prisma.payment.create({
      data: { orderId: order.id, method: 'WALLET', amount: 100000, status: 'SUCCESS' },
    });

    const res = await api
      .delete(`${PREFIX}/admin/sellers/${seller.user.id}`)
      .set('Authorization', admin.auth);

    expect(res.status).toBe(200); // no FK-constraint failure

    const stillThere = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    expect(stillThere).not.toBeNull();
    expect(stillThere.items).toHaveLength(1);
    const stillPaid = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(stillPaid.status).toBe('SUCCESS');

    const archivedProduct = await prisma.storeProduct.findUnique({ where: { id: product.id } });
    expect(archivedProduct.status).toBe('ARCHIVED');
  });

  test('deleting a seller with an existing store conversation preserves the chat history', async () => {
    const admin = await makeUser('ADMIN');
    const seller = await makeUser('SELLER');
    const customer = await makeUser('CUSTOMER');
    const store = await makeStore(seller.user.id, 'Store With Chats');

    const conversation = await prisma.storeConversation.create({
      data: { storeId: store.id, customerId: customer.user.id },
    });
    await prisma.storeMessage.create({
      data: {
        conversationId: conversation.id, senderId: customer.user.id, from: 'CUSTOMER', body: 'سلام',
      },
    });

    const res = await api
      .delete(`${PREFIX}/admin/sellers/${seller.user.id}`)
      .set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    const stillThere = await prisma.storeConversation.findUnique({
      where: { id: conversation.id },
      include: { messages: true },
    });
    expect(stillThere).not.toBeNull();
    expect(stillThere.messages).toHaveLength(1);
  });

  test('deleting an already-deleted seller returns 409', async () => {
    const admin = await makeUser('ADMIN');
    const seller = await makeUser('SELLER');
    await makeStore(seller.user.id, 'Double Delete Store');

    const first = await api
      .delete(`${PREFIX}/admin/sellers/${seller.user.id}`)
      .set('Authorization', admin.auth);
    expect(first.status).toBe(200);

    const second = await api
      .delete(`${PREFIX}/admin/sellers/${seller.user.id}`)
      .set('Authorization', admin.auth);
    expect(second.status).toBe(409);
  });

  test('deleting a non-existent seller returns 404', async () => {
    const admin = await makeUser('ADMIN');
    const res = await api
      .delete(`${PREFIX}/admin/sellers/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', admin.auth);
    expect(res.status).toBe(404);
  });

  test('deleting a user who is not a seller (e.g. a customer) returns 400', async () => {
    const admin = await makeUser('ADMIN');
    const customer = await makeUser('CUSTOMER');
    const res = await api
      .delete(`${PREFIX}/admin/sellers/${customer.user.id}`)
      .set('Authorization', admin.auth);
    expect(res.status).toBe(400);
  });

  test('deleting the super_admin is forbidden', async () => {
    const admin = await makeUser('ADMIN');
    const superAdmin = await makeUser('SUPER_ADMIN');
    const res = await api
      .delete(`${PREFIX}/admin/sellers/${superAdmin.user.id}`)
      .set('Authorization', admin.auth);
    expect(res.status).toBe(403);
  });

  test('an admin cannot delete themselves via this endpoint', async () => {
    const admin = await makeUser('ADMIN');
    const res = await api
      .delete(`${PREFIX}/admin/sellers/${admin.user.id}`)
      .set('Authorization', admin.auth);
    expect(res.status).toBe(400);
  });

  test('a deleted seller can no longer authenticate', async () => {
    const admin = await makeUser('ADMIN');
    const seller = await makeUser('SELLER');
    await makeStore(seller.user.id, 'Locked Out Store');

    await api.delete(`${PREFIX}/admin/sellers/${seller.user.id}`).set('Authorization', admin.auth);

    const res = await api.get(`${PREFIX}/users/me`).set('Authorization', seller.auth);
    expect(res.status).toBe(403);
  });
});
