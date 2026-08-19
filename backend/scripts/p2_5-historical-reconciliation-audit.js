/**
 * P2.5 Historical Reconciliation Audit — READ-ONLY.
 *
 * Companion to scripts/p2_5-preflight-readonly.js. Reuses the SAME
 * classifyOwnerType() from scripts/p2_5-opening-balance-migration.js (never
 * reimplemented), and only ever calls findMany / findUnique / count /
 * groupBy. No create / update / delete / upsert / executeRaw / $transaction
 * with writes appears anywhere in this file. It never imports or calls
 * runMigration() or postOpeningBalanceForWallet().
 *
 * Run from backend/:
 *   node ../p2_5-historical-reconciliation-audit.js > p2_5-audit-report.json
 *
 * Produces sections A–F of the P2.5 Historical Reconciliation Audit spec,
 * plus two sections added post-root-cause-fix:
 *   G — Account.balance vs signed SUM(LedgerEntry) for EVERY Account row
 *       (not just wallet-linked ones covered by Section A/E), split into
 *       platform vs non-platform, with exact mismatch amounts.
 *   H — total Journal/LedgerEntry counts and first/last Journal
 *       timestamps, for a quick sense of ledger volume and time span.
 * Prints JSON to stdout, progress to stderr.
 */

const path = require('path');
const { prisma } = require(path.join(process.cwd(), 'src/config/database'));
const { classifyOwnerType } = require(path.join(process.cwd(), 'scripts/p2_5-opening-balance-migration'));
const { PLATFORM_LEDGER_OWNER_ID, LEDGER_CURRENCY, EVENT_ACCOUNT_MAP } = require(path.join(process.cwd(), 'src/modules/ledger/ledger.constants'));

const PLATFORM_OWNER_TYPES = ['PLATFORM_CASH', 'PLATFORM_REVENUE', 'PLATFORM_RECEIVABLE', 'PAYOUT_CLEARING', 'PAYMENT_GATEWAY_CLEARING'];

// eventType -> how to trace eventId back to a real domain record.
async function traceEvent(eventType, eventId) {
  try {
    switch (eventType) {
      case 'PAYMENT_CONFIRMED':
      case 'PAYMENT_CONFIRMED_WALLET':
      case 'PAYMENT_REVERSED':
        return { model: 'Payment', record: await prisma.payment.findUnique({ where: { id: eventId } }) };
      case 'SETTLEMENT':
        return { model: 'OrderItemSettlement', record: await prisma.orderItemSettlement.findUnique({ where: { id: eventId }, include: { orderItem: true } }) };
      case 'REFUND':
        return { model: 'PaymentRefund', record: await prisma.paymentRefund.findUnique({ where: { id: eventId } }) };
      case 'PAYOUT_RESERVE':
      case 'PAYOUT_RELEASE':
      case 'PAYOUT_PROCESSED':
        return { model: 'PayoutRequest', record: await prisma.payoutRequest.findUnique({ where: { id: eventId } }) };
      case 'LIABILITY_RECOVERY':
      case 'LIABILITY_RECOVERY_RECEIVABLE_BACKED':
        return { model: 'SellerPayoutLiability', record: await prisma.sellerPayoutLiability.findUnique({ where: { id: eventId } }) };
      case 'OPENING_BALANCE':
        return { model: 'Account', note: 'eventId is `OPENING_BALANCE:<accountId>`, not a foreign row.' };
      default:
        return { model: null, note: `Unrecognized eventType '${eventType}' — not in EVENT_ACCOUNT_MAP.` };
    }
  } catch (err) {
    return { model: null, error: err.message };
  }
}

async function fullJournalTrace(accountId) {
  const entries = await prisma.ledgerEntry.findMany({
    where: { accountId },
    include: { journal: { include: { entries: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const seenJournals = new Map();
  for (const e of entries) if (!seenJournals.has(e.journalId)) seenJournals.set(e.journalId, e.journal);

  const journals = [];
  for (const [, journal] of seenJournals) {
    const debitTotal = journal.entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + Number(e.amount), 0);
    const creditTotal = journal.entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + Number(e.amount), 0);
    // eslint-disable-next-line no-await-in-loop
    const trace = await traceEvent(journal.eventType, journal.eventId);
    journals.push({
      journalId: journal.id,
      eventType: journal.eventType,
      eventId: journal.eventId,
      actorId: journal.actorId,
      createdAt: journal.createdAt.toISOString(),
      balanced: debitTotal === creditTotal,
      debitTotal, creditTotal,
      entries: journal.entries.map((e) => ({
        entryId: e.id, accountId: e.accountId, direction: e.direction, amount: e.amount.toString(), createdAt: e.createdAt.toISOString(),
      })),
      relatedRecord: trace,
    });
  }
  return journals.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

// Evidence-based classification per spec Section B. Deliberately narrow:
// only claims a category when the traced record + timestamps support it;
// otherwise returns UNKNOWN_REQUIRES_HUMAN_DECISION with the reason.
function classifyDiscrepancy({ walletBalance, accountBalance, journals }) {
  const diff = Number(walletBalance) - Number(accountBalance);
  if (diff === 0) return { category: 'EXPECTED_CONSISTENT', reason: 'Wallet.balance equals Ledger Account.balance exactly.' };
  if (journals.length === 0) {
    return { category: 'PRE_LEDGER_LEGACY_BALANCE', reason: 'Account exists but has zero Ledger entries — Wallet.balance predates any Ledger-wired event; cannot be explained by Ledger activity.' };
  }
  const unbalanced = journals.filter((j) => !j.balanced);
  if (unbalanced.length > 0) {
    return { category: 'POST_LEDGER_APPLICATION_BUG', reason: `${unbalanced.length} journal(s) for this account do not balance (debit != credit): ${unbalanced.map((j) => j.journalId).join(', ')}.` };
  }
  const untraced = journals.filter((j) => j.relatedRecord && !j.relatedRecord.record && !j.relatedRecord.note);
  if (untraced.length > 0) {
    return { category: 'UNKNOWN_REQUIRES_HUMAN_DECISION', reason: `${untraced.length} journal(s) reference a domain record (Payment/Settlement/Refund/Payout/Liability) that no longer exists — cannot verify amount independently.` };
  }
  return { category: 'UNKNOWN_REQUIRES_HUMAN_DECISION', reason: 'Ledger activity exists and is internally balanced, but the residual difference from Wallet.balance is not explained by any single traced event — needs a human to walk the full WalletTransaction history alongside this Journal history.' };
}

// ---- Section G: every Account, Account.balance vs signed SUM(LedgerEntry)
// -----------------------------------------------------------------------
// Global check — independent of Wallet ownership classification, unlike
// Section A/E above (which only walks wallet-linked CUSTOMER_WALLET/
// SELLER_WALLET accounts). Covers PLATFORM_* accounts, wallet accounts
// with no resolvable Wallet row, and any other Account row that exists.
// Read-only: findMany/groupBy only.
async function everyAccountReconciliation() {
  const accounts = await prisma.account.findMany();
  const sums = await prisma.ledgerEntry.groupBy({
    by: ['accountId', 'direction'],
    _sum: { amount: true },
  });
  const computedByAccount = new Map();
  for (const row of sums) {
    const prior = computedByAccount.get(row.accountId) || 0;
    const amt = Number(row._sum.amount || 0);
    computedByAccount.set(row.accountId, prior + (row.direction === 'CREDIT' ? amt : -amt));
  }

  const rows = accounts.map((a) => {
    const computed = computedByAccount.get(a.id) || 0;
    const stored = Number(a.balance);
    return {
      accountId: a.id,
      ownerType: a.ownerType,
      ownerId: a.ownerId,
      currency: a.currency,
      isPlatformAccount: PLATFORM_OWNER_TYPES.includes(a.ownerType),
      storedBalance: a.balance.toString(),
      computedFromEntries: computed,
      matches: stored === computed,
      mismatchAmount: stored === computed ? 0 : stored - computed,
    };
  });

  return {
    totalAccounts: rows.length,
    platformAccounts: rows.filter((r) => r.isPlatformAccount),
    nonPlatformAccounts: rows.filter((r) => !r.isPlatformAccount),
    mismatches: rows.filter((r) => !r.matches),
  };
}

// ---- Section H: Journal/LedgerEntry counts + timestamp span -----------
// Read-only: count/findFirst only.
async function journalLedgerEntryCounts() {
  const [journalCount, ledgerEntryCount, firstJournal, lastJournal] = await Promise.all([
    prisma.journal.count(),
    prisma.ledgerEntry.count(),
    prisma.journal.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true, eventType: true } }),
    prisma.journal.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, eventType: true } }),
  ]);
  return {
    journalCount,
    ledgerEntryCount,
    firstJournal: firstJournal ? { id: firstJournal.id, eventType: firstJournal.eventType, createdAt: firstJournal.createdAt.toISOString() } : null,
    lastJournal: lastJournal ? { id: lastJournal.id, eventType: lastJournal.eventType, createdAt: lastJournal.createdAt.toISOString() } : null,
  };
}

async function main() {
  const report = { generatedAt: new Date().toISOString(), mode: 'AUDIT_READ_ONLY' };
  await prisma.$connect();

  // ---- Section G + H: every-Account reconciliation and Journal/LedgerEntry
  // counts (independent of the wallet-scoped sections below) ------------
  report.sectionG_everyAccountReconciliation = await everyAccountReconciliation();
  report.sectionH_journalLedgerEntryCounts = await journalLedgerEntryCounts();

  // ---- Section A + B: DEFER_EXISTING_LEDGER_ACTIVITY accounts ----------
  const wallets = await prisma.wallet.findMany({ select: { id: true, userId: true, balance: true } });
  const sellerUserIds = new Set((await prisma.store.findMany({ select: { sellerId: true } })).map((s) => s.sellerId));
  const customerUserIds = new Set((await prisma.order.findMany({ distinct: ['userId'], select: { userId: true } })).map((o) => o.userId));

  const deferred = [];
  const reconciliation = [];
  for (const wallet of wallets) {
    const ownerType = classifyOwnerType(wallet.userId, sellerUserIds, customerUserIds);
    if (ownerType === 'AMBIGUOUS' || ownerType === 'NO_SIGNAL') continue;
    // eslint-disable-next-line no-await-in-loop
    const account = await prisma.account.findUnique({ where: { ownerType_ownerId_currency: { ownerType, ownerId: wallet.userId, currency: LEDGER_CURRENCY } } });
    if (!account) continue;
    // eslint-disable-next-line no-await-in-loop
    const priorActivity = await prisma.ledgerEntry.count({ where: { accountId: account.id, journal: { eventType: { not: 'OPENING_BALANCE' } } } });
    if (priorActivity === 0) continue; // not DEFER_EXISTING_LEDGER_ACTIVITY

    // eslint-disable-next-line no-await-in-loop
    const journals = await fullJournalTrace(account.id);
    const diff = Number(wallet.balance) - Number(account.balance);
    const classification = classifyDiscrepancy({ walletBalance: wallet.balance, accountBalance: account.balance, journals });

    deferred.push({
      walletId: wallet.id, userId: wallet.userId, ownerType,
      walletBalance: wallet.balance.toString(), accountId: account.id, accountBalance: account.balance.toString(),
      difference: diff, journals, classification,
    });
    reconciliation.push({
      walletId: wallet.id, userId: wallet.userId, ownerType,
      walletBalance: wallet.balance.toString(), ledgerBalance: account.balance.toString(), difference: diff,
      classification: classification.category,
      action: diff === 0 ? 'None — already consistent.' : 'Human review of traced journal history above before any Opening Balance or adjustment.',
    });
  }
  report.sectionA_deferredAccounts = deferred;
  report.sectionE_reconciliationTable = reconciliation;

  // ---- Section C: NO_SIGNAL wallets -------------------------------------
  const noSignal = [];
  for (const wallet of wallets) {
    const ownerType = classifyOwnerType(wallet.userId, sellerUserIds, customerUserIds);
    if (ownerType !== 'NO_SIGNAL') continue;
    // eslint-disable-next-line no-await-in-loop
    const [hasStore, orderCount, custAccount, sellerAccount] = await Promise.all([
      prisma.store.findFirst({ where: { sellerId: wallet.userId } }),
      prisma.order.count({ where: { userId: wallet.userId } }),
      prisma.account.findUnique({ where: { ownerType_ownerId_currency: { ownerType: 'CUSTOMER_WALLET', ownerId: wallet.userId, currency: LEDGER_CURRENCY } } }),
      prisma.account.findUnique({ where: { ownerType_ownerId_currency: { ownerType: 'SELLER_WALLET', ownerId: wallet.userId, currency: LEDGER_CURRENCY } } }),
    ]);
    const account = custAccount || sellerAccount;
    // eslint-disable-next-line no-await-in-loop
    const activity = account ? await prisma.ledgerEntry.count({ where: { accountId: account.id } }) : 0;
    noSignal.push({
      walletId: wallet.id, userId: wallet.userId, balance: wallet.balance.toString(),
      hasStore: !!hasStore, orderCount, otherOwnershipSignal: null,
      classification: 'NO_SIGNAL (no Store, no Order)',
      balanceZero: Number(wallet.balance) === 0,
      ledgerAccountExists: !!account, ledgerAccountHasActivity: activity > 0,
    });
  }
  report.sectionC_noSignalWallets = noSignal;

  // ---- Section D: Ledger integrity --------------------------------------
  const allJournals = await prisma.journal.findMany({ include: { entries: true } });
  const unbalancedJournals = allJournals.filter((j) => {
    const d = j.entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + Number(e.amount), 0);
    const c = j.entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + Number(e.amount), 0);
    return d !== c;
  });
  const journalsWithNoEntries = allJournals.filter((j) => j.entries.length === 0);

  const dupKey = {};
  const duplicates = [];
  for (const j of allJournals) {
    const key = `${j.eventType}::${j.eventId}`;
    if (dupKey[key]) duplicates.push({ eventType: j.eventType, eventId: j.eventId, journalIds: [dupKey[key], j.id] });
    else dupKey[key] = j.id;
  }

  const allEntries = await prisma.ledgerEntry.findMany({ select: { id: true, accountId: true, journalId: true } });
  const accountIds = new Set((await prisma.account.findMany({ select: { id: true } })).map((a) => a.id));
  const journalIds = new Set(allJournals.map((j) => j.id));
  const orphanEntries = allEntries.filter((e) => !accountIds.has(e.accountId) || !journalIds.has(e.journalId));

  const platformAccounts = {};
  for (const ownerType of PLATFORM_OWNER_TYPES) {
    // eslint-disable-next-line no-await-in-loop
    const acct = await prisma.account.findUnique({ where: { ownerType_ownerId_currency: { ownerType, ownerId: PLATFORM_LEDGER_OWNER_ID, currency: LEDGER_CURRENCY } } });
    if (!acct) { platformAccounts[ownerType] = { exists: false }; continue; }
    // eslint-disable-next-line no-await-in-loop
    const entries = await prisma.ledgerEntry.findMany({ where: { accountId: acct.id } });
    const computed = entries.reduce((s, e) => s + (e.direction === 'CREDIT' ? Number(e.amount) : -Number(e.amount)), 0);
    platformAccounts[ownerType] = {
      exists: true, accountId: acct.id, storedBalance: acct.balance.toString(),
      computedFromEntries: computed, matches: Number(acct.balance) === computed, entryCount: entries.length,
    };
  }

  report.sectionD_ledgerIntegrity = {
    totalJournals: allJournals.length,
    unbalancedJournals: unbalancedJournals.map((j) => j.id),
    journalsWithNoEntries: journalsWithNoEntries.map((j) => j.id),
    duplicateEventTypeEventId: duplicates,
    orphanLedgerEntries: orphanEntries.map((e) => e.id),
    platformAccounts,
  };

  // ---- Section F helper counts -------------------------------------------
  report.sectionF_summary = {
    deferredAccountsAudited: deferred.length,
    genuineMismatches: deferred.filter((d) => d.difference !== 0).length,
    expectedConsistent: deferred.filter((d) => d.classification.category === 'EXPECTED_CONSISTENT').length,
    unexplainedRequiringHumanDecision: deferred.filter((d) => d.classification.category === 'UNKNOWN_REQUIRES_HUMAN_DECISION').length,
    noSignalWalletsNonZero: noSignal.filter((w) => !w.balanceZero).length,
    ledgerIntegrityClean: unbalancedJournals.length === 0 && duplicates.length === 0 && orphanEntries.length === 0
      && Object.values(platformAccounts).every((a) => !a.exists || a.matches),
    everyAccountReconciliationClean: report.sectionG_everyAccountReconciliation.mismatches.length === 0,
    everyAccountMismatchCount: report.sectionG_everyAccountReconciliation.mismatches.length,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`Done. ${deferred.length} deferred accounts traced, ${noSignal.length} NO_SIGNAL wallets inspected.\n`);
}

main()
  .catch((err) => { process.stderr.write(`Audit error: ${err.stack}\n`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
