/**
 * Focused regression test for the "User + Wallet creation must be atomic"
 * fix (Financial Flow Audit, HIGH finding #1).
 *
 * Before this fix, auth.service.js#register, users.service.js#createStaffUser,
 * and stores.service.js#createDirect each created the User row and its
 * Wallet (and, for register, its Cart) as separate top-level `prisma.*`
 * calls rather than inside one `$transaction`. No existing test exercised
 * these real endpoints — every other test that needed a wallet created one
 * by hand via `prisma.wallet.upsert/create`, which is exactly why this gap
 * was never caught by a test failure.
 *
 * This suite calls the REAL endpoints (not test-helper shortcuts) and
 * asserts a Wallet exists immediately after each, which is the concrete
 * behavior the atomicity fix protects. It does not attempt to simulate a
 * mid-transaction crash (Prisma's $transaction is what Postgres/the ORM
 * guarantees atomicity for; that guarantee itself is out of scope to test
 * here) — it verifies the observable outcome: every newly created user
 * comes out of these three flows with exactly one Wallet, every time.
 *
 * Requires a real Postgres database (DATABASE_URL), migrated + seeded:
 *   NODE_ENV=test npm test
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { prisma } = require('../src/config/database');
const { signAccessToken, hashOtpCode, generateNumericCode } = require('../src/utils/tokens');

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

/**
 * Issues a real, DB-backed OTP for (mobile, 'REGISTER') without going
 * through the rate-limited POST /auth/otp/send + mocked SMS delivery — the
 * OTP itself isn't what this suite is testing, so this replicates exactly
 * what sendOtp() persists (see auth.service.js) so register()'s own
 * verifyAndConsumeOtp() accepts it.
 */
async function issueRegisterOtp(mobile) {
  const code = generateNumericCode(6);
  await prisma.otpCode.create({
    data: {
      mobile,
      purpose: 'REGISTER',
      codeHash: hashOtpCode(mobile, 'REGISTER', code),
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });
  return code;
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

describe('User + Wallet creation atomicity', () => {
  test('POST /auth/register creates a Wallet (and Cart) for the new user', async () => {
    const mobile = `0955${Math.floor(1000000 + Math.random() * 8999999)}`;
    const otpCode = await issueRegisterOtp(mobile);

    const res = await api.post(`${PREFIX}/auth/register`).send({
      name: 'کاربر تست اتمیک', mobile, password: 'Passw0rd!23', otpCode,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user.mobile).toBe(mobile);
    // Response shape preserved: user + accessToken/refreshToken, unchanged by the fix.
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');

    const wallet = await prisma.wallet.findUnique({ where: { userId: res.body.data.user.id } });
    expect(wallet).not.toBeNull();
    expect(Number(wallet.balance)).toBe(0);

    const cart = await prisma.cart.findUnique({ where: { userId: res.body.data.user.id } });
    expect(cart).not.toBeNull();
  });

  test('POST /admin/admins creates a Wallet for the new staff user', async () => {
    const superAdmin = await makeUser('SUPER_ADMIN', '56000000' + Math.floor(Math.random() * 9));
    const mobile = `0956${Math.floor(1000000 + Math.random() * 8999999)}`;

    const res = await api.post(`${PREFIX}/admin/admins`).set('Authorization', superAdmin.auth).send({
      name: 'ادمین تست اتمیک', mobile, password: 'Passw0rd!23',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.mobile).toBe(mobile);

    const wallet = await prisma.wallet.findUnique({ where: { userId: res.body.data.id } });
    expect(wallet).not.toBeNull();
    expect(Number(wallet.balance)).toBe(0);
  });

  test('POST /stores (new-user branch) creates a Wallet for the new seller user', async () => {
    const admin = await makeUser('ADMIN', '57000000' + Math.floor(Math.random() * 9));
    const mobile = `0957${Math.floor(1000000 + Math.random() * 8999999)}`;

    const res = await api.post(`${PREFIX}/stores`).set('Authorization', admin.auth).send({
      name: 'فروشگاه تست اتمیک', mobile,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.credentials.mobile).toBe(mobile);

    const createdUser = await prisma.user.findUnique({ where: { mobile } });
    expect(createdUser).not.toBeNull();

    const wallet = await prisma.wallet.findUnique({ where: { userId: createdUser.id } });
    expect(wallet).not.toBeNull();
    expect(Number(wallet.balance)).toBe(0);
  });

  test('POST /stores (existing-customer-upgrade branch) is untouched: no new User/Wallet, existing Wallet unchanged', async () => {
    const admin = await makeUser('ADMIN', '58000000' + Math.floor(Math.random() * 9));
    const customer = await makeUser('CUSTOMER', '58100000' + Math.floor(Math.random() * 9));
    await prisma.wallet.upsert({
      where: { userId: customer.user.id }, update: { balance: 12345 }, create: { userId: customer.user.id, balance: 12345 },
    });

    const res = await api.post(`${PREFIX}/stores`).set('Authorization', admin.auth).send({
      name: 'فروشگاه ارتقا مشتری', mobile: customer.user.mobile, password: 'Passw0rd!23',
    });

    expect(res.status).toBe(201);

    // Same user id upgraded in place — not a new User row.
    const userCount = await prisma.user.count({ where: { mobile: customer.user.mobile } });
    expect(userCount).toBe(1);

    // Wallet is the SAME pre-existing one, balance untouched by store creation.
    const wallet = await prisma.wallet.findUnique({ where: { userId: customer.user.id } });
    expect(wallet).not.toBeNull();
    expect(Number(wallet.balance)).toBe(12345);
  });
});
