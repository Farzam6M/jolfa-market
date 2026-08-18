/**
 * Test suite for Phase 5: Seller Payout / Withdrawal.
 *
 * Covers the full state machine on top of Phase 1-4's Wallet/
 * WalletTransaction machinery, without touching it:
 *
 *   REQUESTED -> APPROVED -> PROCESSED   (terminal success, no refund)
 *   REQUESTED -> REJECTED                (terminal, reservation returned)
 *   APPROVED  -> FAILED                  (terminal, reservation returned)
 *
 * Specifically exercises:
 *   - POST /payouts atomically reserves (debits) `amount` from the
 *     seller's wallet the moment the row is created (REQUESTED), with a
 *     WalletTransaction DEBIT row recorded.
 *   - Insufficient balance is rejected (400) and reserves nothing.
 *   - idempotencyKey: a retried create with the same key is a no-op — no
 *     second reservation, no duplicate row.
 *   - GET /payouts only ever returns the caller's own requests.
 *   - PATCH /admin/payouts/:id/approve: REQUESTED->APPROVED, no wallet
 *     movement.
 *   - PATCH /admin/payouts/:id/reject: REQUESTED->REJECTED, the reserved
 *     amount is credited back exactly once even if reject is retried.
 *   - PATCH /admin/payouts/:id/mark-processed: APPROVED->PROCESSED, no
 *     wallet movement (money already left the wallet at REQUESTED).
 *   - PATCH /admin/payouts/:id/mark-failed: APPROVED->FAILED, the reserved
 *     amount is credited back.
 *   - RBAC: a seller cannot reach any /admin/payouts endpoint; a customer
 *     cannot reach /payouts (no WALLET_WITHDRAW_SELF).
 *   - Balance can never go negative: two concurrent withdrawal requests
 *     for more than the wallet holds only let one succeed.
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
const { PLATFORM_LEDGER_OWNER_ID } = require('../src/modules/ledger/ledger.constants');

const api = request(app);
const PREFIX = process.env.API_PREFIX || '/api/v1';

// P2.8-C — small Ledger lookup helpers, same shape as
// order-settlement.test.js / payout-liabilities.test.js's own
// findJournal/entriesFor helpers (kept local rather than shared/exported,
// matching those files' own approach).
async function findJournal(eventType, eventId) {
  return prisma.journal.findUnique({ where: { eventType_eventId: { eventType, eventId } } });
}

async function entriesFor(journalId) {
  return prisma.ledgerEntry.findMany({ where: { journalId }, include: { account: true } });
}

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

const validBank = () => ({
  bankAccountHolder: 'علی رضایی',
  bankIban: 'IR820540102680020817909002',
  bankCardNumber: '6037991234567890',
});

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

describe('POST /payouts (create — reserve)', () => {
  let seller;
  let admin;

  beforeAll(async () => {
    seller = await makeUser('SELLER', '53000000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '53010000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: seller.user.id, balance: 500000 } });
  });

  test('reserves the amount atomically: debits the wallet and creates a REQUESTED row', async () => {
    const res = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({
      amount: 100000, ...validBank(),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('REQUESTED');
    expect(res.body.data.sellerId).toBe(seller.user.id);

    const wallet = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(wallet.balance)).toBe(400000);

    const tx = await prisma.walletTransaction.findFirst({
      where: { walletId: wallet.id, refId: res.body.data.id, type: 'DEBIT' },
    });
    expect(tx).toBeTruthy();
    expect(Number(tx.amount)).toBe(100000);

    // P2.8-C — PAYOUT_RESERVE Journal: eventId = the real PayoutRequest.id
    // (createPayout's own postPayoutReserve call — see payouts.service.js).
    const reserveJournal = await findJournal('PAYOUT_RESERVE', res.body.data.id);
    expect(reserveJournal).not.toBeNull();

    const reserveEntries = await entriesFor(reserveJournal.id);
    // Two legs per ledger.constants.js's PAYOUT_RESERVE mapping: DEBIT
    // SELLER_WALLET(sellerId) / CREDIT PAYOUT_CLEARING(PLATFORM).
    expect(reserveEntries).toHaveLength(2);

    const sellerLeg = reserveEntries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    expect(sellerLeg).toBeDefined();
    expect(sellerLeg.direction).toBe('DEBIT');
    expect(sellerLeg.account.ownerId).toBe(seller.user.id);
    expect(Number(sellerLeg.amount)).toBe(100000); // matches the real wallet debit above

    const clearingLeg = reserveEntries.find((e) => e.account.ownerType === 'PAYOUT_CLEARING');
    expect(clearingLeg).toBeDefined();
    expect(clearingLeg.direction).toBe('CREDIT');
    expect(clearingLeg.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(Number(clearingLeg.amount)).toBe(100000);

    // Balanced: SUM(DEBIT) === SUM(CREDIT).
    const debitTotal = reserveEntries.filter((e) => e.direction === 'DEBIT').reduce((sum, e) => sum + Number(e.amount), 0);
    const creditTotal = reserveEntries.filter((e) => e.direction === 'CREDIT').reduce((sum, e) => sum + Number(e.amount), 0);
    expect(debitTotal).toBe(creditTotal);
    expect(debitTotal).toBe(100000);
  });

  test('rejects with 400 and reserves nothing when balance is insufficient', async () => {
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    const res = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({
      amount: 999999999, ...validBank(),
    });
    expect(res.status).toBe(400);

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance));
  });

  test('idempotencyKey: a retried create with the same key is a no-op, not a second reservation', async () => {
    const idempotencyKey = 'a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5';
    const payload = { amount: 50000, idempotencyKey, ...validBank() };

    const first = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send(payload);
    expect(first.status).toBe(201);
    const walletAfterFirst = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });

    const second = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send(payload);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const walletAfterSecond = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfterSecond.balance)).toBe(Number(walletAfterFirst.balance));

    const count = await prisma.payoutRequest.count({ where: { idempotencyKey } });
    expect(count).toBe(1);

    // P2.8-C — idempotency: a retried transition for the same eventId must
    // NOT create a second Journal for the same eventType/eventId.
    const reserveJournals = await prisma.journal.findMany({
      where: { eventType: 'PAYOUT_RESERVE', eventId: first.body.data.id },
    });
    expect(reserveJournals).toHaveLength(1);
  });

  test('idempotencyKey: concurrent creates with the same key resolve to exactly one payout and one DEBIT, never a raw duplicate-key error', async () => {
    const racer = await makeUser('SELLER', '53080000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: racer.user.id, balance: 200000 } });
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: racer.user.id } });

    const idempotencyKey = crypto.randomUUID();
    const payload = { amount: 50000, idempotencyKey, ...validBank() };

    const [a, b] = await Promise.all([
      api.post(`${PREFIX}/payouts`).set('Authorization', racer.auth).send(payload),
      api.post(`${PREFIX}/payouts`).set('Authorization', racer.auth).send(payload),
    ]);

    // Neither concurrent request should surface a raw duplicate-key error —
    // both must resolve to the SAME logical (idempotent) result.
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.id).toBe(b.body.data.id);

    const count = await prisma.payoutRequest.count({ where: { idempotencyKey } });
    expect(count).toBe(1); // exactly one PayoutRequest row, never two

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: racer.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance) - 50000); // reserved exactly once

    const debits = await prisma.walletTransaction.findMany({
      where: { walletId: walletAfter.id, refId: a.body.data.id, type: 'DEBIT' },
    });
    expect(debits.length).toBe(1); // exactly one DEBIT, never two
  });

  test('rejects an invalid IBAN with 400', async () => {
    const res = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({
      amount: 10000, bankAccountHolder: 'علی رضایی', bankIban: 'not-an-iban',
    });
    expect(res.status).toBe(400);
  });

  test('a customer (no WALLET_WITHDRAW_SELF) cannot create a payout request', async () => {
    const customer = await makeUser('CUSTOMER', '53020000' + Math.floor(Math.random() * 9));
    const res = await api.post(`${PREFIX}/payouts`).set('Authorization', customer.auth).send({
      amount: 10000, ...validBank(),
    });
    expect(res.status).toBe(403);
  });

  test('balance never goes negative: only one of two concurrent over-balance requests can succeed', async () => {
    const racer = await makeUser('SELLER', '53030000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: racer.user.id, balance: 100000 } });

    const [a, b] = await Promise.all([
      api.post(`${PREFIX}/payouts`).set('Authorization', racer.auth).send({ amount: 70000, ...validBank() }),
      api.post(`${PREFIX}/payouts`).set('Authorization', racer.auth).send({ amount: 70000, ...validBank() }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 400]);

    const wallet = await prisma.wallet.findUnique({ where: { userId: racer.user.id } });
    expect(Number(wallet.balance)).toBe(30000);
    expect(Number(wallet.balance)).toBeGreaterThanOrEqual(0);
  });

  test('admin (no WALLET_WITHDRAW_SELF) cannot create a payout request', async () => {
    const res = await api.post(`${PREFIX}/payouts`).set('Authorization', admin.auth).send({
      amount: 10000, ...validBank(),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /payouts (mine) — scoped to the caller', () => {
  let sellerA;
  let sellerB;

  beforeAll(async () => {
    sellerA = await makeUser('SELLER', '53040000' + Math.floor(Math.random() * 9));
    sellerB = await makeUser('SELLER', '53050000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: sellerA.user.id, balance: 200000 } });
    await prisma.wallet.create({ data: { userId: sellerB.user.id, balance: 200000 } });
    await api.post(`${PREFIX}/payouts`).set('Authorization', sellerA.auth).send({ amount: 10000, ...validBank() });
    await api.post(`${PREFIX}/payouts`).set('Authorization', sellerB.auth).send({ amount: 20000, ...validBank() });
  });

  test('a seller only ever sees their own payout requests', async () => {
    const res = await api.get(`${PREFIX}/payouts`).set('Authorization', sellerA.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.items.every((r) => r.sellerId === sellerA.user.id)).toBe(true);
  });
});

describe('Admin transitions', () => {
  let seller;
  let admin;

  beforeAll(async () => {
    seller = await makeUser('SELLER', '53060000' + Math.floor(Math.random() * 9));
    admin = await makeUser('ADMIN', '53070000' + Math.floor(Math.random() * 9));
    await prisma.wallet.create({ data: { userId: seller.user.id, balance: 1000000 } });
  });

  test('GET /admin/payouts lists requests across sellers', async () => {
    await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({ amount: 10000, ...validBank() });
    const res = await api.get(`${PREFIX}/admin/payouts`).set('Authorization', admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThan(0);
  });

  test('approve: REQUESTED -> APPROVED, no wallet movement', async () => {
    const created = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({ amount: 50000, ...validBank() });
    const id = created.body.data.id;
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });

    const res = await api.patch(`${PREFIX}/admin/payouts/${id}/approve`).set('Authorization', admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
    expect(res.body.data.approvedById).toBe(admin.user.id);

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance));
  });

  test('reject: REQUESTED -> REJECTED returns the reserved amount exactly once, even if retried', async () => {
    const walletStart = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    const created = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({ amount: 30000, ...validBank() });
    const id = created.body.data.id;

    const walletAfterReserve = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfterReserve.balance)).toBe(Number(walletStart.balance) - 30000);

    const first = await api.patch(`${PREFIX}/admin/payouts/${id}/reject`).set('Authorization', admin.auth).send({ reason: 'اطلاعات بانکی نامعتبر' });
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('REJECTED');

    const walletAfterReject = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfterReject.balance)).toBe(Number(walletStart.balance));

    // P2.8-C — PAYOUT_RELEASE Journal: same eventId (PayoutRequest.id) as
    // the PAYOUT_RESERVE Journal posted at create time (releaseReservation's
    // own postPayoutRelease call — see payouts.service.js).
    const releaseJournal = await findJournal('PAYOUT_RELEASE', id);
    expect(releaseJournal).not.toBeNull();

    const releaseEntries = await entriesFor(releaseJournal.id);
    // Two legs per ledger.constants.js's PAYOUT_RELEASE mapping — the
    // exact reverse of PAYOUT_RESERVE: DEBIT PAYOUT_CLEARING(PLATFORM) /
    // CREDIT SELLER_WALLET(sellerId).
    expect(releaseEntries).toHaveLength(2);

    const clearingLeg = releaseEntries.find((e) => e.account.ownerType === 'PAYOUT_CLEARING');
    expect(clearingLeg).toBeDefined();
    expect(clearingLeg.direction).toBe('DEBIT');
    expect(clearingLeg.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(Number(clearingLeg.amount)).toBe(30000);

    const sellerLeg = releaseEntries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    expect(sellerLeg).toBeDefined();
    expect(sellerLeg.direction).toBe('CREDIT');
    expect(sellerLeg.account.ownerId).toBe(seller.user.id);
    expect(Number(sellerLeg.amount)).toBe(30000); // matches the real wallet credit above

    // Balanced: SUM(DEBIT) === SUM(CREDIT).
    const releaseDebitTotal = releaseEntries.filter((e) => e.direction === 'DEBIT').reduce((sum, e) => sum + Number(e.amount), 0);
    const releaseCreditTotal = releaseEntries.filter((e) => e.direction === 'CREDIT').reduce((sum, e) => sum + Number(e.amount), 0);
    expect(releaseDebitTotal).toBe(releaseCreditTotal);
    expect(releaseDebitTotal).toBe(30000);

    // Retried reject on an already-REJECTED row must be a no-op — no second credit.
    const second = await api.patch(`${PREFIX}/admin/payouts/${id}/reject`).set('Authorization', admin.auth).send({ reason: 'تکراری' });
    expect(second.status).toBe(200);
    const walletAfterRetry = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfterRetry.balance)).toBe(Number(walletStart.balance));

    // P2.8-C — idempotency: the repeated REQUESTED->REJECTED transition
    // above must NOT create a second Journal for the same
    // eventType/eventId (PAYOUT_RELEASE, id).
    const releaseJournalsAfterRetry = await prisma.journal.findMany({ where: { eventType: 'PAYOUT_RELEASE', eventId: id } });
    expect(releaseJournalsAfterRetry).toHaveLength(1);
  });

  test('mark-processed: APPROVED -> PROCESSED, no wallet movement', async () => {
    const created = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({ amount: 40000, ...validBank() });
    const id = created.body.data.id;
    await api.patch(`${PREFIX}/admin/payouts/${id}/approve`).set('Authorization', admin.auth);
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });

    const res = await api.patch(`${PREFIX}/admin/payouts/${id}/mark-processed`).set('Authorization', admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PROCESSED');
    expect(res.body.data.processedById).toBe(admin.user.id);

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance));

    // P2.8-C — PAYOUT_PROCESSED Journal: same eventId (PayoutRequest.id)
    // as the PAYOUT_RESERVE Journal posted at create time (markProcessed's
    // own postPayoutProcessed call — see payouts.service.js).
    const processedJournal = await findJournal('PAYOUT_PROCESSED', id);
    expect(processedJournal).not.toBeNull();

    const processedEntries = await entriesFor(processedJournal.id);
    // Two legs per ledger.constants.js's PAYOUT_PROCESSED mapping, both
    // platform-owned: DEBIT PAYOUT_CLEARING(PLATFORM) / CREDIT
    // PLATFORM_CASH(PLATFORM). No SELLER_WALLET leg — markProcessed's own
    // doc comment: "the money already left the seller's wallet at
    // REQUESTED time", matching the unchanged wallet balance above.
    expect(processedEntries).toHaveLength(2);

    const sellerWalletLeg = processedEntries.find((e) => e.account.ownerType === 'SELLER_WALLET');
    expect(sellerWalletLeg).toBeUndefined(); // no additional SELLER_WALLET movement at this stage

    const clearingLeg = processedEntries.find((e) => e.account.ownerType === 'PAYOUT_CLEARING');
    expect(clearingLeg).toBeDefined();
    expect(clearingLeg.direction).toBe('DEBIT');
    expect(clearingLeg.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(Number(clearingLeg.amount)).toBe(40000);

    const cashLeg = processedEntries.find((e) => e.account.ownerType === 'PLATFORM_CASH');
    expect(cashLeg).toBeDefined();
    expect(cashLeg.direction).toBe('CREDIT');
    expect(cashLeg.account.ownerId).toBe(PLATFORM_LEDGER_OWNER_ID);
    expect(Number(cashLeg.amount)).toBe(40000);

    // Balanced: SUM(DEBIT) === SUM(CREDIT).
    const processedDebitTotal = processedEntries.filter((e) => e.direction === 'DEBIT').reduce((sum, e) => sum + Number(e.amount), 0);
    const processedCreditTotal = processedEntries.filter((e) => e.direction === 'CREDIT').reduce((sum, e) => sum + Number(e.amount), 0);
    expect(processedDebitTotal).toBe(processedCreditTotal);
    expect(processedDebitTotal).toBe(40000);
  });

  test('mark-failed: APPROVED -> FAILED returns the reserved amount', async () => {
    const walletStart = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    const created = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({ amount: 60000, ...validBank() });
    const id = created.body.data.id;
    await api.patch(`${PREFIX}/admin/payouts/${id}/approve`).set('Authorization', admin.auth);

    const res = await api.patch(`${PREFIX}/admin/payouts/${id}/mark-failed`).set('Authorization', admin.auth).send({ failureReason: 'شماره شبا نامعتبر بود' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('FAILED');
    expect(res.body.data.failureReason).toBe('شماره شبا نامعتبر بود');

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletStart.balance));
  });

  test('mark-failed requires an APPROVED row — REQUESTED is rejected as an invalid transition, not a silent no-op', async () => {
    const created = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({ amount: 15000, ...validBank() });
    const id = created.body.data.id;
    const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });

    const res = await api.patch(`${PREFIX}/admin/payouts/${id}/mark-failed`).set('Authorization', admin.auth).send({ failureReason: 'زودتر از موعد' });
    expect(res.status).toBe(409);

    const stillRequested = await prisma.payoutRequest.findUnique({ where: { id } });
    expect(stillRequested.status).toBe('REQUESTED'); // unchanged — invalid transition, not silently accepted

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
    expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance)); // no credit fired

    // Cleanup: reject it so it doesn't leave a dangling reservation.
    await api.patch(`${PREFIX}/admin/payouts/${id}/reject`).set('Authorization', admin.auth).send({});
  });

  describe('Fix #3 — silent invalid-state-transition no-op', () => {
    async function freshRequested(amount = 20000) {
      const res = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({ amount, ...validBank() });
      return res.body.data.id;
    }

    async function freshApproved(amount = 20000) {
      const id = await freshRequested(amount);
      await api.patch(`${PREFIX}/admin/payouts/${id}/approve`).set('Authorization', admin.auth);
      return id;
    }

    async function freshRejected(amount = 20000) {
      const id = await freshRequested(amount);
      await api.patch(`${PREFIX}/admin/payouts/${id}/reject`).set('Authorization', admin.auth).send({});
      return id;
    }

    async function freshProcessed(amount = 20000) {
      const id = await freshApproved(amount);
      await api.patch(`${PREFIX}/admin/payouts/${id}/mark-processed`).set('Authorization', admin.auth);
      return id;
    }

    // RC-A: mark-failed now requires a non-empty failureReason for a
    // genuine APPROVED -> FAILED transition (see
    // payouts.service.js#markFailed) — this helper performs exactly that
    // real transition, so it must supply one.
    async function freshFailed(amount = 20000) {
      const id = await freshApproved(amount);
      await api.patch(`${PREFIX}/admin/payouts/${id}/mark-failed`).set('Authorization', admin.auth).send({ failureReason: 'test failure' });
      return id;
    }

    // RC-C: `walletTransaction` rows for a payout share the SAME `refId`
    // (the payoutRequest.id) for BOTH the DEBIT reservation (created at
    // REQUESTED time) and the CREDIT release (created on reject/
    // mark-failed) — see createPayout / releaseReservation. So the
    // *total* count for a given id is naturally 2 after one successful
    // reject or mark-failed (1 DEBIT + 1 CREDIT), not 1. The invariant
    // this test actually cares about is narrower: a retried/duplicate
    // reject or mark-failed must never create a SECOND release CREDIT.
    // So we assert specifically on the CREDIT/release count instead of
    // the raw total.
    async function expectUnchanged(id, expectedStatus, walletBefore) {
      const row = await prisma.payoutRequest.findUnique({ where: { id } });
      expect(row.status).toBe(expectedStatus);
      const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance));
      const releaseCreditCount = await prisma.walletTransaction.count({ where: { refId: id, type: 'CREDIT' } });
      return releaseCreditCount;
    }

    // ---- Approve ----
    test('approve: REQUESTED -> APPROVED succeeds', async () => {
      const id = await freshRequested();
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/approve`).set('Authorization', admin.auth);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('APPROVED');
    });

    test('approve: retry on APPROVED is idempotent, no side effect', async () => {
      const id = await freshApproved();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const before = await prisma.payoutRequest.findUnique({ where: { id } });

      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/approve`).set('Authorization', admin.auth);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('APPROVED');

      const after = await prisma.payoutRequest.findUnique({ where: { id } });
      expect(after.approvedAt.getTime()).toBe(before.approvedAt.getTime()); // stamp not re-fired
      const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance));
    });

    test('approve: on REJECTED -> invalid transition (409), nothing changes', async () => {
      const id = await freshRejected();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/approve`).set('Authorization', admin.auth);
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'REJECTED', walletBefore);
    });

    test('approve: on PROCESSED -> invalid transition (409), nothing changes', async () => {
      const id = await freshProcessed();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/approve`).set('Authorization', admin.auth);
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'PROCESSED', walletBefore);
    });

    test('approve: on FAILED -> invalid transition (409), nothing changes', async () => {
      const id = await freshFailed();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/approve`).set('Authorization', admin.auth);
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'FAILED', walletBefore);
    });

    // ---- Reject ----
    test('reject: retry on REJECTED is idempotent, no second credit', async () => {
      const id = await freshRejected();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/reject`).set('Authorization', admin.auth).send({});
      expect(res.status).toBe(200);
      const txCount = await expectUnchanged(id, 'REJECTED', walletBefore);
      expect(txCount).toBe(1); // only the original release credit — no second one
    });

    test('reject: on APPROVED -> invalid transition (409), nothing changes', async () => {
      const id = await freshApproved();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/reject`).set('Authorization', admin.auth).send({});
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'APPROVED', walletBefore);
    });

    test('reject: on PROCESSED -> invalid transition (409), nothing changes', async () => {
      const id = await freshProcessed();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/reject`).set('Authorization', admin.auth).send({});
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'PROCESSED', walletBefore);
    });

    test('reject: on FAILED -> invalid transition (409), nothing changes', async () => {
      const id = await freshFailed();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/reject`).set('Authorization', admin.auth).send({});
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'FAILED', walletBefore);
    });

    // ---- Mark Processed ----
    test('mark-processed: retry on PROCESSED is idempotent, no side effect', async () => {
      const id = await freshProcessed();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const before = await prisma.payoutRequest.findUnique({ where: { id } });

      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/mark-processed`).set('Authorization', admin.auth);
      expect(res.status).toBe(200);

      const after = await prisma.payoutRequest.findUnique({ where: { id } });
      expect(after.processedAt.getTime()).toBe(before.processedAt.getTime());
      const walletAfter = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance));

      // P2.8-C — idempotency: the repeated APPROVED->PROCESSED transition
      // above must NOT create a second Journal for the same
      // eventType/eventId (PAYOUT_PROCESSED, id).
      const processedJournals = await prisma.journal.findMany({ where: { eventType: 'PAYOUT_PROCESSED', eventId: id } });
      expect(processedJournals).toHaveLength(1);
    });

    test('mark-processed: on REQUESTED -> invalid transition (409), nothing changes', async () => {
      const id = await freshRequested();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/mark-processed`).set('Authorization', admin.auth);
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'REQUESTED', walletBefore);
    });

    test('mark-processed: on REJECTED -> invalid transition (409), nothing changes', async () => {
      const id = await freshRejected();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/mark-processed`).set('Authorization', admin.auth);
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'REJECTED', walletBefore);
    });

    test('mark-processed: on FAILED -> invalid transition (409), nothing changes', async () => {
      const id = await freshFailed();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/mark-processed`).set('Authorization', admin.auth);
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'FAILED', walletBefore);
    });

    // ---- Mark Failed ----
    test('mark-failed: retry on FAILED is idempotent, no second credit', async () => {
      const id = await freshFailed();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/mark-failed`).set('Authorization', admin.auth).send({});
      expect(res.status).toBe(200);
      const txCount = await expectUnchanged(id, 'FAILED', walletBefore);
      expect(txCount).toBe(1); // only the original release credit — no second one
    });

    test('mark-failed: on REJECTED -> invalid transition (409), nothing changes', async () => {
      const id = await freshRejected();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/mark-failed`).set('Authorization', admin.auth).send({});
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'REJECTED', walletBefore);
    });

    test('mark-failed: on PROCESSED -> invalid transition (409), nothing changes', async () => {
      const id = await freshProcessed();
      const walletBefore = await prisma.wallet.findUnique({ where: { userId: seller.user.id } });
      const res = await api.patch(`${PREFIX}/admin/payouts/${id}/mark-failed`).set('Authorization', admin.auth).send({});
      expect(res.status).toBe(409);
      await expectUnchanged(id, 'PROCESSED', walletBefore);
    });
  });

  test('a seller cannot reach any /admin/payouts endpoint', async () => {
    const created = await api.post(`${PREFIX}/payouts`).set('Authorization', seller.auth).send({ amount: 5000, ...validBank() });
    const id = created.body.data.id;

    const list = await api.get(`${PREFIX}/admin/payouts`).set('Authorization', seller.auth);
    expect(list.status).toBe(403);
    const approve = await api.patch(`${PREFIX}/admin/payouts/${id}/approve`).set('Authorization', seller.auth);
    expect(approve.status).toBe(403);
  });
});
