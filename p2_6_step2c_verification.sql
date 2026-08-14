-- ============================================================================
-- P2.6 Step 2C — Manual verification commands
-- Run these AFTER executing p2_6_step2c_roles_privileges.sql
-- ============================================================================

-- 1. Current administrative role (should be postgres, as verified pre-task)
SELECT current_user, session_user;

-- 2. All roles and their attributes
\du

-- 3. Role memberships (should return ZERO rows involving jolfa_app or
--    jolfa_maintenance — neither role should be a member of the other,
--    and neither should be a member of anything else)
SELECT
    member.rolname AS member,
    role.rolname AS granted_role
FROM pg_auth_members m
JOIN pg_roles role ON role.oid = m.roleid
JOIN pg_roles member ON member.oid = m.member;

-- 4. journals privileges (expect jolfa_app: SELECT, INSERT only;
--    jolfa_maintenance: SELECT, DELETE only)
\dp public.journals

-- 5. ledger_entries privileges (expect jolfa_app: SELECT, INSERT only;
--    jolfa_maintenance: SELECT, DELETE only)
\dp public.ledger_entries

-- 6. ledger_accounts privileges (expect jolfa_app: SELECT, INSERT, UPDATE
--    only — no DELETE; jolfa_maintenance: no privileges at all)
\dp public.ledger_accounts

-- 7. Verify jolfa_app cannot SET ROLE jolfa_maintenance.
--    Connect as jolfa_app specifically (NOT as postgres) and run:
--
--      psql -U jolfa_app -d jolfa_market
--      SET ROLE jolfa_maintenance;
--      -- Expected: ERROR:  permission denied to set role "jolfa_maintenance"
--
--    This must be run as jolfa_app itself — running SET ROLE as postgres
--    will always succeed (superuser bypasses the check) and would not be
--    a valid test.

-- 8. Verify attributes for both roles individually
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
       rolbypassrls, rolcanlogin, rolinherit
FROM pg_roles
WHERE rolname IN ('jolfa_app', 'jolfa_maintenance');

-- Additional spot-check: confirm jolfa_app has no write privilege of any
-- kind on journals/ledger_entries beyond INSERT, and none at all on
-- ledger_accounts beyond SELECT/INSERT/UPDATE.
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('journals', 'ledger_entries', 'ledger_accounts')
  AND grantee IN ('jolfa_app', 'jolfa_maintenance')
ORDER BY table_name, grantee, privilege_type;
