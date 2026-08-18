# P2.5 Opening-Balance — Execution & Evidence

## What it does

`p2_5-opening-balance-migration.js` gives every eligible `CUSTOMER_WALLET`/
`SELLER_WALLET` Ledger `Account` a one-time `OPENING_BALANCE` journal equal
to that user's real `Wallet.balance` at a single fixed cutover instant,
balanced against `PLATFORM_CASH`. It does **not** touch `Wallet`,
`WalletTransaction`, or any other business table — `Wallet.balance` stays
the operational source of truth. Ambiguous (role-changed), no-signal,
negative-balance, and accounts with pre-existing non-`OPENING_BALANCE`
Ledger activity are skipped and reported, never guessed at.

## It is NOT a Prisma migration

It is a standalone Node script under `backend/scripts/`. `prisma migrate
deploy` never runs it, and nothing in application startup does either —
this is a deliberate, explicit, one-time operational step run manually
against the target database.

## How to run it

```bash
# 1. Optional but recommended — read-only, writes nothing to the DB:
cd backend
DATABASE_URL="postgresql://..." node scripts/p2_5-preflight-readonly.js

# 2. The real execution:
DATABASE_URL="postgresql://..." node scripts/p2_5-opening-balance-migration.js
```

Both require the real `DATABASE_URL` for the target environment — there is
no default, no dry-run flag that skips the connection, and no way to run
either without it.

## Evidence

Both scripts persist their full JSON report as a timestamped file under
`backend/scripts/p2_5-evidence/` (git-ignored — reports may embed a
database host/port/name and are local-only, never committed):

- `p2_5-opening-balance-migration.execution.<timestamp>.json` — written
  only by the real migration script, always with `"mode": "EXECUTION"`.
- `p2_5-opening-balance-migration.preflight.<timestamp>.json` — written
  only by the read-only preflight script, always with
  `"mode": "PREFLIGHT"`.

The `mode` field and the filename both encode which kind of run produced
a given file — a preflight report can never be mistaken for proof that
the real migration executed. Each report also carries `generatedAt` and a
`databaseTarget` (`{ host, port, database }` only — never a username,
password, or the raw connection string) so a report can be tied to a
specific environment without exposing credentials.

## How to recognize a successful execution

Open the newest `*.execution.*.json` file (or check the script's stdout)
and confirm:

- `"mode": "EXECUTION"`
- `databaseTarget` matches the environment you intended to run against
- `totals.failed === 0` (any failures are listed individually under
  `failed`, per-wallet, with a reason — a non-empty `failed` array means
  some accounts still need manual attention, not that the whole run
  failed)
- `totals.posted` + `totals.alreadyPosted` + the `totals.skipped.*` counts
  together account for `walletsConsidered`

`totals.skipped.ambiguous`, `.noSignal`, and `.existingLedgerActivity`
being non-zero is expected and not a failure — those are the documented,
intentional P2.5 deferrals (see the script's own header comment).

## Idempotent re-execution

Re-running the migration script is always safe:

- An account that already exists is reused, never recreated.
- A wallet whose `OPENING_BALANCE` journal already exists is reported
  under `totals.alreadyPosted`, not re-posted — no double credit.
- An account with any real (non-`OPENING_BALANCE`) Ledger activity is
  skipped every time, permanently, under
  `totals.skipped.existingLedgerActivity`.
- Each account's account-create + journal-post is one atomic transaction;
  a mid-run failure never leaves that one account partially initialized,
  and never blocks any other account from being processed.

Re-running produces a new, separate timestamped evidence file each time —
old reports are never overwritten, so the evidence trail accumulates.
