-- P2.9 Stage 2 — SellerPayoutLiability receivable-backing columns (Model C).
--
-- Purely additive migration. Adds two new nullable columns
-- (originalAmount, ledgerReceivableEntryId) plus their foreign key/index,
-- and one new unique index on seller_payout_liabilities. No existing
-- table, column, enum value, or row is touched or rewritten — same
-- nullable-additive, no-backfill shape as the
-- 20260813000000_payment_refund_origin_ledger_status migration's own
-- origin/ledgerStatus/refundId columns.
--
-- Depends on the 20260816000000_platform_receivable_owner_type migration
-- having already been deployed/committed (this file's own SQL does not
-- reference the new enum value directly — only application code does,
-- once both stages are live).
--
-- originalAmount:
--   The shortfall amount AT CREATION TIME, immutable thereafter — unlike
--   `amount`, which recoverSellerLiabilities' FIFO recovery decrements in
--   place as the current remaining balance. NULL for every existing row
--   (never backfilled — cannot be safely reconstructed after the fact,
--   same reasoning as PaymentRefund.origin/ledgerStatus). Required so a
--   GATEWAY refund's deferred REFUND Journal (posted at
--   markGatewayRefundProcessed confirmation time, arbitrarily later than
--   liability creation) can reconstruct the shortfall as it was AT REFUND
--   TIME even if partial recovery has already happened against it by
--   then.
--
-- ledgerReceivableEntryId:
--   Points at the exact LedgerEntry representing this liability's own
--   PLATFORM_RECEIVABLE DEBIT leg — deliberately a LedgerEntry reference,
--   not a Journal reference: PLATFORM_RECEIVABLE is a singleton platform
--   Account, and one PaymentRefund's REFUND Journal can contain multiple
--   PLATFORM_RECEIVABLE legs (one per shortfalling store), so a
--   Journal-level reference alone cannot disambiguate which leg belongs to
--   which liability whenever two shortfalls in the same refund share an
--   amount. NULL for every legacy/historical liability and for any
--   liability whose REFUND Journal has not been posted yet. ON DELETE
--   RESTRICT — same convention as every other FK into the ledger_entries/
--   journals tables in this schema (a LedgerEntry that any liability
--   points at can never be deleted out from under it); ledger_entries is
--   additionally insert-only at the DB layer regardless (see the
--   20260815000000_ledger_immutability_trigger migration), so this FK is
--   defense-in-depth, not the primary immutability guarantee.
--
-- @@unique([refundId, storeId]):
--   DB-enforced version of the "at most one shortfall liability per
--   (order, store) per refund" invariant that refundDeliveredOrder's Pass 2
--   already relies on implicitly. refundId is nullable — Postgres treats
--   every NULL as distinct under a standard unique index, so this never
--   constrains legacy liabilities (refundId IS NULL, created before P2.4's
--   refundId column, or otherwise not tied to a specific refund) against
--   each other. Required by P2.9's store-scoped Gateway reconstruction
--   (markGatewayRefundProcessed), which looks up exactly one liability per
--   (refundId, storeId) to recover that store's immutable originalAmount.

-- AlterTable
ALTER TABLE "seller_payout_liabilities" ADD COLUMN "originalAmount" DECIMAL(12,0);
ALTER TABLE "seller_payout_liabilities" ADD COLUMN "ledgerReceivableEntryId" TEXT;

-- CreateIndex
CREATE INDEX "seller_payout_liabilities_ledgerReceivableEntryId_idx" ON "seller_payout_liabilities"("ledgerReceivableEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "seller_payout_liabilities_refundId_storeId_key" ON "seller_payout_liabilities"("refundId", "storeId");

-- AddForeignKey
ALTER TABLE "seller_payout_liabilities" ADD CONSTRAINT "seller_payout_liabilities_ledgerReceivableEntryId_fkey" FOREIGN KEY ("ledgerReceivableEntryId") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
