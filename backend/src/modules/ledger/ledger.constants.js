/**
 * P2.4 Phase 2 — Ledger Posting Service constants.
 *
 * Standalone module. Nothing here is imported by payments.service.js /
 * orders.service.js / payouts.service.js / payout-liabilities.service.js /
 * commission-rules yet — see ledger.service.js's module-level comment.
 */

// The fixed, well-known ownerId used for every PLATFORM_* Account
// (schema.prisma's Ledger — Double-Entry Foundation block, and the
// 20260811000000_ledger_foundation migration comment, both state this
// exact literal). Never a real User.id — there is no "platform user" row
// anywhere in this schema, and none should ever be fabricated to satisfy
// this field.
const PLATFORM_LEDGER_OWNER_ID = 'PLATFORM';

// Matches Account.currency / Journal.currency / LedgerEntry.currency's
// schema default and the Decimal(12,0) (whole-unit) column scale used
// throughout schema.prisma for every existing money column in this
// project (Order.total, Wallet.balance, Payment.amount, ...).
const LEDGER_CURRENCY = 'TMN';

// ─────────────────────────────────────────────────────────────────────────
// Event → account/leg mapping (schema.prisma calls this out as living in
// "the P2.2/P2.3 design decision document", referenced ~15 times across
// schema.prisma and the 20260811000000_ledger_foundation migration, e.g.
// "design doc §3", "§5", "§6", "§7 Decision 5", "§10", "§12.5").
//
// That document does not exist anywhere in this repository: not in the
// working tree, not in any commit on any branch (`git log --all
// --diff-filter=A --name-only` finds no design/*.md or similarly named
// file), not under backend/ or the repo root. Only README.md files exist,
// and neither mentions the ledger design.
//
// Per this phase's own instructions ("Do NOT invent business semantics if
// they are not established... STOP and report the ambiguity instead of
// guessing"), the concrete per-event debit/credit leg mapping
// (PAYMENT_CONFIRMED, SETTLEMENT, REFUND, PAYOUT_RESERVE, PAYOUT_RELEASE,
// PAYOUT_PROCESSED, LIABILITY_RECOVERY — including the explicitly-flagged
// open question of whether LIABILITY_RECOVERY draws from PLATFORM_CASH
// alone or also PLATFORM_REVENUE) is intentionally NOT defined here. See
// the final report for what is required to unblock this.
// ─────────────────────────────────────────────────────────────────────────

module.exports = {
  PLATFORM_LEDGER_OWNER_ID,
  LEDGER_CURRENCY,
};
