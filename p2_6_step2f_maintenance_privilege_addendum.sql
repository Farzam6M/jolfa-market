-- ============================================================================
-- P2.6 Step 2F — jolfa_maintenance privilege addendum
-- Database : jolfa_market   |   PostgreSQL 17   |   Run as: postgres
-- ============================================================================
-- This is a small, targeted ADDENDUM to the already-executed Step 2C
-- provisioning script (p2_6_step2c_roles_privileges.sql). It does NOT edit
-- that file in place — Step 2C is a historical, already-run artifact and
-- must not be silently rewritten. This addendum must be executed manually,
-- separately, by an administrative PostgreSQL connection. It is NOT a
-- Prisma migration and must NOT be run through `prisma migrate`.
--
-- WHY THIS IS NEEDED:
-- Step 2F audit found that tests/ledger/ledger.service.test.js and
-- tests/ledger/p2_5-opening-balance.test.js both clean up test-created
-- rows in `ledger_accounts` (via Prisma's `account.deleteMany(...)`,
-- since the `Account` model maps to `ledger_accounts`). jolfa_app
-- intentionally has no DELETE on ledger_accounts (Step 2C, Section 5 —
-- no `.account.delete()`/`.deleteMany()` call exists anywhere in
-- production `src/` code), and that must stay true. jolfa_maintenance
-- already has SELECT + DELETE on journals and ledger_entries (Step 2C,
-- Section 6) for exactly this kind of controlled cleanup, but was never
-- granted the same on ledger_accounts. This addendum closes that one gap.
--
-- SCOPE: this grant ONLY affects jolfa_maintenance. jolfa_app receives no
-- new privileges here. No privilege on `orders` is touched or added for
-- any role — orders cleanup in the affected test file was reworked to not
-- require any new grant (see the P2.6 Step 2F implementation report).
--
-- SAFETY: purely additive (one GRANT statement). Idempotent — GRANT is
-- safe to re-run. Does not touch any role's login/password, any other
-- table's privileges, the ledger_immutability_guard trigger, or any
-- migration file.
-- ============================================================================

GRANT SELECT, DELETE
ON public.ledger_accounts
TO jolfa_maintenance;

-- ============================================================================
-- END OF ADDENDUM
-- ============================================================================
