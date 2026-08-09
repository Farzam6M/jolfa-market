-- Seller Payout Liability — Phase 5 MEDIUM finding fix (refund after
-- seller withdrawal).
--
-- Purely additive migration: adds one new enum (SellerLiabilityStatus) and
-- one new table (seller_payout_liabilities) plus its foreign keys/indexes.
-- No existing table, column, enum value, or row is touched — wallets,
-- wallet_transactions, orders, stores, users, payout_requests,
-- order_item_settlements, order_item_settlement_reversals, and
-- payment_refunds are all left exactly as they were after
-- 20260809150000_payout_requests.
--
-- seller_payout_liabilities:
--   One row per (order, store) shortfall recorded when
--   orders.service.js#refundDeliveredOrder cannot fully collect a refund
--   clawback from a seller's wallet (typically because the seller already
--   withdrew the money via a PayoutRequest). Rather than blocking the
--   customer's refund on that, refundDeliveredOrder collects whatever the
--   wallet currently holds (never driving wallets.balance negative) and
--   records the uncollected remainder here — append-only, same ledger
--   convention as order_item_settlements / order_item_settlement_reversals
--   / payment_refunds. status starts OUTSTANDING; the OUTSTANDING ->
--   RECOVERED transition (e.g. once reconciled against a future
--   settlement credit or payout) is intentionally NOT wired up by this
--   migration/fix — only the liability itself is made visible/auditable.
--
-- All FKs use ON DELETE RESTRICT (matching the existing payment_refunds /
-- order_item_settlements / payout_requests convention): a User, Order, or
-- Store that has any recorded liability can never be hard-deleted out from
-- under its financial record.

-- CreateEnum
CREATE TYPE "SellerLiabilityStatus" AS ENUM ('OUTSTANDING', 'RECOVERED');

-- CreateTable
CREATE TABLE "seller_payout_liabilities" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "amount" DECIMAL(12,0) NOT NULL,
    "status" "SellerLiabilityStatus" NOT NULL DEFAULT 'OUTSTANDING',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveredAt" TIMESTAMP(3),

    CONSTRAINT "seller_payout_liabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seller_payout_liabilities_sellerId_idx" ON "seller_payout_liabilities"("sellerId");

-- CreateIndex
CREATE INDEX "seller_payout_liabilities_orderId_idx" ON "seller_payout_liabilities"("orderId");

-- CreateIndex
CREATE INDEX "seller_payout_liabilities_status_idx" ON "seller_payout_liabilities"("status");

-- AddForeignKey
ALTER TABLE "seller_payout_liabilities" ADD CONSTRAINT "seller_payout_liabilities_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_payout_liabilities" ADD CONSTRAINT "seller_payout_liabilities_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_payout_liabilities" ADD CONSTRAINT "seller_payout_liabilities_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
