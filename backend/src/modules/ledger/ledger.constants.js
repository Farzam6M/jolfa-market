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
// PAYOUT_RESERVE and PAYOUT_RELEASE (P2.4 Phase 2 Step 4) ARE grounded in
// actual repo evidence, unlike PAYMENT_CONFIRMED/SETTLEMENT's account
// *choice* above: payouts.service.js#createPayout (the REQUESTED step)
// atomically DEBITS the seller's real Wallet.balance by the reserved
// amount, and payouts.service.js#releaseReservation (called from both
// #rejectPayout and #markFailed) atomically CREDITS it straight back. This
// wrapper's SELLER_WALLET leg direction mirrors those real Wallet.balance
// mutations exactly (DEBIT on reserve, CREDIT on release). The paired
// PAYOUT_CLEARING leg's existence and purpose ("Reserved-but-not-yet-
// transferred seller payouts") is schema.prisma's own
// LedgerAccountOwnerType doc comment for that value, and its direction
// follows arithmetically from SELLER_WALLET's (a balanced 2-leg journal
// has exactly one DEBIT and one CREDIT of the same amount): CREDIT
// (increase) when a reservation is opened, DEBIT (decrease, back to 0)
// when it's released without transferring. eventId = PayoutRequest.id for
// both, per schema.prisma's Journal.eventId doc ("PAYOUT_RESERVE /
// PAYOUT_RELEASE / PAYOUT_PROCESSED are deliberately three separate
// values sharing what will be the same eventId (a PayoutRequest.id)").
//
// PAYOUT_PROCESSED (payouts.service.js#markProcessed, P2.4 Phase 2 Step 7)
// IS now included below. Step 4's audit found this genuinely unresolvable
// from repo evidence alone (see the phase report referenced from prior
// revisions of this comment) — markProcessed's own doc comment states
// plainly "No wallet movement — ... the money already left the seller's
// wallet at REQUESTED time", so unlike RESERVE/RELEASE there is no real
// Wallet.balance mutation to mirror, and the running-total-vs-"cash leaves
// the platform" ambiguity flagged then had no repo-internal way to
// resolve. The mapping below (DEBIT PAYOUT_CLEARING / CREDIT PLATFORM_CASH)
// was therefore supplied directly by the product owner for this step — same
// "explicitly approved, not repo-derived" tier as PAYMENT_CONFIRMED/
// SETTLEMENT's account choice above, not the fully repo-derived tier of
// PAYOUT_RESERVE/PAYOUT_RELEASE/REFUND. It does satisfy the one thing repo
// evidence did support: PAYOUT_CLEARING closing back toward 0 (DEBIT) when
// a reservation is finally transferred rather than released, continuing on
// from PAYOUT_RESERVE's CREDIT for the same amount.
//
// LIABILITY_RECOVERY (payout-liabilities.service.js#recoverSellerLiabilities,
// called from orders.service.js#settleDeliveredOrder before that
// settlement's own wallet credit) is also NOT included below — this is
// the "explicitly-flagged open question" already anticipated in this
// comment's previous revision: whether the recovered amount (which never
// actually reaches the seller's wallet — see that function's own "no
// gross credit-then-debit" note) should be recognized as PLATFORM_CASH,
// PLATFORM_REVENUE, or a split of the two is not stated anywhere in this
// repository (grepped for every relevant term across the whole backend/
// tree — only the ledger module and schema.prisma itself mention these
// owner types). Guessing was avoided; see the accompanying phase report.
//
// REFUND (P2.4 Phase 2 Step 5) IS grounded in actual repo evidence, same
// tier as PAYOUT_RESERVE/PAYOUT_RELEASE above — not merely "the product
// owner picked these three account types" but each leg's direction
// mirroring a real mutation or a real doc comment elsewhere in this repo:
//   - CUSTOMER_WALLET's own LedgerAccountOwnerType doc comment (schema.
//     prisma) says verbatim "Funded by PaymentRefund credits" — i.e. a
//     CREDIT (increase), which is exactly what orders.service.js#
//     refundDeliveredOrder's customer-side leg does (refundWallet/
//     refundGateway posting `totalCustomerRefund` back to the customer).
//   - SELLER_WALLET's DEBIT mirrors refundDeliveredOrder's own real
//     Wallet.balance mutation for the *no-shortfall* path exactly: its
//     Pass 2 loop does `tx.wallet.updateMany({ data: { balance:
//     { decrement: amount } } } })` per seller for the full clawback
//     amount whenever the wallet can cover it (the `debited.count === 1`
//     fast path) — a decrement, i.e. this wrapper's DEBIT direction
//     (DEBIT decrements Account.balance, same convention as every other
//     wrapper here). The shortfall/SellerPayoutLiability branch of that
//     same loop is explicitly NOT mirrored by this wrapper — see
//     postRefund's own doc comment.
//   - PLATFORM_REVENUE's DEBIT is the arithmetic reversal of SETTLEMENT's
//     CREDIT PLATFORM_REVENUE above for the same commissionAmount: this
//     repo's own OrderItemSettlementReversal model (schema.prisma) stores
//     `refundedCommissionAmount` as a reversal of the original
//     OrderItemSettlement.commissionAmount, and refundDeliveredOrder's own
//     formula derives refundedCommissionAmount as the same proportional
//     split of refundedGrossAmount that settleDeliveredOrder used forward
//     — so reversing SETTLEMENT's CREDIT direction with a DEBIT here is
//     the direct double-entry undo of that original posting, not a fresh
//     account-choice decision.
// PLATFORM_CASH deliberately does NOT appear in this mapping: unlike
// SETTLEMENT (which moves gross cash from PLATFORM_CASH out to
// PLATFORM_REVENUE/SELLER_WALLET), refundDeliveredOrder never touches any
// PLATFORM_CASH-equivalent balance — the customer-side leg is a Wallet
// credit (refundWallet) or a gateway-pending PaymentRefund row
// (refundGateway) with no PAYMENT_GATEWAY_CLEARING-mirroring code path in
// this phase, and this wrapper only implements the no-shortfall case (see
// postRefund's own doc comment for why the shortfall/SellerPayoutLiability
// path — which also touches no PLATFORM_CASH-equivalent balance — is out
// of scope here too). Introducing a PLATFORM_CASH leg would require
// inventing a mutation this repo's real refund code never performs.
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
  PAYOUT_RESERVE: {
    debitOwnerType: 'SELLER_WALLET',
    creditOwnerType: 'PAYOUT_CLEARING',
  },
  PAYOUT_RELEASE: {
    debitOwnerType: 'PAYOUT_CLEARING',
    creditOwnerType: 'SELLER_WALLET',
  },
  PAYOUT_PROCESSED: {
    debitOwnerType: 'PAYOUT_CLEARING',
    creditOwnerType: 'PLATFORM_CASH',
  },
  REFUND: {
    creditCustomerOwnerType: 'CUSTOMER_WALLET',
    debitSellerOwnerType: 'SELLER_WALLET',
    debitRevenueOwnerType: 'PLATFORM_REVENUE',
  },
};

module.exports = {
  PLATFORM_LEDGER_OWNER_ID,
  LEDGER_CURRENCY,
  EVENT_ACCOUNT_MAP,
};
