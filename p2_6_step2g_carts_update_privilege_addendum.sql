-- ============================================================================
-- P2.6 Step 2G — jolfa_app carts UPDATE privilege addendum
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
-- backend/src/modules/orders/orders.service.js executes a raw row lock
-- during checkout:
--
--     SELECT id FROM "carts" WHERE id = ... FOR UPDATE
--
-- PostgreSQL requires UPDATE privilege on a table to take a FOR UPDATE row
-- lock against it, even though the statement itself never modifies the
-- row. Step 2C (Section 5) granted jolfa_app SELECT and INSERT on
-- public.carts, but public.carts was omitted from the UPDATE grant list.
-- This causes checkout to fail with:
--
--     Code: 42501
--     ERROR: permission denied for table carts
--
-- SCOPE: this grant ONLY affects public.carts, and ONLY adds UPDATE for
-- jolfa_app. No other table or role is touched.
--
-- SAFETY: purely additive (one GRANT statement). Idempotent — GRANT is
-- safe to re-run. Does not touch any role's login/password, any other
-- table's privileges, or any migration file.
-- ============================================================================

GRANT UPDATE
ON public.carts
TO jolfa_app;

-- ============================================================================
-- END OF ADDENDUM
-- ============================================================================
