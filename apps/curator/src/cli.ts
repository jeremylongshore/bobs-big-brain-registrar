/**
 * curator-cli — drive the INTKB curator pipeline from a spool directory.
 *
 * Used by `scripts/demo-e2e.sh` in the ICO repo (cross-repo Q1 epic
 * ICO #114 / INTKB #149, bead `qmd-team-intent-kb-9jx`). The dispatch
 * function is pure logic with deps injected — production wiring lives
 * in `main.ts`; tests in `__tests__/cli.test.ts` call dispatch directly
 * with an in-memory database.
 *
 * Subcommands:
 *   ingest <spool-dir> --tenant <id> [--db <path>] [--json]
 *     Reads spool JSONL files via ingestFromSpool, runs them through
 *     Curator.processBatch, and emits per-stage results as a JSON
 *     envelope (with --json) or human-readable text (default).
 *
 * Exit codes:
 *   0  pipeline completed (regardless of per-candidate outcomes)
 *   1  filesystem / I/O / dispatch failure
 *   2  argument / usage error
 *
 * @module cli
 */

import {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  MemoryLinksRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import type { createDatabase as CreateDatabase } from '@qmd-team-intent-kb/store';

import { Curator } from './curator.js';
import { ingestFromSpoolDetailed } from './intake/spool-intake.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Database factory — production wires `createDatabase`; tests wire
 *  `createTestDatabase`. */
export type DatabaseFactory = (options: { dbPath?: string }) => ReturnType<typeof CreateDatabase>;

export interface CuratorCliDeps {
  /** Returns a connected Database instance. */
  createDb: DatabaseFactory;
}

const USAGE = `Usage: curator-cli <subcommand> [options]

Subcommands:
  ingest <spool-dir> --tenant <id> [--db <path>] [--json]
    Drive ingest → policy → promote pipeline against a spool directory.

  verify-audit-chain [--db <path>] [--json]
    Walk the audit_events hash chain and exit 2 if AUDIT_TAMPERED.

  help | --help | -h
    Print this message.

Options for 'ingest':
  --tenant <id>   Tenant id used by the policy pipeline (required).
  --db <path>     Persistent SQLite path. Default: in-memory.
  --json          Emit machine-readable JSON envelope to stdout in place
                  of human-readable summary.

Options for 'verify-audit-chain':
  --db <path>     SQLite path (required for any meaningful verify run;
                  an in-memory db is always empty).
  --json          Emit a structured AuditVerifyResult JSON envelope.
`;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Parse argv (excluding `node curator-cli.js` prefix) and run the matched
 * subcommand. Returns the process exit code; never throws.
 */
export async function dispatch(argv: string[], deps: CuratorCliDeps): Promise<number> {
  const subcommand = argv[0];
  switch (subcommand) {
    case 'ingest':
      return cmdIngest(argv.slice(1), deps);
    case 'verify-audit-chain':
      return cmdVerifyAuditChain(argv.slice(1), deps);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case undefined:
      process.stderr.write('curator-cli: missing subcommand\n\n' + USAGE);
      return 2;
    default:
      process.stderr.write(`curator-cli: unknown subcommand "${subcommand}"\n\n` + USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

interface IngestOpts {
  spoolDir: string;
  tenantId: string;
  dbPath?: string;
  json: boolean;
}

interface IngestArgParseOk {
  ok: true;
  opts: IngestOpts;
}
interface IngestArgParseErr {
  ok: false;
  message: string;
}

function parseIngestArgs(args: string[]): IngestArgParseOk | IngestArgParseErr {
  let spoolDir: string | undefined;
  let tenantId: string | undefined;
  let dbPath: string | undefined;
  let json = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case '--tenant':
        tenantId = args[i + 1];
        i += 2;
        break;
      case '--db':
        dbPath = args[i + 1];
        i += 2;
        break;
      case '--json':
        json = true;
        i += 1;
        break;
      default:
        if (arg.startsWith('--')) {
          return { ok: false, message: `unknown flag: ${arg}` };
        }
        if (spoolDir !== undefined) {
          return { ok: false, message: `unexpected positional argument: ${arg}` };
        }
        spoolDir = arg;
        i += 1;
    }
  }

  if (spoolDir === undefined) {
    return { ok: false, message: 'missing required positional argument: <spool-dir>' };
  }
  if (tenantId === undefined || tenantId.trim() === '') {
    return { ok: false, message: 'missing required flag: --tenant <id>' };
  }

  return { ok: true, opts: { spoolDir, tenantId, dbPath, json } };
}

async function cmdIngest(args: string[], deps: CuratorCliDeps): Promise<number> {
  const parsed = parseIngestArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`curator-cli ingest: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const { spoolDir, tenantId, dbPath, json } = parsed.opts;

  const db = deps.createDb(dbPath !== undefined ? { dbPath } : {});
  try {
    const candidateRepo = new CandidateRepository(db);
    const memoryRepo = new MemoryRepository(db);
    const policyRepo = new PolicyRepository(db);
    const auditRepo = new AuditRepository(db);
    const linksRepo = new MemoryLinksRepository(db);

    // Stage A: ingestFromSpoolDetailed — reads JSONL, verifies each file's
    // manifest SHA-256 (tampered files refused + quarantined per dmj.4),
    // validates, writes surviving candidates to the store.
    const ingestResult = await ingestFromSpoolDetailed(candidateRepo, spoolDir);
    if (!ingestResult.ok) {
      // ingestFromSpoolDetailed returns Result<_, string> — message IS the error.
      const msg = ingestResult.error;
      if (json) {
        process.stdout.write(
          JSON.stringify({ ok: false, stage: 'ingest', error: msg, code: 'INGEST_FAILED' }) + '\n',
        );
      } else {
        process.stderr.write(`ingestFromSpool failed: ${msg}\n`);
      }
      return 1;
    }
    const candidates = ingestResult.value.ingested;
    const tampered = ingestResult.value.tampered;

    // Stage B: Curator.processBatch — dedup + policy + promote.
    const curator = new Curator(
      { candidateRepo, memoryRepo, policyRepo, auditRepo, linksRepo },
      { tenantId },
    );
    const batch = curator.processBatch(candidates);

    if (json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          spool_dir: spoolDir,
          tenant_id: tenantId,
          ingested_count: candidates.length,
          tampered_count: tampered.length,
          tampered,
          batch,
        }) + '\n',
      );
    } else {
      process.stdout.write(
        `Ingested ${candidates.length} candidate(s) from ${spoolDir}\n` +
          `Tenant:    ${tenantId}\n` +
          `Processed: ${batch.processed}\n` +
          `Promoted:  ${batch.promoted}\n` +
          `Rejected:  ${batch.rejected}\n` +
          `Flagged:   ${batch.flagged}\n` +
          `Duplicates: ${batch.duplicates}\n`,
      );
      if (tampered.length > 0) {
        process.stderr.write(
          `\nSPOOL_TAMPERED: ${tampered.length} file(s) refused (manifest SHA-256 mismatch):\n`,
        );
        for (const t of tampered) {
          process.stderr.write(
            `  ${t.spoolFile}\n    quarantined → ${t.quarantinedTo ?? '(quarantine failed)'}\n`,
          );
        }
      }
    }
    return 0;
  } finally {
    // better-sqlite3 Databases hold an OS file descriptor — close to avoid
    // leaks when --db points at a real file (in-memory dbs don't care).
    try {
      (db as unknown as { close?: () => void }).close?.();
    } catch {
      // closing twice or on a torn-down db is a non-fatal cleanup error.
    }
  }
}

// ---------------------------------------------------------------------------
// verify-audit-chain
// ---------------------------------------------------------------------------

interface VerifyOpts {
  dbPath?: string;
  json: boolean;
}

function parseVerifyArgs(
  args: string[],
): { ok: true; opts: VerifyOpts } | { ok: false; message: string } {
  let dbPath: string | undefined;
  let json = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case '--db':
        dbPath = args[i + 1];
        i += 2;
        break;
      case '--json':
        json = true;
        i += 1;
        break;
      default:
        return { ok: false, message: `unknown flag: ${arg}` };
    }
  }

  return { ok: true, opts: { dbPath, json } };
}

async function cmdVerifyAuditChain(args: string[], deps: CuratorCliDeps): Promise<number> {
  const parsed = parseVerifyArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`curator-cli verify-audit-chain: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const { dbPath, json } = parsed.opts;

  const db = deps.createDb(dbPath !== undefined ? { dbPath } : {});
  try {
    const auditRepo = new AuditRepository(db);
    const result = verifyAuditChain(auditRepo);
    const isClean = result.breaks.length === 0;

    if (json) {
      process.stdout.write(
        JSON.stringify({
          ok: isClean,
          totalRows: result.totalRows,
          unverifiedRows: result.unverifiedRows,
          cleanRows: result.cleanRows,
          breaks: result.breaks,
        }) + '\n',
      );
      return isClean ? 0 : 2;
    }

    if (isClean) {
      process.stdout.write(`audit chain OK\n`);
      process.stdout.write(`Total rows:      ${result.totalRows}\n`);
      process.stdout.write(`Clean rows:      ${result.cleanRows}\n`);
      process.stdout.write(`Unverified rows: ${result.unverifiedRows} (pre-migration)\n`);
      return 0;
    }

    process.stderr.write(
      `AUDIT_TAMPERED: ${result.breaks.length} chain break(s) detected in ${result.totalRows} row(s)\n\n`,
    );
    for (const b of result.breaks) {
      process.stderr.write(
        `  index ${b.index}  id=${b.id}  action=${b.action}  ts=${b.timestamp}  tenant=${b.tenantId}\n`,
      );
      process.stderr.write(`    reason:               ${b.reason}\n`);
      process.stderr.write(
        `    expected entry_hash: ${b.expectedEntryHash}\n` +
          `    actual entry_hash:   ${b.actualEntryHash ?? 'null'}\n`,
      );
      process.stderr.write(
        `    expected prev_hash:  ${b.expectedPrevEntryHash ?? 'null'}\n` +
          `    actual prev_hash:    ${b.actualPrevEntryHash ?? 'null'}\n`,
      );
    }
    return 2;
  } finally {
    try {
      (db as unknown as { close?: () => void }).close?.();
    } catch {
      // non-fatal
    }
  }
}
