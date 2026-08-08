-- Order Settlement (Seller Payout) — Phase 2.
--
-- Purely additive migration: adds one new table (order_item_settlements)
-- and its foreign keys/indexes. No existing table, column, or row is
-- touched — Order, OrderItem, Store, Wallet, WalletTransaction, and
-- CommissionRule are all left exactly as they are (this migration does not
-- alter the 20260809120000_commission_rules migration in any way).
--
-- One row is created per OrderItem, exactly once, at the moment
-- settleDeliveredOrder() (orders.service.js) observes the real
-- SENT -> DELIVERED transition for that item's order. "orderItemId" is
-- UNIQUE — that is the idempotency guarantee: a retried/duplicated
-- delivery confirmation can never insert a second settlement row (and
-- therefore can never credit a seller's wallet twice) for the same order
-- item.
--
-- commissionRate/grossAmount/commissionAmount/sellerEarning are SNAPSHOTS
-- taken at settlement time and never recomputed afterwards — a later edit
-- or deactivation of the CommissionRule that produced them has no effect
-- on historical settlements. commissionRuleId is kept only for audit
-- traceability (which rule fired) and is nullable with ON DELETE SET NULL
-- so deleting a CommissionRule row later can never take a historical
-- settlement's numbers, or the row itself, down with it.
--
-- orderItemId/orderId/storeId all use ON DELETE RESTRICT: a settled
-- OrderItem, Order, or Store can never be deleted out from under its
-- financial settlement record.

-- CreateTable
CREATE TABLE "order_item_settlements" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "commissionRate" DECIMAL(5,2) NOT NULL,
    "grossAmount" DECIMAL(12,0) NOT NULL,
    "commissionAmount" DECIMAL(12,0) NOT NULL,
    "sellerEarning" DECIMAL(12,0) NOT NULL,
    "commissionRuleId" TEXT,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_item_settlements_orderItemId_key" ON "order_item_settlements"("orderItemId");

-- CreateIndex
CREATE INDEX "order_item_settlements_orderId_idx" ON "order_item_settlements"("orderId");

-- CreateIndex
CREATE INDEX "order_item_settlements_storeId_idx" ON "order_item_settlements"("storeId");

-- CreateIndex
CREATE INDEX "order_item_settlements_commissionRuleId_idx" ON "order_item_settlements"("commissionRuleId");

-- AddForeignKey
ALTER TABLE "order_item_settlements" ADD CONSTRAINT "order_item_settlements_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_settlements" ADD CONSTRAINT "order_item_settlements_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_settlements" ADD CONSTRAINT "order_item_settlements_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_settlements" ADD CONSTRAINT "order_item_settlements_commissionRuleId_fkey" FOREIGN KEY ("commissionRuleId") REFERENCES "commission_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
