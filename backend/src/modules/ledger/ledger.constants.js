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
// PAYMENT_CONFIRMED is one exception: its mapping below was supplied
// directly by the product owner (DEBIT PAYMENT_GATEWAY_CLEARING / CREDIT
// PLATFORM_CASH), NOT derived from anything found in this repository — the
// only repo-native comment about PAYMENT_GATEWAY_CLEARING (schema.prisma)
// calls it "speculative ... no real gateway wired in yet" and does not
// itself tie it to PAYMENT_CONFIRMED. Recorded as given, not independently
// verified here.
//
// SETTLEMENT is the second exception, and unlike PAYMENT_CONFIRMED this one
// IS grounded in actual repo evidence: orders.service.js#settleDeliveredOrder
// (its own doc comment) computes, per OrderItem:
//   gross          = priceSnapshot * qty
//   commission     = round(gross * commissionRate / 100)
//   sellerEarning  = gross - commission
// and persists exactly those three numbers verbatim on OrderItemSettlement
// (schema.prisma's grossAmount/commissionAmount/sellerEarning columns —
// same names reused by postSettlement's parameters below, deliberately).
// The three-way DEBIT PLATFORM_CASH / CREDIT PLATFORM_REVENUE / CREDIT
// SELLER_WALLET split itself, and which owner types represent "commission"
// vs. "cash", was supplied by the product owner for this step — this
// repository does not itself name PLATFORM_CASH/PLATFORM_REVENUE/
// SELLER_WALLET as SETTLEMENT's specific legs anywhere (only their
// standalone LedgerAccountOwnerType doc comments: PLATFORM_REVENUE =
// "Commission accrual", SELLER_WALLET = "Funded by settlement earnings" —
// consistent with, but not the same as, a stated three-leg mapping for
// this specific event).
//
// The remaining five event types (REFUND, PAYOUT_RESERVE, PAYOUT_RELEASE,
// PAYOUT_PROCESSED, LIABILITY_RECOVERY — including the explicitly-flagged
// open question of whether LIABILITY_RECOVERY draws from PLATFORM_CASH
// alone or also PLATFORM_REVENUE) remain intentionally undefined pending
// their own decisions.
// ─────────────────────────────────────────────────────────────────────────
const EVENT_ACCOUNT_MAP = {
  PAYMENT_CONFIRMED: {
    debitOwnerType: 'PAYMENT_GATEWAY_CLEARING',
    creditOwnerType: 'PLATFORM_CASH',
  },
  SETTLEMENT: {
    debitOwnerType: 'PLATFORM_CASH',
    creditRevenueOwnerType: 'PLATFORM_REVENUE',
    creditSellerOwnerType: 'SELLER_WALLET',
  },
};

module.exports = {
  PLATFORM_LEDGER_OWNER_ID,
  LEDGER_CURRENCY,
  EVENT_ACCOUNT_MAP,
};
