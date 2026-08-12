-- P2.4 — PaymentRefund origin + Ledger status + shortfall persistence.
--
-- Purely additive migration. Adds two new enums (PaymentRefundOrigin,
-- PaymentRefundLedgerStatus), one new enum VALUE on the existing
-- LedgerEventType enum (PAYMENT_REVERSED), two new nullable columns on
-- payment_refunds (origin, ledgerStatus), and one new nullable column +
-- foreign key + index on seller_payout_liabilities (refundId). No existing
-- table, column, enum value, or row is touched or rewritten — every payment
-- move here targets rows that do not exist until application code starts
-- writing them.
--
-- Why nullable: payment_refunds and seller_payout_liabilities already have
-- rows (created by every refund/shortfall before this migration). Their
-- origin/ledgerStatus/refundId cannot be safely reconstructed after the
-- fact (see payments.service.js#refundWallet/refundGateway and
-- orders.service.js#refundDeliveredOrder's own doc comments) — no backfill
-- is attempted here or anywhere in this change. Application code
-- (orders.service.js#markGatewayRefundProcessed) treats a NULL
-- origin/ledgerStatus as a legacy row and deliberately skips automated
-- Ledger posting for it rather than guessing.
--
-- payment_refunds.origin / ledgerStatus:
--   origin distinguishes PRE_DELIVERY_CANCELLATION (no settlement yet — the
--   eventual Ledger reversal is PAYMENT_REVERSED) from POST_DELIVERY_REFUND
--   (reverses already-posted settlement economics — REFUND). ledgerStatus
--   tracks whether a delivered-order refund's seller-wallet clawback fully
--   succeeded (POSTABLE) or left an uncollected shortfall (SHORTFALL_HELD —
--   see the paired seller_payout_liabilities.refundId column below), then
--   flips to POSTED once the corresponding Ledger journal is actually
--   posted. Both are required (NOT NULL, no default) on every *new*
--   PaymentRefund going forward — enforced in application code
--   (payments.service.js), not by a DB-level NOT NULL, precisely so this
--   migration never has to fabricate a value for the rows that already
--   exist.
--
-- seller_payout_liabilities.refundId:
--   Links a liability row back to the exact PaymentRefund whose seller
--   clawback shortfall produced it — orderId alone is ambiguous once an
--   order has multiple refunds, multiple stores, or partial refunds (see
--   orders.service.js#refundDeliveredOrder's doc comment). ON DELETE
--   SetNull (not RESTRICT, unlike every other FK in this schema): a
--   PaymentRefund is never deleted in practice, but this keeps a
--   liability's own lifecycle independent of its originating refund row
--   rather than ever blocking a future cleanup of the refund side.
--
-- LedgerEventType.PAYMENT_REVERSED:
--   The Ledger event for a PRE_DELIVERY_CANCELLATION reversal (DEBIT
--   PLATFORM_CASH / CREDIT CUSTOMER_WALLET for WALLET, DEBIT PLATFORM_CASH
--   / CREDIT PAYMENT_GATEWAY_CLEARING for GATEWAY — see
--   ledger.constants.js's EVENT_ACCOUNT_MAP.PAYMENT_REVERSED and
--   ledger.service.js#postPaymentReversed). Postgres requires a new enum
--   value to be added with ALTER TYPE ... ADD VALUE rather than recreating
--   the type, and (per Postgres's own restriction) a newly added enum
--   value cannot be used in the same transaction that adds it — this is
--   why this statement is isolated into its own migration file rather than
--   folded into an earlier one, and why Prisma runs each migration file in
--   its own transaction.

-- CreateEnum
CREATE TYPE "PaymentRefundOrigin" AS ENUM ('PRE_DELIVERY_CANCELLATION', 'POST_DELIVERY_REFUND');

-- CreateEnum
CREATE TYPE "PaymentRefundLedgerStatus" AS ENUM ('POSTABLE', 'SHORTFALL_HELD', 'POSTED');

-- AlterEnum
ALTER TYPE "LedgerEventType" ADD VALUE 'PAYMENT_REVERSED';

-- AlterTable
ALTER TABLE "payment_refunds" ADD COLUMN "origin" "PaymentRefundOrigin";
ALTER TABLE "payment_refunds" ADD COLUMN "ledgerStatus" "PaymentRefundLedgerStatus";

-- AlterTable
ALTER TABLE "seller_payout_liabilities" ADD COLUMN "refundId" TEXT;

-- CreateIndex
CREATE INDEX "seller_payout_liabilities_refundId_idx" ON "seller_payout_liabilities"("refundId");

-- AddForeignKey
ALTER TABLE "seller_payout_liabilities" ADD CONSTRAINT "seller_payout_liabilities_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "payment_refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
