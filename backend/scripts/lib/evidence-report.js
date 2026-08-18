/**
 * P2.10-A — shared evidence-report helper for the P2.5 opening-balance
 * scripts (scripts/p2_5-opening-balance-migration.js and
 * scripts/p2_5-preflight-readonly.js).
 *
 * Two small, deliberately dumb responsibilities, factored out so both
 * scripts use the exact same logic instead of two copies drifting apart:
 *
 *   - getSafeDatabaseTarget(): derive an environment identity from
 *     DATABASE_URL that is safe to print/persist — host, port, database
 *     name only. NEVER returns username, password, or the raw connection
 *     string. If DATABASE_URL is missing or unparsable, returns a
 *     `resolved: false` shape rather than falling back to printing the
 *     raw value (an unparsable URL could still contain a credential).
 *
 *   - writeEvidenceReport(scriptName, mode, report): persist `report` as
 *     a timestamped, human-readable JSON file under a repo-local,
 *     git-ignored evidence directory (scripts/p2_5-evidence/), and return
 *     the path written. This is the durable artifact that lets a future
 *     audit answer "did P2.5 opening-balance execution actually run, and
 *     when, against which database" without trusting a console log that
 *     may have scrolled away. `mode` is always one of 'EXECUTION' or
 *     'PREFLIGHT' — the filename itself encodes which, so a preflight run
 *     can never be mistaken for a real execution on disk.
 *
 * This file has no side effects on import — it only creates the evidence
 * directory / writes a file when writeEvidenceReport() is actually called
 * by a script that itself ran to that point. It is never imported by any
 * application runtime code (routes, services) — only by the two P2.5
 * scripts themselves.
 */

const fs = require('fs');
const path = require('path');

// scripts/p2_5-evidence/ — sibling of this lib/ directory, one level up.
// Git-ignored (see repo root .gitignore) so local execution reports never
// get committed accidentally.
const EVIDENCE_DIR = path.join(__dirname, '..', 'p2_5-evidence');

/**
 * Derive a safe-to-print/persist database target identity from
 * DATABASE_URL. Only host/port/database name are ever extracted — never
 * username or password, and never the raw URL itself (which would
 * embed both).
 *
 * @returns {{resolved: boolean, host: string|null, port: string|null, database: string|null}}
 */
function getSafeDatabaseTarget() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return {
      resolved: false, host: null, port: null, database: null,
    };
  }
  try {
    const parsed = new URL(raw);
    return {
      resolved: true,
      host: parsed.hostname || null,
      port: parsed.port || null,
      database: parsed.pathname ? parsed.pathname.replace(/^\//, '') : null,
    };
  } catch (err) {
    // Deliberately no fallback to the raw string here — an unparsable
    // DATABASE_URL is exactly the case where we can't be sure it doesn't
    // still contain a credential fragment.
    return {
      resolved: false, host: null, port: null, database: null,
    };
  }
}

/**
 * Write `report` to a timestamped JSON file under the evidence directory
 * and return the absolute path written. Never throws on its own I/O
 * failure into the caller's main financial-work path silently — callers
 * should wrap this in try/catch and treat a failure here as a reporting
 * problem, not a reason to claim the underlying script didn't run (or
 * did run, if it didn't).
 *
 * Filename shape: `${scriptName}.${mode}.${isoTimestamp}.json` — mode is
 * always literally 'execution' or 'preflight' (lowercased), so the two
 * are never visually ambiguous in a directory listing.
 *
 * @param {string} scriptName - short identifier, e.g. 'p2_5-opening-balance-migration'
 * @param {'EXECUTION'|'PREFLIGHT'} mode
 * @param {object} report - must already be JSON-serializable (Decimal/Date
 *   values should be pre-stringified by the caller, same convention the
 *   scripts already use for their console.log(JSON.stringify(...)) output)
 * @returns {string} absolute path of the written file
 */
function writeEvidenceReport(scriptName, mode, report) {
  if (mode !== 'EXECUTION' && mode !== 'PREFLIGHT') {
    throw new Error(`writeEvidenceReport requires mode EXECUTION or PREFLIGHT, got: ${mode}`);
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(EVIDENCE_DIR, `${scriptName}.${mode.toLowerCase()}.${stamp}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}

module.exports = { getSafeDatabaseTarget, writeEvidenceReport, EVIDENCE_DIR };
