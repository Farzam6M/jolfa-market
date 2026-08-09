-- Refund / Cancellation — Phase 4.
--
-- Purely additive migration: adds one new enum (RefundStatus) and two new
-- tables (payment_refunds, order_item_settlement_reversals) plus their
-- foreign keys/indexes. No existing table, column, enum value, or row is
-- touched — Order, Payment, OrderItem, OrderItemSettlement, Wallet, and
-- WalletTransaction are all left exactly as they were after
-- 20260809130000_order_item_settlements.
--
-- payment_refunds:
--   One row per refund attempt against a Payment. "idempotencyKey" is
--   UNIQUE — the DB-level guard that lets refundWallet()/refundGateway()
--   (payments.service.js) safely no-op a duplicate/retried refund request
--   instead of moving money twice. status starts REQUESTED and becomes
--   PROCESSED either immediately (WALLET — money moved synchronously) or
--   via the manual PATCH /admin/payment-refunds/:id/mark-processed
--   endpoint (GATEWAY — real charge reversal happens on the gateway's
--   side, outside this app).
--
-- order_item_settlement_reversals:
--   One row per (OrderItemSettlement, PaymentRefund) — a partial or full
--   reversal of that settlement's quantity. The original
--   order_item_settlements row is NEVER updated or deleted by a refund;
--   summing refundedQty here per settlementId is how "how much of this
--   item has already been refunded" is derived, so over-refund can be
--   detected without ever mutating the original sale record.
--
-- Both new FKs use ON DELETE RESTRICT (matching the existing
-- order_item_settlements convention): a Payment, Order, or
-- OrderItemSettlement that has a refund/reversal against it can never be
-- deleted out from under its financial record.

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "payment_refunds" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DECIMAL(12,0) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_settlement_reversals" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "refundedQty" INTEGER NOT NULL,
    "refundedGrossAmount" DECIMAL(12,0) NOT NULL,
    "refundedCommissionAmount" DECIMAL(12,0) NOT NULL,
    "refundedSellerEarning" DECIMAL(12,0) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_settlement_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_refunds_idempotencyKey_key" ON "payment_refunds"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_refunds_paymentId_idx" ON "payment_refunds"("paymentId");

-- CreateIndex
CREATE INDEX "payment_refunds_orderId_idx" ON "payment_refunds"("orderId");

-- CreateIndex
CREATE INDEX "order_item_settlement_reversals_settlementId_idx" ON "order_item_settlement_reversals"("settlementId");

-- CreateIndex
CREATE INDEX "order_item_settlement_reversals_refundId_idx" ON "order_item_settlement_reversals"("refundId");

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_settlement_reversals" ADD CONSTRAINT "order_item_settlement_reversals_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "order_item_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_settlement_reversals" ADD CONSTRAINT "order_item_settlement_reversals_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "payment_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
