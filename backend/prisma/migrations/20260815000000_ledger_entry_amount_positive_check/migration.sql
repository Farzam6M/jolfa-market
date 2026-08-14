-- P2.6 Step 1 — Database-level defense-in-depth for the ledger's
-- "amount is always positive" invariant (schema.prisma LedgerEntry.amount
-- comment, design doc §5). The service layer (postJournal) already rejects
-- zero/negative amounts before they reach the database; this migration adds
-- an equivalent CHECK constraint at the DB level so the invariant holds
-- even if it is ever bypassed at the application layer. No other column,
-- table, or business logic is touched.
ALTER TABLE "ledger_entries"
ADD CONSTRAINT "ledger_entries_amount_positive_check"
CHECK ("amount" > 0);
