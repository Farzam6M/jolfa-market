-- P2.6 Step 2D — Ledger Immutability Trigger.
--
-- Purely additive migration: adds one PL/pgSQL trigger function and two
-- BEFORE triggers (one on "journals", one on "ledger_entries"). No table,
-- column, enum, index, foreign key, Prisma model, existing migration, or
-- existing role/privilege (from the P2.6 Step 2C
-- jolfa_app/jolfa_maintenance provisioning) is touched by this file.
--
-- ============================================================================
-- TRUST BOUNDARY — READ BEFORE MODIFYING
-- ============================================================================
-- Step 2C already prevents jolfa_app from issuing UPDATE/DELETE on journals
-- or ledger_entries at the GRANT level. This migration adds a SECOND,
-- independent layer directly at the table level via PostgreSQL triggers,
-- which — unlike GRANT/REVOKE — apply to EVERY role that can reach these
-- tables, including the "postgres" superuser connection. PostgreSQL trigger
-- execution is not exempted for superusers (that exemption only exists for
-- row-level security policies via BYPASSRLS, which is unrelated to
-- triggers), so this is a genuine database-enforced immutability guarantee,
-- not merely an app-role restriction.
--
-- Intended enforcement matrix (explicit product decision, not inferred):
--
--                         UPDATE                  DELETE
--   jolfa_app             BLOCKED (trigger+GRANT)  BLOCKED (trigger+GRANT)
--   jolfa_maintenance     BLOCKED (trigger)        ALLOWED (trigger exception)
--   postgres / any other  BLOCKED (trigger)        BLOCKED (trigger)
--
-- The ONLY bypass of any kind is: DELETE performed by a session whose
-- current_user is literally 'jolfa_maintenance'. There is no other bypass
-- path — specifically:
--   - No session-local GUC (e.g. no `SET LOCAL app.allow_ledger_mutation`).
--   - No environment-variable-driven behavior.
--   - No application-level flag, header, or role claim is consulted.
--   - No exemption for "postgres" or any other superuser/admin connection.
-- The check is `current_user = 'jolfa_maintenance'`, evaluated by Postgres
-- itself inside the trigger function at statement time — it cannot be
-- spoofed by anything the calling application sends, only by actually
-- authenticating as that role.
--
-- UPDATE is blocked unconditionally for every role, including
-- jolfa_maintenance itself — per explicit product decision, maintenance
-- access is DELETE-only (controlled cleanup), never row mutation, so
-- ledger history can only ever be removed wholesale by the maintenance
-- role, never silently altered by anyone.
-- ============================================================================
--
-- Idempotency: CREATE OR REPLACE FUNCTION is safe to re-run. Each CREATE
-- TRIGGER is preceded by a matching DROP TRIGGER IF EXISTS, so this file
-- can be re-applied without erroring on a partially-applied prior run.
--
-- Reversibility: this repo's migrations are forward-only (no Prisma "down"
-- migration convention is used anywhere in backend/prisma/migrations), so
-- no down-migration file is included here, matching every prior migration
-- in this project. The manual rollback SQL (DROP TRIGGER / DROP FUNCTION)
-- is documented in the accompanying Step 2D implementation report, not in
-- this file, and must be run manually if this trigger is ever reverted.

-- ----------------------------------------------------------------------------
-- Shared trigger function — one function, reused by both tables' triggers,
-- so the trust-boundary logic exists in exactly one place.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $ledger_immutability_guard$
BEGIN
  -- The ONLY permitted mutation of any kind on an immutable ledger table:
  -- a DELETE issued by a session authenticated as exactly 'jolfa_maintenance'.
  -- This is a real PostgreSQL role identity check (current_user), not a
  -- client-supplied flag, GUC, or environment value.
  IF TG_OP = 'DELETE' AND current_user = 'jolfa_maintenance' THEN
    RETURN OLD;
  END IF;

  -- Every other case is rejected — this includes:
  --   - UPDATE from any role whatsoever (jolfa_app, jolfa_maintenance,
  --     postgres, or any other role that might ever connect).
  --   - DELETE from any role other than jolfa_maintenance, explicitly
  --     including the postgres superuser / admin connection — per Step 2D
  --     decision, no role is exempted merely because it is privileged.
  RAISE EXCEPTION
    'Ledger immutability violation: % on %.% is not permitted for role "%". '
    'journals and ledger_entries are append-only; only jolfa_maintenance '
    'may DELETE, and no role may UPDATE.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
    USING ERRCODE = 'insufficient_privilege';
END;
$ledger_immutability_guard$;

COMMENT ON FUNCTION ledger_immutability_guard() IS
  'P2.6 Step 2D: enforces journals/ledger_entries append-only immutability '
  'at the database layer. Allows DELETE only for current_user = '
  '''jolfa_maintenance''; blocks UPDATE unconditionally for every role, '
  'including postgres. No GUC, env var, or application-level bypass exists.';

-- ----------------------------------------------------------------------------
-- journals — attach the guard to UPDATE and DELETE.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_journals_immutability_guard ON journals;

CREATE TRIGGER trg_journals_immutability_guard
  BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW
  EXECUTE FUNCTION ledger_immutability_guard();

COMMENT ON TRIGGER trg_journals_immutability_guard ON journals IS
  'P2.6 Step 2D: blocks UPDATE/DELETE on journals for every role except an '
  'explicit jolfa_maintenance DELETE. See ledger_immutability_guard().';

-- ----------------------------------------------------------------------------
-- ledger_entries — attach the same guard to UPDATE and DELETE.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_ledger_entries_immutability_guard ON ledger_entries;

CREATE TRIGGER trg_ledger_entries_immutability_guard
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_immutability_guard();

COMMENT ON TRIGGER trg_ledger_entries_immutability_guard ON ledger_entries IS
  'P2.6 Step 2D: blocks UPDATE/DELETE on ledger_entries for every role '
  'except an explicit jolfa_maintenance DELETE. See '
  'ledger_immutability_guard().';
