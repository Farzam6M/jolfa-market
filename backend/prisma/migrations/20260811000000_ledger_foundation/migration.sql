-- P2.4 Phase 1 — Ledger Database Foundation.
--
-- Purely additive migration: adds four new enums (LedgerAccountOwnerType,
-- LedgerAccountStatus, LedgerDirection, LedgerEventType) and three new
-- tables (ledger_accounts, journals, ledger_entries) plus their indexes and
-- foreign keys. No existing table, column, enum value, or row is touched —
-- wallets, wallet_transactions, orders, payments, order_item_settlements,
-- order_item_settlement_reversals, payment_refunds, payout_requests, and
-- seller_payout_liabilities are all left exactly as they were after
-- 20260810120000_payout_liability_recovery_index.
--
-- This is a FOUNDATION-ONLY migration per the P2.2/P2.3 design decision
-- document: nothing in application code posts to these tables yet.
-- Wallet.balance and WalletTransaction remain the live, unchanged source of
-- truth. No Wallet data migration/split happens here.
--
-- ledger_accounts:
--   One row per (ownerType, ownerId, currency). ownerId is a plain TEXT
--   column, NOT a foreign key to users — this lets a single User eventually
--   hold two fully independent accounts (CUSTOMER_WALLET and SELLER_WALLET)
--   even though wallets.userId is UNIQUE today, and lets PLATFORM_* accounts
--   exist without ever requiring a fabricated User row (ownerId is the fixed
--   literal "PLATFORM" for those). "balance" is a cached/materialized column
--   defaulting to 0 — nothing in this migration or the current codebase ever
--   writes to it; it is reserved for a later phase's posting service.
--
-- journals:
--   One row per financial event. "eventId" is a plain TEXT column (not a
--   polymorphic FK — the referenced model differs per eventType).
--   (eventType, eventId) is UNIQUE — the actual idempotency guard against
--   duplicate postings, independent of whatever upstream idempotency
--   already exists on the source row (payment_refunds.idempotencyKey,
--   payout_requests.idempotencyKey, order_item_settlements.orderItemId,
--   ...). "actorId" is a plain nullable TEXT column, not a FK to users, so
--   this foundation migration does not have to define ON DELETE behavior
--   against users for a table nothing writes to yet.
--
-- ledger_entries:
--   One row per debit/credit leg. "amount" is always positive; "direction"
--   determines the accounting effect. Both journalId and accountId use ON
--   DELETE RESTRICT (matching the existing order_item_settlements /
--   payment_refunds / payout_requests / seller_payout_liabilities
--   convention in this project): a Journal or Account that has any
--   LedgerEntry can never be deleted out from under its financial record.

-- CreateEnum
CREATE TYPE "LedgerAccountOwnerType" AS ENUM ('CUSTOMER_WALLET', 'SELLER_WALLET', 'PLATFORM_REVENUE', 'PLATFORM_CASH', 'PAYMENT_GATEWAY_CLEARING', 'PAYOUT_CLEARING');

-- CreateEnum
CREATE TYPE "LedgerAccountStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerEventType" AS ENUM ('PAYMENT_CONFIRMED', 'SETTLEMENT', 'REFUND', 'PAYOUT_RESERVE', 'PAYOUT_RELEASE', 'PAYOUT_PROCESSED', 'LIABILITY_RECOVERY');

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "ownerType" "LedgerAccountOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TMN',
    "status" "LedgerAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "balance" DECIMAL(12,0) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journals" (
    "id" TEXT NOT NULL,
    "eventType" "LedgerEventType" NOT NULL,
    "eventId" TEXT NOT NULL,
    "actorId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'TMN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(12,0) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TMN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_accounts_ownerId_idx" ON "ledger_accounts"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_ownerType_ownerId_currency_key" ON "ledger_accounts"("ownerType", "ownerId", "currency");

-- CreateIndex
CREATE INDEX "journals_eventType_idx" ON "journals"("eventType");

-- CreateIndex
CREATE INDEX "journals_actorId_idx" ON "journals"("actorId");

-- CreateIndex
CREATE INDEX "journals_createdAt_idx" ON "journals"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "journals_eventType_eventId_key" ON "journals"("eventType", "eventId");

-- CreateIndex
CREATE INDEX "ledger_entries_accountId_createdAt_idx" ON "ledger_entries"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_journalId_idx" ON "ledger_entries"("journalId");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
