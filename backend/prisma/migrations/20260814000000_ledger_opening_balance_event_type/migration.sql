-- P2.5 Part B — Decision Gate 2 (approved as a necessary consequence of the
-- approved opening-balance-only migration scope; see
-- scripts/p2_5-opening-balance-migration.js's header comment).
--
-- Adds a single new LedgerEventType value, OPENING_BALANCE, used exclusively
-- by the P2.5 opening-balance migration to initialize a CUSTOMER_WALLET /
-- SELLER_WALLET Ledger account from Wallet.balance at a fixed cutover
-- instant. No existing enum value is modified, removed, or reordered; no
-- other table or column is touched.
ALTER TYPE "LedgerEventType" ADD VALUE 'OPENING_BALANCE';
