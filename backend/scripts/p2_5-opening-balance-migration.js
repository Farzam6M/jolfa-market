/**
 * P2.5 Part B — Ledger Opening-Balance Migration.
 *
 * ============================================================================
 * SCOPE (per the P2.5 Part B decision gates explicitly answered by the
 * product owner for this run — see the "DECISION LOG" block below):
 * ============================================================================
 *
 *   - Opening-balance initialization ONLY. No Category-B historical event
 *     backfill (Decision 4: "Opening balances only"). Every eligible
 *     account's entire Wallet.balance at the fixed cutover instant becomes
 *     its single OPENING_BALANCE journal amount — there is no historical
 *     reconstruction step to net out first.
 *   - Role-changed / ambiguous-identity users (a single historical Wallet
 *     with both customer-side and seller-side activity) are SKIPPED
 *     entirely this run (Decision 1: "Skip role-changed users entirely this
 *     run — handle in a later phase"). No CUSTOMER_WALLET or SELLER_WALLET
 *     opening balance is posted for them, and no guess is made about how to
 *     split their balance. They are reported as unresolved.
 *   - PLATFORM_CASH is the approved balancing account for every opening
 *     balance journal (Decision 3). [P2.5 Part B correction] Direction:
 *     CREDIT the wallet account / DEBIT PLATFORM_CASH — matching this
 *     codebase's own established Account.balance convention (CREDIT
 *     increments, DEBIT decrements), not the DEBIT-wallet/CREDIT-cash
 *     wording an earlier revision copied literally from the P2.5 spec's
 *     illustrative example. See ledger.service.js#postOpeningBalance's own
 *     doc comment for the full explanation.
 *   - LedgerEventType.OPENING_BALANCE was added as the direct, necessary
 *     consequence of Decision 4's approved scope (Decision 2 was not asked
 *     separately — an opening-balance-only migration cannot exist without
 *     it; see the schema migration 20260814000000_ledger_opening_balance_event_type).
 *   - Decision 5 (SellerPayoutLiability's eventual Ledger representation) is
 *     explicitly OUT OF SCOPE / deferred (P2.5 spec §24 permits this).
 *     SellerPayoutLiability is not read, mutated, or reasoned about by this
 *     script at all — it remains authoritative for the outstanding
 *     liability exactly as it is today. This means a seller with an
 *     OUTSTANDING liability still gets an opening balance for their full
 *     current Wallet.balance (the liability is a separate, already-
 *     off-wallet fact — see schema.prisma's SellerPayoutLiability doc
 *     comment: the liability is the UNCOLLECTED remainder that never
 *     touched Wallet.balance in the first place, so there is nothing to net
 *     out of the wallet balance on account of it).
 *   - [P2.5 Part B correction] If the target Ledger account already has any
 *     activity from a non-OPENING_BALANCE event (i.e. real, already-posted
 *     P2.4-wired activity: payment, settlement, refund, payout, liability
 *     recovery), that account is SKIPPED and reported rather than posted
 *     to. A pre-migration read-only verification found the original
 *     implementation posted the full captured Wallet.balance unconditionally,
 *     which would double-count against any such pre-existing activity (the
 *     account key P2.5 targets — (ownerType, userId, currency) — is
 *     identical to what live P2.4 postings already use). Per the approved
 *     Decision-4 scope (opening balances only, no Category-B
 *     reconstruction), there is no way to compute a correct residual for
 *     such an account in this migration, so it is deferred rather than
 *     guessed at.
 *
 * ============================================================================
 * WHAT THIS SCRIPT DOES NOT DO (P2.5 spec §22, §26)
 * ============================================================================
 *   - Does not touch Wallet, WalletTransaction, Payment, Order, Settlement,
 *     PaymentRefund, PayoutRequest, or SellerPayoutLiability rows.
 *   - Does not change any live application read/write path. Wallet.balance
 *     remains the operational source of truth after this script runs.
 *   - Does not run, write, or invoke tests.
 *
 * ============================================================================
 * IDENTITY RESOLUTION (no guessing — P2.5 spec §3, §11, §13)
 * ============================================================================
 * For each Wallet row (one per User, Wallet.userId is @unique):
 *   - hasStore         = a Store row exists with sellerId = user.id
 *                         (provable via the Store.sellerId @unique FK — the
 *                         one-Store-per-seller invariant P2.5 Part A verified).
 *   - hasCustomerOrder = an Order row exists with userId = user.id
 *                         (provable via Order.userId — this user placed at
 *                         least one order as a customer).
 *
 *   hasStore && hasCustomerOrder   -> AMBIGUOUS. Skip (Decision 1).
 *   hasStore && !hasCustomerOrder  -> SELLER_WALLET.
 *   !hasStore && hasCustomerOrder  -> CUSTOMER_WALLET.
 *   !hasStore && !hasCustomerOrder -> NO_SIGNAL. Skip and report — the wallet
 *                                     has a balance (or not) but no provable
 *                                     evidence which owner type it represents
 *                                     (e.g. an admin/super-admin User row
 *                                     with a Wallet that was never a
 *                                     customer or seller). Fabricating an
 *                                     owner type here would be exactly the
 *                                     kind of guess §13 prohibits.
 *
 * Both hasStore and hasCustomerOrder are computed from the SAME cutover
 * snapshot transaction as the balance read (see CUTOVER SAFETY below), so
 * the identity classification cannot itself drift relative to the balance
 * being initialized.
 *
 * ============================================================================
 * CUTOVER SAFETY (P2.5 spec §18)
 * ============================================================================
 * Phase A of this script is a single **read-only** Prisma transaction opened
 * with Postgres SERIALIZABLE isolation. Because it is read-only, Postgres's
 * Serializable Snapshot Isolation gives it a consistent snapshot of the
 * database as of one instant without blocking concurrent writers (it can
 * only ever be the one that *would* fail on conflict, and a pure read
 * transaction never has a write to conflict with) — every Wallet.balance,
 * Store, and Order row this script reads is exactly as it stood at that one
 * instant. This is the mechanism required by P2.5 spec §18: "the fixed
 * cutover snapshot" is that transaction's snapshot, and `cutoverAt`
 * (captured as `new Date()` immediately inside it) is stamped as the
 * `Journal.createdAt` for every OPENING_BALANCE journal posted in Phase B,
 * regardless of when Phase B's individual small transactions actually run
 * (P2.5 spec §8.5 — one fixed timestamp for the whole batch).
 *
 * Phase B then posts opening-balance journals using the AMOUNTS CAPTURED IN
 * PHASE A, never re-reading Wallet.balance — this is what prevents the
 * exact drift scenario §18 warns against (read balance -> app activity
 * changes it -> post stale balance anyway). If Wallet.balance for a given
 * user changes between Phase A and Phase B (normal application activity
 * continuing during the migration), the OPENING_BALANCE journal still
 * correctly represents the balance AT THE CUTOVER INSTANT — reconciliation
 * (§19) is defined against that instant, not against "whenever Phase B
 * happened to run."
 *
 * OPERATIONAL NOTE (not a code concern, flagged per §18's own instruction to
 * report rather than silently assume): Phase A's snapshot read touches every
 * Wallet/Store/Order row and is read-only, so it is expected to be fast even
 * under load, but running this during a low-traffic window is still the
 * safer operational choice for a live financial database. This script does
 * not implement a maintenance-window lock — none exists in this codebase to
 * reuse, and inventing one would be exactly the kind of unrequested
 * architecture change §18/§22 prohibit.
 *
 * ============================================================================
 * IDEMPOTENCY & ATOMICITY (P2.5 spec §8.2, §16, §17)
 * ============================================================================
 * Phase B processes one account at a time, each in its own small Prisma
 * transaction: getOrCreateAccount (reuses the existing idempotent/race-safe
 * mechanism) + postOpeningBalance (reuses postJournal, idempotent on
 * (eventType, eventId) = ('OPENING_BALANCE', `OPENING_BALANCE:${account.id}`)).
 * Rerunning this script is always safe:
 *   - An account that already exists is reused, not recreated.
 *   - A journal that was already posted for that account is returned as an
 *     idempotent replay — no duplicate entries, no double balance mutation.
 *   - Nothing is ever partially committed: each account's account-create +
 *     journal-post either fully commits or fully rolls back together.
 * One account's failure never aborts another's processing (fail-closed PER
 * RECORD, not a single all-or-nothing migration — P2.5 spec §20/§21: an
 * operator must be able to see exactly what succeeded, what was skipped,
 * and what failed, and safely rerun just the remainder).
 *
 * ============================================================================
 * USAGE
 * ============================================================================
 *   node scripts/p2_5-opening-balance-migration.js
 *
 * Prints a JSON reconciliation/audit summary (P2.5 spec §19, §25) to stdout
 * and exits 0 on success (including when some records were skipped/
 * unresolved — that is expected, not a failure) or exits 1 only if the
 * script itself could not run to completion (e.g. lost DB connectivity).
 */

const { prisma } = require('../src/config/database');
const { Prisma } = require('@prisma/client');
const { getOrCreateAccount, postOpeningBalance } = require('../src/modules/ledger/ledger.service');
const { PLATFORM_LEDGER_OWNER_ID, LEDGER_CURRENCY } = require('../src/modules/ledger/ledger.constants');

/**
 * Phase A — capture the fixed cutover snapshot.
 * Read-only SERIALIZABLE transaction: every Wallet, plus enough Store/Order
 * existence information to classify identity, as of one consistent instant.
 */
async function captureCutoverSnapshot() {
  return prisma.$transaction(async (tx) => {
    const cutoverAt = new Date();

    const wallets = await tx.wallet.findMany({
      select: { id: true, userId: true, balance: true },
    });

    const sellerUserIds = new Set(
      (await tx.store.findMany({ select: { sellerId: true } })).map((s) => s.sellerId),
    );

    // Distinct userIds that have placed at least one order as a customer.
    const customerUserIds = new Set(
      (await tx.order.findMany({ distinct: ['userId'], select: { userId: true } })).map((o) => o.userId),
    );

    return { cutoverAt, wallets, sellerUserIds, customerUserIds };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}

/**
 * Classify one wallet's identity per the IDENTITY RESOLUTION rules above.
 * Returns one of: 'SELLER_WALLET' | 'CUSTOMER_WALLET' | 'AMBIGUOUS' | 'NO_SIGNAL'.
 */
function classifyOwnerType(userId, sellerUserIds, customerUserIds) {
  const hasStore = sellerUserIds.has(userId);
  const hasCustomerOrder = customerUserIds.has(userId);
  if (hasStore && hasCustomerOrder) return 'AMBIGUOUS';
  if (hasStore) return 'SELLER_WALLET';
  if (hasCustomerOrder) return 'CUSTOMER_WALLET';
  return 'NO_SIGNAL';
}

/**
 * Phase B — post one OPENING_BALANCE journal for one eligible wallet, using
 * the amount captured in Phase A (never re-read from Wallet here). Own
 * small transaction; safe to retry independently of every other wallet.
 *
 * [P2.5 Part B correction — Fix #2] Before posting, checks whether the
 * target account already has any LedgerEntry activity from an event type
 * OTHER than OPENING_BALANCE (i.e. real P2.4-wired live activity: payment,
 * settlement, refund, payout, liability recovery). If so, this is exactly
 * the double-counting risk the pre-migration verification identified —
 * P2.5's approved scope (Decision 4: opening balances only, no Category-B
 * reconstruction) means we cannot compute a correct residual for such an
 * account, so per the approved policy we SKIP it and report why, rather
 * than posting the full Wallet.balance on top of existing activity or
 * guessing at Wallet.balance - Account.balance. This check is scoped to
 * "any OTHER event type" specifically (not "any entry at all") so that an
 * account this same migration already initialized in a prior run is still
 * correctly recognized as an idempotent replay (via the eventType_eventId
 * lookup just above) rather than misreported as a conflict.
 */
async function postOpeningBalanceForWallet({
  userId, ownerType, amount, cutoverAt,
}) {
  return prisma.$transaction(async (tx) => {
    // Checked explicitly (rather than inferred from the returned row) so
    // the migration summary can report accountsCreated/accountsReused
    // accurately — getOrCreateAccount's return value alone doesn't reveal
    // which branch it took.
    const preexistingAccount = await tx.account.findUnique({
      where: { ownerType_ownerId_currency: { ownerType, ownerId: userId, currency: LEDGER_CURRENCY } },
    });

    const account = await getOrCreateAccount(tx, ownerType, userId, LEDGER_CURRENCY);
    const accountWasCreated = !preexistingAccount;

    // Idempotency guard is (eventType, eventId) inside postJournal itself,
    // but check first here too so a rerun's summary correctly reports
    // "already posted" instead of counting a replay as a fresh posting.
    const existingJournal = await tx.journal.findUnique({
      where: {
        eventType_eventId: {
          eventType: 'OPENING_BALANCE',
          eventId: `OPENING_BALANCE:${account.id}`,
        },
      },
    });
    if (existingJournal) {
      return {
        account, accountWasCreated, alreadyPosted: true, skipped: false,
      };
    }

    // Fix #2 — pre-existing Ledger activity from any event type other than
    // OPENING_BALANCE blocks posting here. Only meaningful for an account
    // that already existed (a brand-new account can't have prior entries).
    if (!accountWasCreated) {
      const priorActivityCount = await tx.ledgerEntry.count({
        where: {
          accountId: account.id,
          journal: { eventType: { not: 'OPENING_BALANCE' } },
        },
      });
      if (priorActivityCount > 0) {
        return {
          account,
          accountWasCreated,
          alreadyPosted: false,
          skipped: true,
          skipReason: 'EXISTING_LEDGER_ACTIVITY',
          priorActivityCount,
        };
      }
    }

    await postOpeningBalance(tx, {
      eventId: `OPENING_BALANCE:${account.id}`,
      ownerType,
      accountId: account.id,
      amount,
      cutoverAt,
      currency: LEDGER_CURRENCY,
    });

    return {
      account, accountWasCreated, alreadyPosted: false, skipped: false,
    };
  });
}

/**
 * Ensure the PLATFORM_CASH platform account exists up front (P2.5 spec
 * §10/Step 1) — not strictly required before Phase B (postOpeningBalance
 * calls getOrCreateAccount for it lazily anyway), but validating it
 * explicitly here surfaces a platform-account problem before touching any
 * wallet, matching Step 1 of the recommended migration order (§15).
 */
async function ensurePlatformAccounts() {
  return prisma.$transaction(async (tx) => {
    const platformCash = await getOrCreateAccount(tx, 'PLATFORM_CASH', PLATFORM_LEDGER_OWNER_ID, LEDGER_CURRENCY);
    return { platformCash };
  });
}

async function runMigration() {
  const summary = {
    cutoverAt: null,
    walletsConsidered: 0,
    accountsCreated: 0,
    accountsReused: 0,
    openingBalancesPosted: 0,
    openingBalancesAlreadyPosted: 0,
    zeroBalanceSkipped: 0,
    ambiguousRoleChangedSkipped: [],
    noSignalSkipped: [],
    existingLedgerActivitySkipped: [],
    failed: [],
    totalWalletBalanceIncluded: '0',
    totalOpeningBalancePosted: '0',
    categoryBEventsReconstructed: 0, // always 0 this run — Decision 4 scope
  };

  console.log('[P2.5] Step 1 — validating platform accounts...');
  await ensurePlatformAccounts();

  console.log('[P2.5] Step 2/3 — capturing fixed cutover snapshot (read-only, SERIALIZABLE)...');
  const {
    cutoverAt, wallets, sellerUserIds, customerUserIds,
  } = await captureCutoverSnapshot();
  summary.cutoverAt = cutoverAt.toISOString();
  summary.walletsConsidered = wallets.length;

  console.log(`[P2.5] Cutover instant: ${summary.cutoverAt}. ${wallets.length} wallet(s) to evaluate.`);

  let totalIncluded = new Prisma.Decimal(0);
  let totalPosted = new Prisma.Decimal(0);

  console.log('[P2.5] Step 4/6/7 — resolving identity and posting opening balances...');
  // Sequential, not Promise.all — deterministic, auditable order and no more
  // concurrent transactions against the DB than necessary, matching the
  // sequential-await style already used elsewhere in this codebase.
  // eslint-disable-next-line no-restricted-syntax
  for (const wallet of wallets) {
    const ownerType = classifyOwnerType(wallet.userId, sellerUserIds, customerUserIds);
    const balance = new Prisma.Decimal(wallet.balance);

    if (ownerType === 'AMBIGUOUS') {
      summary.ambiguousRoleChangedSkipped.push({
        userId: wallet.userId,
        walletId: wallet.id,
        balance: balance.toString(),
        reason: 'role-changed user (has both a Store and a customer Order history) — Decision 1: skipped this run',
      });
      // eslint-disable-next-line no-continue
      continue;
    }
    if (ownerType === 'NO_SIGNAL') {
      summary.noSignalSkipped.push({
        userId: wallet.userId,
        walletId: wallet.id,
        balance: balance.toString(),
        reason: 'no provable CUSTOMER_WALLET or SELLER_WALLET signal (no Store, no customer Order) — not guessed',
      });
      // eslint-disable-next-line no-continue
      continue;
    }

    totalIncluded = totalIncluded.plus(balance);

    if (balance.lessThan(0)) {
      summary.failed.push({
        userId: wallet.userId,
        walletId: wallet.id,
        balance: balance.toString(),
        reason: 'Wallet.balance is negative — refusing to post; requires manual investigation (fail-closed, §20)',
      });
      // eslint-disable-next-line no-continue
      continue;
    }

    if (balance.equals(0)) {
      summary.zeroBalanceSkipped += 1;
      // eslint-disable-next-line no-continue
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const {
        accountWasCreated, alreadyPosted, skipped, skipReason, priorActivityCount,
      } = await postOpeningBalanceForWallet({
        userId: wallet.userId,
        ownerType,
        amount: balance,
        cutoverAt,
      });

      if (skipped && skipReason === 'EXISTING_LEDGER_ACTIVITY') {
        summary.existingLedgerActivitySkipped.push({
          userId: wallet.userId,
          walletId: wallet.id,
          ownerType,
          balance: balance.toString(),
          priorActivityCount,
          reason: 'target Ledger account already has activity from a non-OPENING_BALANCE event (live P2.4 posting) — cannot safely compute a residual under the approved opening-balances-only scope; deferred to a later reconciliation/historical-backfill phase',
        });
        // eslint-disable-next-line no-continue
        continue;
      }

      if (alreadyPosted) {
        summary.openingBalancesAlreadyPosted += 1;
      } else {
        summary.openingBalancesPosted += 1;
        totalPosted = totalPosted.plus(balance);
      }

      if (accountWasCreated) {
        summary.accountsCreated += 1;
      } else {
        summary.accountsReused += 1;
      }
    } catch (err) {
      summary.failed.push({
        userId: wallet.userId,
        walletId: wallet.id,
        balance: balance.toString(),
        reason: `posting failed: ${err.message}`,
      });
    }
  }

  summary.totalWalletBalanceIncluded = totalIncluded.toString();
  summary.totalOpeningBalancePosted = totalPosted.toString();

  // P2.5 Part B correction §11 — top-level posted/skipped/failed rollup so
  // the summary is auditable at a glance without counting array lengths.
  summary.totals = {
    posted: summary.openingBalancesPosted,
    alreadyPosted: summary.openingBalancesAlreadyPosted,
    skipped: {
      ambiguous: summary.ambiguousRoleChangedSkipped.length,
      noSignal: summary.noSignalSkipped.length,
      existingLedgerActivity: summary.existingLedgerActivitySkipped.length,
      zeroBalance: summary.zeroBalanceSkipped,
    },
    failed: summary.failed.length,
  };

  console.log('[P2.5] Step 8/9 — reconciliation + summary.');
  console.log(JSON.stringify(summary, null, 2));

  return summary;
}

if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[P2.5] Migration aborted:', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { runMigration, classifyOwnerType };
