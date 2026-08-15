/**
 * P2.6 Step 2F — test-only maintenance Prisma client.
 *
 * TEST-ONLY. Do not import this from `src/`. It exists solely so ledger
 * test suites can route the handful of cleanup operations that require
 * the `jolfa_maintenance` role (DELETE on journals / ledger_entries /
 * ledger_accounts) through a connection that actually authenticates as
 * that role, instead of piggybacking on the shared application client
 * (`src/config/database.js`, which authenticates as `jolfa_app` and
 * intentionally has no DELETE on those tables).
 *
 * Reads its connection string from MAINTENANCE_DATABASE_URL — a separate
 * env var from DATABASE_URL — which must point at a Postgres user
 * authenticated as `jolfa_maintenance` (see
 * p2_6_step2f_maintenance_privilege_addendum.sql for the required grant,
 * and .env.example for how to set the variable locally). This module
 * never hardcodes a username/password.
 *
 * Lazily instantiated and cached (a single shared instance per test
 * process) so requiring this file from multiple test suites doesn't open
 * a new connection pool per file. Call disconnectMaintenanceClient() in
 * an `afterAll` to close it once the suite is done with it.
 */
const { PrismaClient } = require('@prisma/client');

let maintenanceClient = null;

/**
 * Returns the shared maintenance-scoped PrismaClient, creating it on
 * first use. Throws clearly if MAINTENANCE_DATABASE_URL is not set,
 * rather than silently falling back to DATABASE_URL/jolfa_app — falling
 * back would defeat the entire point of routing these calls through the
 * maintenance role.
 */
function getMaintenanceClient() {
  if (!process.env.MAINTENANCE_DATABASE_URL) {
    throw new Error(
      'MAINTENANCE_DATABASE_URL is not set. Ledger test cleanup requires a '
      + 'jolfa_maintenance-authenticated connection string for this '
      + 'variable — see .env.example. Refusing to fall back to '
      + 'DATABASE_URL (jolfa_app), which does not have DELETE on '
      + 'journals/ledger_entries/ledger_accounts by design.',
    );
  }
  if (!maintenanceClient) {
    maintenanceClient = new PrismaClient({
      datasources: { db: { url: process.env.MAINTENANCE_DATABASE_URL } },
      log: ['error'],
    });
  }
  return maintenanceClient;
}

/** Disconnects the shared maintenance client, if one was ever created. */
async function disconnectMaintenanceClient() {
  if (maintenanceClient) {
    await maintenanceClient.$disconnect();
    maintenanceClient = null;
  }
}

module.exports = { getMaintenanceClient, disconnectMaintenanceClient };
