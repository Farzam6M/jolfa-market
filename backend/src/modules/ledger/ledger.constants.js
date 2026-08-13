/**
 * P2.4 Phase 2 — Ledger Posting Service constants.
 *
 * [P2.3 correction: this is not a standalone/unwired module.] These
 * constants are consumed by ledger.service.js's event wrappers, which are
 * themselves imported by payments.service.js, orders.service.js,
 * payouts.service.js, and payout-liabilities.service.js — see
 * ledger.service.js's module-level comment for the current wiring status
 * and known coverage gaps (WALLET payments, pre-delivery refunds).
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
// settlement's own wallet credit) — RESOLVED as of P2.4 Phase 2 Step 9/10.
// The previously open question ("PLATFORM_CASH vs PLATFORM_REVENUE vs a
// split of the two") is now decided: the recovered amount is recognized
// entirely as PLATFORM_CASH, not PLATFORM_REVENUE and not split. Reasoning
// (from the approved Step 9 design, not repo-derived — same "explicitly
// approved, not repo-derived" tier as PAYMENT_CONFIRMED/SETTLEMENT's
// account choice above): the seller's outstanding liability is being
// recovered from a future seller earning, so the recovered amount reduces
// the seller's effective wallet position and simply remains with the
// platform as cash — it is not newly earned commission, so
// PLATFORM_REVENUE would misstate it. This is a separate Ledger event
// with its own Journal — it is NOT folded into postSettlement, and
// postSettlement's own DEBIT PLATFORM_CASH / CREDIT PLATFORM_REVENUE +
// SELLER_WALLET formula (using the full, un-netted sellerEarning) is
// unchanged by this addition.
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
  LIABILITY_RECOVERY: {
    debitOwnerType: 'SELLER_WALLET',
    creditOwnerType: 'PLATFORM_CASH',
  },
  // P2.4 — PAYMENT_CONFIRMED for a WALLET payment. Deliberately a SEPARATE
  // mapping from PAYMENT_CONFIRMED above (which is GATEWAY-only, both legs
  // platform-owned): a WALLET payment never touches PAYMENT_GATEWAY_CLEARING
  // (no gateway is involved — the money already lived in the customer's own
  // Wallet.balance), so its Ledger mirror is DEBIT CUSTOMER_WALLET(customerId)
  // / CREDIT PLATFORM_CASH instead — mirroring payments.service.js#
  // payWithWallet's real Wallet.balance debit (a decrement) exactly, fully
  // repo-derived like PAYOUT_RESERVE/PAYOUT_RELEASE/REFUND above, not
  // supplied externally like PAYMENT_CONFIRMED/SETTLEMENT's account choice.
  // Both mappings post to the SAME LedgerEventType ('PAYMENT_CONFIRMED') —
  // eventId is Payment.id either way, and a WALLET Payment.id and a GATEWAY
  // Payment.id are always different rows, so no (eventType, eventId)
  // collision is possible between the two.
  PAYMENT_CONFIRMED_WALLET: {
    debitOwnerType: 'CUSTOMER_WALLET',
    creditOwnerType: 'PLATFORM_CASH',
  },
  // P2.4 — PAYMENT_REVERSED: the Ledger mirror of a PRE_DELIVERY_CANCELLATION
  // refund (payments.service.js#refundWallet/refundGateway's required
  // `origin` parameter) — i.e. a payment reversed before any settlement
  // ever happened, so unlike REFUND above there is no seller/commission
  // economics to reverse (see this file's own top-level comment and
  // orders.service.js#markGatewayRefundProcessed's origin-based branching).
  // Two sub-mappings, one per Payment.method this can apply to:
  //   WALLET:  DEBIT PLATFORM_CASH / CREDIT CUSTOMER_WALLET(customerId) —
  //            mirrors payments.service.js#refundWallet's real Wallet.balance
  //            credit (an increment) exactly, same fully-repo-derived tier
  //            as REFUND's CUSTOMER_WALLET leg above.
  //   GATEWAY: DEBIT PLATFORM_CASH / CREDIT PAYMENT_GATEWAY_CLEARING — both
  //            platform-owned, since a GATEWAY refund never touches any
  //            CUSTOMER_WALLET-equivalent balance (payments.service.js#
  //            refundGateway only records a REQUESTED PaymentRefund; no real
  //            gateway API is ever called in this codebase — see that
  //            function's own comment). Symmetric with PAYMENT_CONFIRMED's
  //            existing DEBIT PAYMENT_GATEWAY_CLEARING / CREDIT PLATFORM_CASH
  //            mapping above, reversed.
  // Neither sub-mapping ever involves SELLER_WALLET or PLATFORM_REVENUE —
  // deliberately, per the approved design: a pre-delivery cancellation has
  // no settlement to reverse.
  PAYMENT_REVERSED: {
    WALLET: {
      debitOwnerType: 'PLATFORM_CASH',
      creditOwnerType: 'CUSTOMER_WALLET',
    },
    GATEWAY: {
      debitOwnerType: 'PLATFORM_CASH',
      creditOwnerType: 'PAYMENT_GATEWAY_CLEARING',
    },
  },
  // P2.5 Part B — OPENING_BALANCE. Decision Gate 3 (approved): the
  // migration CREDITs the wallet account being initialized (increasing its
  // Ledger balance from 0 toward Wallet.balance at the cutover instant) and
  // DEBITs PLATFORM_CASH as the balancing counterpart — same direction
  // convention as every other wrapper in this codebase that adds funds to a
  // wallet (CREDIT increments, DEBIT decrements Account.balance; compare
  // postSettlement/postRefund, which also CREDIT the wallet they fund).
  // [P2.5 Part B correction] An earlier revision had this backwards (DEBIT
  // wallet / CREDIT PLATFORM_CASH), copied literally from the P2.5 spec's
  // illustrative wording without checking it against this codebase's own
  // convention — see postOpeningBalance's own doc comment for the full
  // explanation. `debitOwnerType` names PLATFORM_CASH here (the account
  // that is debited), mirroring the naming convention already used by
  // PAYOUT_PROCESSED/PAYMENT_REVERSED above where the platform-owned side
  // is named by its own direction. The wallet side's ownerType is
  // caller-supplied per account (CUSTOMER_WALLET or SELLER_WALLET — never
  // both for the same account), not fixed here, since a single migration
  // run touches accounts of both owner types. This is an
  // accounting-initialization mapping approved for the P2.5 migration
  // only — see scripts/p2_5-opening-balance-migration.js's header comment —
  // not a reconstruction of any real historical payment/settlement/refund
  // event.
  OPENING_BALANCE: {
    debitOwnerType: 'PLATFORM_CASH',
  },
};

module.exports = {
  PLATFORM_LEDGER_OWNER_ID,
  LEDGER_CURRENCY,
  EVENT_ACCOUNT_MAP,
};
