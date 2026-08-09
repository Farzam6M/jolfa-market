-- Seller Payout / Withdrawal — Phase 5.
--
-- Purely additive migration: adds one new enum (PayoutStatus) and one new
-- table (payout_requests) plus its foreign keys/indexes. No existing
-- table, column, enum value, or row is touched — Wallet, WalletTransaction,
-- Order, Payment, OrderItemSettlement, and PaymentRefund are all left
-- exactly as they were after 20260809140000_refund_cancellation.
--
-- payout_requests:
--   One row per seller withdrawal request. "idempotencyKey" is UNIQUE —
--   the DB-level guard that lets payouts.service.js#createPayout safely
--   no-op a duplicate/retried withdrawal request instead of reserving the
--   amount twice (same pattern as payment_refunds.idempotencyKey from
--   Phase 4). status starts REQUESTED, at which point `amount` has
--   already been atomically reserved (debited) out of the seller's
--   wallets.balance — see payouts.service.js#createPayout. REJECTED and
--   FAILED both return that reservation to the wallet; PROCESSED does
--   not (the money has genuinely left the platform by then).
--
--   Bank destination (bankAccountHolder/bankIban/bankCardNumber/bankName)
--   is stored as a point-in-time snapshot directly on this table per the
--   Phase 5 spec — no separate bank-account table exists yet.
--
--   approvedById/approvedAt are populated only on the REQUESTED->APPROVED
--   transition; processedById/processedAt only on APPROVED->PROCESSED.
--   REJECTED/FAILED intentionally leave both pairs untouched — who/when
--   performed those transitions is captured in admin_activity_logs
--   instead (same audit mechanism already used for product moderation,
--   seller deletion, commission-rule changes, etc.), so as not to
--   overload fields whose names imply a successful approval/processing.
--
-- All FKs use ON DELETE RESTRICT (matching the existing payment_refunds /
-- order_item_settlements convention): a User who has any payout request
-- (as seller, requester, approver, or processor) can never be hard-deleted
-- out from under its financial record.

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "payout_requests" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "amount" DECIMAL(12,0) NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "idempotencyKey" TEXT NOT NULL,
    "bankAccountHolder" TEXT NOT NULL,
    "bankIban" TEXT NOT NULL,
    "bankCardNumber" TEXT,
    "bankName" TEXT,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "processedById" TEXT,
    "processedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_requests_idempotencyKey_key" ON "payout_requests"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payout_requests_sellerId_idx" ON "payout_requests"("sellerId");

-- CreateIndex
CREATE INDEX "payout_requests_status_idx" ON "payout_requests"("status");

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
