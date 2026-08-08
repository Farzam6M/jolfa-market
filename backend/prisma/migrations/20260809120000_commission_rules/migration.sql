-- Phase 1 — Commission Rule Foundation.
--
-- Purely additive migration: adds one new enum (CommissionScope) and one new
-- table (commission_rules). No existing table, column, or row is touched —
-- Wallet, WalletTransaction, Payment, Order, and OrderItem are all left
-- exactly as they are.
--
-- Commission is resolved dynamically at read-time by
-- commission-rules.service.js#resolveCommissionRate() from the rows in this
-- table (priority: CAMPAIGN > SELLER > CATEGORY > GLOBAL) — there is no
-- fixed/hardcoded commission rate anywhere in the application. The GLOBAL
-- default itself is a row here; the application layer guarantees at least
-- one active GLOBAL row always exists (see
-- assertNotRemovingLastActiveGlobal() in the service), but that invariant
-- is enforced in app code, not by a DB constraint, since Prisma/Postgres
-- can't easily express "at least one row matching X must always exist".
--
-- sellerId/categoryId are both nullable FKs (ON DELETE RESTRICT — a Store
-- or Category still referenced by a commission rule can't be deleted out
-- from under it). Note: an earlier version of this comment said this
-- mirrored the RESTRICT convention used for stores.mainCategoryId — that
-- column was already dropped by the 20260805222847_cleanup_schema_changes
-- migration before this one was written, so that reference was stale;
-- corrected here in-place since it does not affect the SQL actually run.
-- createdById is required and always taken from the
-- authenticated actor server-side (see commission-rules.service.js#create),
-- never from the request body.

-- CreateEnum
CREATE TYPE "CommissionScope" AS ENUM ('GLOBAL', 'SELLER', 'CATEGORY', 'CAMPAIGN');

-- CreateTable
CREATE TABLE "commission_rules" (
    "id" TEXT NOT NULL,
    "scope" "CommissionScope" NOT NULL,
    "sellerId" TEXT,
    "categoryId" TEXT,
    "campaignStartAt" TIMESTAMP(3),
    "campaignEndAt" TIMESTAMP(3),
    "rate" DECIMAL(5,2) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "commission_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commission_rules_scope_idx" ON "commission_rules"("scope");

-- CreateIndex
CREATE INDEX "commission_rules_sellerId_idx" ON "commission_rules"("sellerId");

-- CreateIndex
CREATE INDEX "commission_rules_categoryId_idx" ON "commission_rules"("categoryId");

-- CreateIndex
CREATE INDEX "commission_rules_isActive_idx" ON "commission_rules"("isActive");

-- CreateIndex
CREATE INDEX "commission_rules_scope_isActive_campaignStartAt_campaignEn_idx" ON "commission_rules"("scope", "isActive", "campaignStartAt", "campaignEndAt");

-- AddForeignKey
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;