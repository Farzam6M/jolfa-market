-- ============================================================================
-- P2.6 Step 2C — jolfa_app / jolfa_maintenance role & privilege provisioning
-- Database : jolfa_market   |   PostgreSQL 17   |   Run as: postgres
-- ============================================================================
-- This is an infrastructure/database-provisioning script, NOT a Prisma
-- migration. It should be executed manually against the real database by
-- the operator (via psql) and should NOT be run through `prisma migrate`.
--
-- SAFETY GUARANTEES OF THIS SCRIPT:
--   - Never DROPs a role, table, or privilege belonging to any role other
--     than jolfa_app / jolfa_maintenance.
--   - Never touches the postgres superuser role.
--   - Never touches application data.
--   - CREATE ROLE only fires if the role does not already exist. If it
--     already exists, only its required attributes are (re)asserted via
--     ALTER ROLE — its password is never touched.
--   - Passwords are placeholders. Replace <APP_PASSWORD> / <MAINTENANCE_
--     PASSWORD> with real values at execution time; do not commit real
--     values to this file or any tracked file.
--
-- STOP CONDITION: run STEP 0 first. If jolfa_app or jolfa_maintenance
-- already exist with attributes/memberships that conflict with this
-- script's intent (e.g. either role is already SUPERUSER, already a
-- member of the other role, or jolfa_maintenance is already GRANTed to
-- jolfa_app), STOP and report the discrepancy — do not run STEP 1 onward.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 — PRE-FLIGHT INSPECTION (read the output before proceeding)
-- ----------------------------------------------------------------------------
SELECT current_user, session_user;

\du

SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
       rolbypassrls, rolcanlogin, rolinherit
FROM pg_roles
WHERE rolname IN ('jolfa_app', 'jolfa_maintenance');

SELECT member.rolname AS member, role.rolname AS granted_role
FROM pg_auth_members m
JOIN pg_roles role   ON role.oid   = m.roleid
JOIN pg_roles member ON member.oid = m.member
WHERE member.rolname IN ('jolfa_app', 'jolfa_maintenance')
   OR role.rolname   IN ('jolfa_app', 'jolfa_maintenance');


-- ----------------------------------------------------------------------------
-- STEP 1 — CREATE ROLES (idempotent; password set only on first creation)
-- ----------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jolfa_app') THEN
    CREATE ROLE jolfa_app
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      INHERIT
      PASSWORD '<APP_PASSWORD>';
  END IF;
END
$do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jolfa_maintenance') THEN
    CREATE ROLE jolfa_maintenance
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      PASSWORD '<MAINTENANCE_PASSWORD>';
  END IF;
END
$do$;


-- ----------------------------------------------------------------------------
-- STEP 2 — ENFORCE REQUIRED ATTRIBUTES
-- (idempotent, safe to re-run, never alters either role's password)
-- ----------------------------------------------------------------------------
ALTER ROLE jolfa_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;

ALTER ROLE jolfa_maintenance
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;


-- ----------------------------------------------------------------------------
-- STEP 3 — TRUST BOUNDARY: jolfa_app must never be able to SET ROLE
-- jolfa_maintenance. We never GRANT jolfa_maintenance TO jolfa_app, and this
-- REVOKE is a defensive no-op assertion in case that membership ever exists.
-- ----------------------------------------------------------------------------
REVOKE jolfa_maintenance FROM jolfa_app;


-- ----------------------------------------------------------------------------
-- STEP 4 — DATABASE / SCHEMA LEVEL PRIVILEGES
-- ----------------------------------------------------------------------------
-- PostgreSQL grants CONNECT on the database and USAGE+CREATE on the public
-- schema to PUBLIC by default. Tighten that first.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT CONNECT ON DATABASE jolfa_market TO jolfa_app;
GRANT CONNECT ON DATABASE jolfa_market TO jolfa_maintenance;

GRANT USAGE ON SCHEMA public TO jolfa_app;
GRANT USAGE ON SCHEMA public TO jolfa_maintenance;

-- Neither role may create objects in the schema. The application never
-- issues DDL at runtime (backend/src/config/database.js only opens a
-- standard PrismaClient connection); schema changes are applied by
-- `prisma migrate` under an admin/superuser connection, not jolfa_app.
REVOKE CREATE ON SCHEMA public FROM jolfa_app;
REVOKE CREATE ON SCHEMA public FROM jolfa_maintenance;

-- No sequence privileges are granted to either role: every model in
-- backend/prisma/schema.prisma uses `@id @default(uuid())` (a
-- client-generated, application-side UUID). There is no autoincrement()/
-- SERIAL column and no CREATE SEQUENCE statement in any migration under
-- backend/prisma/migrations, so no PostgreSQL sequence exists to grant on.


-- ----------------------------------------------------------------------------
-- STEP 5 — jolfa_app TABLE PRIVILEGES
-- ----------------------------------------------------------------------------
-- SELECT: every table is either queried directly by the app or traversed
-- via a Prisma `include` join, so a blanket read grant is the accurate
-- (not merely convenient) baseline. Write privileges below are scoped
-- per-table to exactly what backend/src code was found to execute.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO jolfa_app;

-- INSERT — tables the app creates rows in (direct .create()/.upsert(),
-- or nested Prisma relation writes such as Order{items:{create:[...]}}).
GRANT INSERT ON
  public.users,
  public.refresh_tokens,
  public.verification_tokens,
  public.otp_codes,
  public.addresses,
  public.stores,
  public.seller_applications,
  public.categories,
  public.products,
  public.store_products,
  public.product_images,
  public.wholesale_tiers,
  public.carts,
  public.cart_items,
  public.wishlist_items,
  public.reviews,
  public.orders,
  public.order_items,
  public.payments,
  public.wallets,
  public.wallet_transactions,
  public.commission_rules,
  public.order_item_settlements,
  public.payment_refunds,
  public.order_item_settlement_reversals,
  public.payout_requests,
  public.seller_payout_liabilities,
  public.ledger_accounts,
  public.journals,
  public.ledger_entries,
  public.support_conversations,
  public.support_messages,
  public.store_conversations,
  public.store_messages,
  public.notifications,
  public.notification_dismissals,
  public.notification_reads,
  public.hero_slides,
  public.admin_activity_log
TO jolfa_app;

-- UPDATE — tables the app mutates in place. journals and ledger_entries
-- are DELIBERATELY excluded (locked ledger boundary, Section 6/13).
GRANT UPDATE ON
  public.users,
  public.refresh_tokens,
  public.verification_tokens,
  public.otp_codes,
  public.addresses,
  public.stores,
  public.seller_applications,
  public.categories,
  public.products,
  public.store_products,
  public.cart_items,
  public.wishlist_items,
  public.reviews,
  public.orders,
  public.payments,
  public.wallets,
  public.commission_rules,
  public.payment_refunds,
  public.payout_requests,
  public.seller_payout_liabilities,
  public.ledger_accounts,
  public.support_conversations,
  public.store_conversations,
  public.notification_dismissals,
  public.notification_reads,
  public.hero_slides
TO jolfa_app;

-- DELETE — tables the app hard-deletes rows from. journals and
-- ledger_entries are DELIBERATELY excluded, and so is ledger_accounts
-- (no .account.delete()/.deleteMany() call exists anywhere in the
-- codebase — only findUnique/create/update, confirmed by inspection of
-- backend/src/modules/ledger/ledger.service.js).
GRANT DELETE ON
  public.users,
  public.addresses,
  public.stores,
  public.categories,
  public.products,
  public.store_products,
  public.product_images,
  public.wholesale_tiers,
  public.cart_items,
  public.wishlist_items,
  public.reviews,
  public.commission_rules,
  public.hero_slides
TO jolfa_app;

-- Defensive, explicit assertion of the locked ledger boundary — a no-op
-- given the grants above, but makes the invariant impossible to miss and
-- protects against any future accidental broad grant (e.g. a stray
-- `GRANT ALL ON ALL TABLES ...`) silently re-opening it.
REVOKE UPDATE, DELETE ON public.journals, public.ledger_entries FROM jolfa_app;
REVOKE DELETE ON public.ledger_accounts FROM jolfa_app;


-- ----------------------------------------------------------------------------
-- STEP 6 — jolfa_maintenance TABLE PRIVILEGES
-- ----------------------------------------------------------------------------
-- Only the two ledger tables, only SELECT + DELETE, for controlled
-- cleanup of ledger data. No UPDATE (no repository evidence requires it),
-- no INSERT, and no privileges on any other application table.
GRANT SELECT, DELETE ON public.journals TO jolfa_maintenance;
GRANT SELECT, DELETE ON public.ledger_entries TO jolfa_maintenance;


-- ============================================================================
-- END OF SCRIPT
-- ============================================================================
