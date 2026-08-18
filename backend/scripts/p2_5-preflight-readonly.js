/**
 * P2.5 — Read-Only Live Database Preflight.
 *
 * ============================================================================
 * PURPOSE
 * ============================================================================
 * Answers, without ever writing to the database: "if the real P2.5
 * opening-balance migration (scripts/p2_5-opening-balance-migration.js)
 * were run right now, which Wallets are eligible, and how many are
 * deferred by EXISTING_LEDGER_ACTIVITY, AMBIGUOUS, NO_SIGNAL, zero
 * balance, negative balance, or already-posted OPENING_BALANCE?"
 *
 * This script is completely independent of the real migration script — it
 * does not import or call runMigration(), postOpeningBalanceForWallet(),
 * postOpeningBalance(), or postJournal(). It only re-derives the SAME
 * classification rules read directly off the current repository (see the
 * "SOURCE OF TRUTH" comments on each rule below) using exclusively
 * read-only Prisma calls: findMany / findUnique / count. No create,
 * update, delete, upsert, executeRaw, or transaction-with-writes appears
 * anywhere in this file.
 *
 * It imports `classifyOwnerType` from the real migration script (a pure,
 * side-effect-free function — see that file) so ownership classification
 * is not duplicated/reimplemented; requiring that module does NOT run the
 * migration (it only executes if `require.main === module`, which is only
 * true when that file itself is run directly).
 *
 * ============================================================================
 * USAGE (run manually — this script never runs itself)
 * ============================================================================
 *   node scripts/p2_5-preflight-readonly.js
 *
 * Prints a JSON report to stdout, plus a short human-readable summary to
 * stderr (so `node scripts/p2_5-preflight-readonly.js > report.json` keeps
 * the JSON file clean). Exits 0 on success, exits 1 only if the database
 * connection itself fails (no DATABASE_URL, secrets, or other connection
 * details are ever printed).
 *
 * P2.10-A — this report is also persisted as a timestamped JSON file
 * under scripts/p2_5-evidence/ (git-ignored — see
 * scripts/lib/evidence-report.js and scripts/P2_5_OPENING_BALANCE.md),
 * stamped `mode: 'PREFLIGHT'` and a safe (host/port/database-name-only)
 * `databaseTarget`, so it can never be confused on disk with a real
 * scripts/p2_5-opening-balance-migration.js execution report.
 *
 * ============================================================================
 * PRIVACY
 * ============================================================================
 * Never reads or prints: DATABASE_URL, User.name, User.mobile, User.email,
 * addresses, or any other unrelated personal field. Per-wallet rows carry
 * only walletId / userId / accountId / ownerType / balances / counts /
 * status — the identifiers already necessary for financial reconciliation.
 */

const { prisma } = require('../src/config/database');
const { classifyOwnerType } = require('./p2_5-opening-balance-migration');
const { PLATFORM_LEDGER_OWNER_ID, LEDGER_CURRENCY } = require('../src/modules/ledger/ledger.constants');
const { getSafeDatabaseTarget, writeEvidenceReport } = require('./lib/evidence-report');

/**
 * SOURCE OF TRUTH: p2_5-opening-balance-migration.js's own
 * postOpeningBalanceForWallet() checks priorActivityCount via
 *   tx.ledgerEntry.count({ where: { accountId, journal: { eventType: { not: 'OPENING_BALANCE' } } } })
 * only for an account that already existed before that call. This
 * preflight reproduces the identical read (no `not: 'OPENING_BALANCE'`
 * filter change, same field path) as a plain read-only count.
 */
async function countNonOpeningBalanceEntries(accountId) {
  return prisma.ledgerEntry.count({
    where: { accountId, journal: { eventType: { not: 'OPENING_BALANCE' } } },
  });
}

/**
 * SOURCE OF TRUTH: p2_5-opening-balance-migration.js's
 * postOpeningBalanceForWallet() idempotency pre-check —
 *   tx.journal.findUnique({ where: { eventType_eventId: { eventType: 'OPENING_BALANCE', eventId: `OPENING_BALANCE:${account.id}` } } })
 */
async function findOpeningBalanceJournal(accountId) {
  return prisma.journal.findUnique({
    where: {
      eventType_eventId: { eventType: 'OPENING_BALANCE', eventId: `OPENING_BALANCE:${accountId}` },
    },
  });
}

/**
 * SOURCE OF TRUTH: ledger.service.js#getOrCreateAccount's lookup key —
 *   tx.account.findUnique({ where: { ownerType_ownerId_currency: { ownerType, ownerId, currency } } })
 * This preflight only ever looks the account up; it never creates one.
 */
async function findTargetAccount(ownerType, ownerId, currency) {
  return prisma.account.findUnique({
    where: { ownerType_ownerId_currency: { ownerType, ownerId, currency } },
  });
}

async function main() {
  // P2.10-A — evidence fields. `mode: 'EXECUTION'` is deliberately NEVER
  // used here — this script never writes financial state, and a fixed
  // 'PREFLIGHT' literal makes that unambiguous both in this JSON and in
  // the evidence filename written below, so a preflight run can never be
  // mistaken for (or claimed as) a real opening-balance execution.
  const report = {
    mode: 'PREFLIGHT',
    generatedAt: new Date().toISOString(),
    databaseTarget: getSafeDatabaseTarget(),
    databaseConnected: false,
    wallets: {
      total: 0, positive: 0, zero: 0, negative: 0,
    },
    classification: {
      customerWallet: 0, sellerWallet: 0, ambiguous: 0, noSignal: 0,
    },
    eligible: { customerWallet: 0, sellerWallet: 0 },
    targetAccounts: { existing: 0, missing: 0 },
    existingLedgerActivity: { accountsWithActivity: 0, accountsWithoutActivity: 0 },
    alreadyPostedOpeningBalance: 0,
    platformCash: {
      exists: false, accountId: null, ownerType: 'PLATFORM_CASH', ownerId: PLATFORM_LEDGER_OWNER_ID, currency: LEDGER_CURRENCY, balance: null, journalCount: 0, ledgerEntryCount: 0,
    },
    reconciliation: { safeCandidates: 0, existingActivityDeferred: 0, alreadyPosted: 0 },
    ambiguousWallets: [],
    noSignalWallets: [],
    negativeBalanceWallets: [],
    perWallet: [],
  };

  // ── 1. Database connectivity ──────────────────────────────────────────
  try {
    await prisma.$connect();
    report.databaseConnected = true;
  } catch (err) {
    // Deliberately no err.message/err details printed to stdout's JSON —
    // a Prisma connection error can embed the connection string. Only a
    // generic marker goes to stdout; a safe-to-print reason goes to
    // stderr only.
    process.stderr.write('[P2.5 Preflight] Database connection failed. Check your local DATABASE_URL / Postgres availability.\n');
    process.stdout.write(`${JSON.stringify({ databaseConnected: false }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  // ── 2. Wallet population (read-only) ────────────────────────────────
  const wallets = await prisma.wallet.findMany({ select: { id: true, userId: true, balance: true } });
  report.wallets.total = wallets.length;
  for (const w of wallets) {
    const balance = Number(w.balance);
    if (balance > 0) report.wallets.positive += 1;
    else if (balance === 0) report.wallets.zero += 1;
    else report.wallets.negative += 1;
  }

  // ── 3. Ownership classification (SOURCE OF TRUTH: same Store/Order
  //      existence signals as captureCutoverSnapshot() in the real
  //      migration script, read here as plain read-only queries; the
  //      classification itself uses the real classifyOwnerType function,
  //      not a reimplementation) ─────────────────────────────────────
  const sellerUserIds = new Set(
    (await prisma.store.findMany({ select: { sellerId: true } })).map((s) => s.sellerId),
  );
  const customerUserIds = new Set(
    (await prisma.order.findMany({ distinct: ['userId'], select: { userId: true } })).map((o) => o.userId),
  );

  // ── 4–9. Per-wallet eligibility, target-account existence, existing
  //         Ledger activity, and already-posted OPENING_BALANCE — SOURCE
  //         OF TRUTH: runMigration()'s own per-wallet loop order in
  //         p2_5-opening-balance-migration.js (AMBIGUOUS/NO_SIGNAL check
  //         first, then negative, then zero, then account/activity/
  //         idempotency lookup) ─────────────────────────────────────
  // eslint-disable-next-line no-restricted-syntax
  for (const wallet of wallets) {
    const ownerType = classifyOwnerType(wallet.userId, sellerUserIds, customerUserIds);
    const balance = Number(wallet.balance);

    if (ownerType === 'AMBIGUOUS') {
      report.classification.ambiguous += 1;
      report.ambiguousWallets.push({ walletId: wallet.id, userId: wallet.userId, balance: wallet.balance.toString() });
      // eslint-disable-next-line no-continue
      continue;
    }
    if (ownerType === 'NO_SIGNAL') {
      report.classification.noSignal += 1;
      report.noSignalWallets.push({ walletId: wallet.id, userId: wallet.userId, balance: wallet.balance.toString() });
      // eslint-disable-next-line no-continue
      continue;
    }
    if (ownerType === 'CUSTOMER_WALLET') report.classification.customerWallet += 1;
    if (ownerType === 'SELLER_WALLET') report.classification.sellerWallet += 1;

    if (balance < 0) {
      report.negativeBalanceWallets.push({
        walletId: wallet.id, userId: wallet.userId, ownerType, balance: wallet.balance.toString(),
      });
      // eslint-disable-next-line no-continue
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const account = await findTargetAccount(ownerType, wallet.userId, LEDGER_CURRENCY);

    const row = {
      walletId: wallet.id,
      userId: wallet.userId,
      ownerType,
      walletBalance: wallet.balance.toString(),
      accountExists: !!account,
      accountId: account ? account.id : null,
      accountBalance: account ? account.balance.toString() : null,
      priorNonOpeningLedgerEntryCount: 0,
      alreadyPostedOpeningBalance: false,
      status: null,
    };

    if (balance === 0) {
      row.status = 'ZERO_BALANCE_SKIPPED';
      report.perWallet.push(row);
      // eslint-disable-next-line no-continue
      continue;
    }

    if (ownerType === 'CUSTOMER_WALLET') report.eligible.customerWallet += 1;
    if (ownerType === 'SELLER_WALLET') report.eligible.sellerWallet += 1;

    if (account) {
      report.targetAccounts.existing += 1;
      // eslint-disable-next-line no-await-in-loop
      const priorActivityCount = await countNonOpeningBalanceEntries(account.id);
      row.priorNonOpeningLedgerEntryCount = priorActivityCount;

      if (priorActivityCount > 0) {
        report.existingLedgerActivity.accountsWithActivity += 1;
        row.status = 'DEFER_EXISTING_LEDGER_ACTIVITY';
        report.reconciliation.existingActivityDeferred += 1;
        report.perWallet.push(row);
        // eslint-disable-next-line no-continue
        continue;
      }
      report.existingLedgerActivity.accountsWithoutActivity += 1;

      // eslint-disable-next-line no-await-in-loop
      const openingJournal = await findOpeningBalanceJournal(account.id);
      if (openingJournal) {
        row.alreadyPostedOpeningBalance = true;
        row.openingJournalId = openingJournal.id;
        row.openingJournalCreatedAt = openingJournal.createdAt.toISOString();
        report.alreadyPostedOpeningBalance += 1;
        row.status = 'ALREADY_POSTED';
        report.reconciliation.alreadyPosted += 1;
        report.perWallet.push(row);
        // eslint-disable-next-line no-continue
        continue;
      }
    } else {
      report.targetAccounts.missing += 1;
    }

    row.status = 'SAFE_CANDIDATE';
    report.reconciliation.safeCandidates += 1;
    report.perWallet.push(row);
  }

  // ── 10. PLATFORM_CASH (SOURCE OF TRUTH: ledger.constants.js's
  //        PLATFORM_LEDGER_OWNER_ID = 'PLATFORM', LEDGER_CURRENCY =
  //        'TMN', and OPENING_BALANCE's own mapping —
  //        EVENT_ACCOUNT_MAP.OPENING_BALANCE.debitOwnerType ===
  //        'PLATFORM_CASH' — confirming this IS the correct balancing
  //        account to inspect for this migration) ──────────────────
  const platformCash = await findTargetAccount('PLATFORM_CASH', PLATFORM_LEDGER_OWNER_ID, LEDGER_CURRENCY);
  if (platformCash) {
    report.platformCash.exists = true;
    report.platformCash.accountId = platformCash.id;
    report.platformCash.balance = platformCash.balance.toString();
    report.platformCash.journalCount = await prisma.journal.count({
      where: { entries: { some: { accountId: platformCash.id } } },
    });
    report.platformCash.ledgerEntryCount = await prisma.ledgerEntry.count({
      where: { accountId: platformCash.id },
    });
  }

  // P2.10-A — durable local evidence, same mechanism and directory as the
  // real migration script's execution report (scripts/lib/evidence-report.js),
  // but stamped 'PREFLIGHT' and named accordingly — never mistakable for
  // an execution report on disk. A write failure here is reported to
  // stderr but does not change this script's exit code; it never wrote
  // to the database either way.
  try {
    const reportPath = writeEvidenceReport('p2_5-opening-balance-migration', 'PREFLIGHT', report);
    report.evidenceReportPath = reportPath;
    process.stderr.write(`[P2.5 Preflight] Evidence report written: ${reportPath}\n`);
  } catch (err) {
    process.stderr.write(`[P2.5 Preflight] WARNING: preflight completed but the evidence report could not be written: ${err.message}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  // Human-readable summary to stderr, so stdout stays clean JSON.
  process.stderr.write('\n[P2.5 Preflight] Summary\n');
  process.stderr.write(`  Database connected: ${report.databaseConnected}\n`);
  process.stderr.write(`  Wallets: total=${report.wallets.total} positive=${report.wallets.positive} zero=${report.wallets.zero} negative=${report.wallets.negative}\n`);
  process.stderr.write(`  Classification: CUSTOMER_WALLET=${report.classification.customerWallet} SELLER_WALLET=${report.classification.sellerWallet} AMBIGUOUS=${report.classification.ambiguous} NO_SIGNAL=${report.classification.noSignal}\n`);
  process.stderr.write(`  Eligible (pre zero/negative/activity filtering): CUSTOMER_WALLET=${report.eligible.customerWallet} SELLER_WALLET=${report.eligible.sellerWallet}\n`);
  process.stderr.write(`  Target accounts: existing=${report.targetAccounts.existing} missing=${report.targetAccounts.missing}\n`);
  process.stderr.write(`  Existing Ledger activity: accountsWithActivity=${report.existingLedgerActivity.accountsWithActivity} accountsWithoutActivity=${report.existingLedgerActivity.accountsWithoutActivity}\n`);
  process.stderr.write(`  Already posted OPENING_BALANCE: ${report.alreadyPostedOpeningBalance}\n`);
  process.stderr.write(`  PLATFORM_CASH: exists=${report.platformCash.exists} balance=${report.platformCash.balance} ledgerEntryCount=${report.platformCash.ledgerEntryCount}\n`);
  process.stderr.write(`  Reconciliation: safeCandidates=${report.reconciliation.safeCandidates} existingActivityDeferred=${report.reconciliation.existingActivityDeferred} alreadyPosted=${report.reconciliation.alreadyPosted}\n`);
  process.stderr.write(`  AMBIGUOUS wallets: ${report.ambiguousWallets.length} | NO_SIGNAL wallets: ${report.noSignalWallets.length} | negative-balance wallets: ${report.negativeBalanceWallets.length}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`[P2.5 Preflight] Unexpected error: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
