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

import { existsSync, writeFileSync } from 'node:fs';

import {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  MemoryLinksRepository,
  verifyAuditChain,
  computeManifestHash,
} from '@qmd-team-intent-kb/store';
import type {
  createDatabase as CreateDatabase,
  ExceptionManifest,
  ExceptionManifestEntry,
  AuditChainRow,
} from '@qmd-team-intent-kb/store';

import { Curator } from './curator.js';
import { ingestFromSpoolDetailed } from './intake/spool-intake.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Database factory — production wires `createDatabase`; tests wire
 *  `createTestDatabase`. `readonly` opens the DB without applying DDL /
 *  migrations / permission changes (used by generate-exception-manifest so it
 *  can never mutate a live brain). */
export type DatabaseFactory = (options: {
  dbPath?: string;
  readonly?: boolean;
}) => ReturnType<typeof CreateDatabase>;

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

  generate-exception-manifest --db <path> [--out <path>] [--force] [--brain-id <id>] [--json]
    Open a teamkb.db READ-ONLY, verify the audit chain, and capture every
    tamper-reason break's CURRENT stored tuple into a byte-pinned exception
    manifest (010-AT-RISK R1/R2). Refuses to overwrite an existing manifest
    without --force. Prints the entryCount + manifestHash.

  verify-corpus-accounting [--db <path>] [--json]
    Prove the governed corpus and the audit log agree: every curated_memories
    row must carry a row-creating audit receipt (action 'promoted'). A row
    without one is an orphan — the signature of a raw SQL INSERT that bypassed
    the curator promoter. Opens the db READ-ONLY; exits 2 when orphans exist.

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

Options for 'generate-exception-manifest':
  --db <path>     SQLite path to read READ-ONLY (required). Never mutated.
  --out <path>    Manifest output path. Default: <db-dir>/exceptions.manifest.json.
  --force         Overwrite an existing manifest. Without it, an existing
                  manifest is a hard error (the manifest is a one-time amnesty;
                  regenerating silently would re-launder new breaks).
  --brain-id <id> Optional brain identifier stamped into the manifest.
  --json          Emit a structured JSON envelope in place of the summary.

Options for 'verify-corpus-accounting':
  --db <path>     SQLite path to read READ-ONLY (required for any meaningful
                  run; an in-memory db is always empty). Never mutated.
  --json          Emit a structured JSON envelope in place of the summary.
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
    case 'generate-exception-manifest':
      return cmdGenerateExceptionManifest(argv.slice(1), deps);
    case 'verify-corpus-accounting':
      return cmdVerifyCorpusAccounting(argv.slice(1), deps);
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
    // Candidates refused at the disclosure / secret choke point (Epic 0).
    // Reported, never silently dropped — carries only id + category.
    const disclosureRejected = ingestResult.value.rejected;

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
          disclosure_rejected_count: disclosureRejected.length,
          disclosure_rejected: disclosureRejected,
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
      if (disclosureRejected.length > 0) {
        // Never print the matched value — only id + category.
        process.stderr.write(
          `\nDISCLOSURE_REJECTED: ${disclosureRejected.length} candidate(s) refused (PII / comp / secret):\n`,
        );
        for (const r of disclosureRejected) {
          process.stderr.write(`  ${r.candidateId} (${r.category})\n`);
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

    // A CHAIN_FORK is a non-malicious ordering artifact (all hashes intact);
    // every other reason is a tampering signature. Partition so we never shout
    // "TAMPERED" at a pre-fix same-timestamp ordering fork (bead yxp).
    const tamperBreaks = result.breaks.filter((b) => b.reason !== 'CHAIN_FORK');
    const forks = result.breaks.filter((b) => b.reason === 'CHAIN_FORK');
    const strictClean = result.breaks.length === 0;
    const tamperFree = tamperBreaks.length === 0;
    // 0 = strictly clean · 1 = forked but untampered · 2 = tampered
    const exitCode = tamperBreaks.length > 0 ? 2 : forks.length > 0 ? 1 : 0;

    const writeBreak = (b: (typeof result.breaks)[number]): void => {
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
    };

    if (json) {
      process.stdout.write(
        JSON.stringify({
          ok: strictClean,
          tamperFree,
          totalRows: result.totalRows,
          unverifiedRows: result.unverifiedRows,
          cleanRows: result.cleanRows,
          forks: forks.length,
          breaks: result.breaks,
        }) + '\n',
      );
      return exitCode;
    }

    if (strictClean) {
      process.stdout.write(`audit chain OK\n`);
      process.stdout.write(`Total rows:      ${result.totalRows}\n`);
      process.stdout.write(`Clean rows:      ${result.cleanRows}\n`);
      process.stdout.write(`Unverified rows: ${result.unverifiedRows} (pre-migration)\n`);
      return 0;
    }

    if (tamperBreaks.length > 0) {
      process.stderr.write(
        `AUDIT_TAMPERED: ${tamperBreaks.length} tampering break(s) detected in ${result.totalRows} row(s)` +
          (forks.length > 0 ? ` (plus ${forks.length} non-tampering CHAIN_FORK row(s))` : '') +
          `\n\n`,
      );
      for (const b of tamperBreaks) writeBreak(b);
      return 2;
    }

    // Forks only — NO tampering. Every entry_hash is intact; the chain is
    // non-linear at `forks.length` historical points (pre-fix writer bug).
    process.stderr.write(
      `AUDIT_FORKED: ${forks.length} historical chain fork(s) in ${result.totalRows} row(s) — ` +
        `NO tampering (every entry_hash intact). Pre-fix same-timestamp ordering artifact; ` +
        `see bead qmd-team-intent-kb-yxp.\n\n`,
    );
    for (const b of forks) writeBreak(b);
    return 1;
  } finally {
    try {
      (db as unknown as { close?: () => void }).close?.();
    } catch {
      // non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// generate-exception-manifest
//
// Capture every tamper-reason audit-chain break's CURRENT stored tuple into a
// byte-pinned exception manifest (010-AT-RISK R1/R2/R7; 009-AT-DECR D5). The
// manifest pins each exception by its exact per-row tuple so the classifier
// can only honour it on a full byte-match — no index-range / date laundering.
// ---------------------------------------------------------------------------

interface GenManifestOpts {
  dbPath: string;
  outPath?: string;
  brainId?: string;
  force: boolean;
  json: boolean;
}

function parseGenManifestArgs(
  args: string[],
): { ok: true; opts: GenManifestOpts } | { ok: false; message: string } {
  let dbPath: string | undefined;
  let outPath: string | undefined;
  let brainId: string | undefined;
  let force = false;
  let json = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case '--db':
        dbPath = args[i + 1];
        i += 2;
        break;
      case '--out':
        outPath = args[i + 1];
        i += 2;
        break;
      case '--brain-id':
        brainId = args[i + 1];
        i += 2;
        break;
      case '--force':
        force = true;
        i += 1;
        break;
      case '--json':
        json = true;
        i += 1;
        break;
      default:
        return { ok: false, message: `unknown flag: ${arg}` };
    }
  }

  if (dbPath === undefined || dbPath.trim() === '') {
    return { ok: false, message: 'missing required flag: --db <path>' };
  }
  return { ok: true, opts: { dbPath, outPath, brainId, force, json } };
}

/** Default manifest path sits beside the DB (an ops artifact, not a repo file). */
function defaultManifestPath(dbPath: string): string {
  const idx = Math.max(dbPath.lastIndexOf('/'), dbPath.lastIndexOf('\\'));
  const dir = idx >= 0 ? dbPath.slice(0, idx) : '.';
  return `${dir}/exceptions.manifest.json`;
}

/**
 * The store's AuditChainRow interface does not declare `seq` (it is part of the
 * ordering contract, not the hash), but `findAllChronological()` runs
 * `SELECT *` so the column is present on the row object. We read it via this
 * widened view — `seq` is load-bearing for the byte-pin.
 */
type ChainRowWithSeq = AuditChainRow & { seq: number | null };

async function cmdGenerateExceptionManifest(args: string[], deps: CuratorCliDeps): Promise<number> {
  const parsed = parseGenManifestArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`curator-cli generate-exception-manifest: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const { dbPath, brainId, force, json } = parsed.opts;
  const outPath = parsed.opts.outPath ?? defaultManifestPath(dbPath);

  // Refuse to overwrite an existing manifest without --force: the manifest is a
  // ONE-TIME amnesty. Regenerating silently would re-launder any breaks that
  // appeared after the original amnesty (they'd be freshly pinned as
  // "documented"). Force is an explicit operator override.
  if (!force && existsSync(outPath)) {
    const msg = `manifest already exists at ${outPath}; refusing to overwrite without --force`;
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: msg, code: 'MANIFEST_EXISTS' }) + '\n',
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // Open READ-ONLY — the generator must never mutate a live brain.
  const db = deps.createDb({ dbPath, readonly: true });
  try {
    const auditRepo = new AuditRepository(db);
    const result = verifyAuditChain(auditRepo);

    // Index the current stored tuple of every row by id, so we can pin each
    // break's exact { entry_hash, prev_entry_hash, hash_version, seq }.
    const rows = auditRepo.findAllChronological() as ChainRowWithSeq[];
    const byId = new Map<string, ChainRowWithSeq>();
    for (const r of rows) byId.set(r.id, r);

    const entries: ExceptionManifestEntry[] = [];
    for (const brk of result.breaks) {
      // Only tamper-reason breaks are pinned; a CHAIN_FORK is a non-tamper
      // ordering artifact and is never granted amnesty.
      if (brk.reason === 'CHAIN_FORK') continue;
      const row = byId.get(brk.id);
      if (row === undefined) continue; // defensive; a break always names a real row
      entries.push({
        id: row.id,
        // Pin the stored entry_hash AS-IS (nullable): a tamper-reason break can
        // have a NULL stored hash, and the pin must capture that faithfully so a
        // later null→value drift reads as tamper (no non-null assertion).
        entryHash: row.entry_hash,
        prevEntryHash: row.prev_entry_hash,
        hashVersion: row.hash_version ?? 1,
        seq: row.seq ?? 0,
        reason: brk.reason,
      });
    }

    const body = {
      schemaVersion: 1 as const,
      ...(brainId !== undefined ? { brainId } : {}),
      generatedAt: new Date().toISOString(),
      entryCount: entries.length,
      entries,
    };
    const manifest: ExceptionManifest = { ...body, manifestHash: computeManifestHash(body) };

    writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

    const forks = result.breaks.filter((b) => b.reason === 'CHAIN_FORK').length;
    const reasonBreakdown: Record<string, number> = {};
    for (const b of result.breaks) {
      reasonBreakdown[b.reason] = (reasonBreakdown[b.reason] ?? 0) + 1;
    }

    if (json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          out: outPath,
          entryCount: manifest.entryCount,
          manifestHash: manifest.manifestHash,
          totalRows: result.totalRows,
          unverifiedRows: result.unverifiedRows,
          cleanRows: result.cleanRows,
          forks,
          reasonBreakdown,
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(`Wrote exception manifest → ${outPath}\n`);
    process.stdout.write(`entryCount:    ${manifest.entryCount}\n`);
    process.stdout.write(`manifestHash:  ${manifest.manifestHash}\n`);
    process.stdout.write(`Total rows:    ${result.totalRows}\n`);
    process.stdout.write(`Clean rows:    ${result.cleanRows}\n`);
    process.stdout.write(`Unverified:    ${result.unverifiedRows} (pre-migration)\n`);
    if (forks > 0) {
      process.stdout.write(`CHAIN_FORKs:   ${forks} (NOT pinned — non-tamper ordering artifact)\n`);
    }
    process.stdout.write(`Reason breakdown:\n`);
    for (const [reason, count] of Object.entries(reasonBreakdown)) {
      process.stdout.write(`  ${reason}: ${count}\n`);
    }
    return 0;
  } finally {
    try {
      (db as unknown as { close?: () => void }).close?.();
    } catch {
      // non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// verify-corpus-accounting
//
// Substrate guard: prove the governed corpus (curated_memories) and the audit
// log (audit_events) agree. Every production insert into curated_memories goes
// through promote() (apps/curator/src/promotion/promoter.ts) — the ONLY
// non-test call site of MemoryRepository.insert — which writes the memory row
// and its 'promoted' receipt in one BEGIN IMMEDIATE transaction (R9, jfv.6.9).
// The merge-gate, the API promotion-service, and the agent-review path all
// route through promote(); the vault / bulk-import pipelines create CANDIDATES
// only, so rows reach curated_memories exclusively via promotion. A
// curated_memories row with no matching receipt is therefore the signature of
// a raw SQL INSERT that bypassed the promoter (the substrate bypass).
// ---------------------------------------------------------------------------

/**
 * Audit-event actions that legitimately CREATE a curated_memories row.
 *
 * Exactly one class today: 'promoted'. Lifecycle events ('superseded',
 * 'demoted', 'recategorized', …) mutate or annotate EXISTING rows; 'proposed'
 * receipts a candidate (pre-promotion, memoryId = candidate id); 'governed'
 * receipts a batch sweep. None of them mints a corpus row. If a future write
 * path legitimately creates rows under a new action, add it HERE (with the
 * receipt emitted in the same transaction as the insert) — never widen the
 * check ad hoc.
 */
const ROW_CREATING_ACTIONS: readonly string[] = ['promoted'];

interface CorpusAccountingOpts {
  dbPath?: string;
  json: boolean;
}

function parseCorpusAccountingArgs(
  args: string[],
): { ok: true; opts: CorpusAccountingOpts } | { ok: false; message: string } {
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

  // --db is mandatory: without it deps.createDb falls back to an empty
  // in-memory store, which would report a trivially clean corpus — a passing
  // verdict about nothing. The verifier refuses instead (review finding on
  // #289; the test harness injects its own createDb and bypasses argv).
  if (dbPath === undefined) {
    return {
      ok: false,
      message: 'missing required --db <path> (refusing to verify an implicit in-memory store)',
    };
  }

  return { ok: true, opts: { dbPath, json } };
}

/** Orphan row surfaced by the accounting query. Ids + row metadata only —
 *  never title/content (same disclosure discipline as the ingest report). */
interface OrphanRow {
  id: string;
  tenantId: string;
  promotedAt: string;
}

async function cmdVerifyCorpusAccounting(args: string[], deps: CuratorCliDeps): Promise<number> {
  const parsed = parseCorpusAccountingArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`curator-cli verify-corpus-accounting: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const { dbPath, json } = parsed.opts;

  // Open READ-ONLY when a real path is given — a verifier must never mutate a
  // live brain (same posture as generate-exception-manifest).
  const db = deps.createDb(dbPath !== undefined ? { dbPath, readonly: true } : {});
  try {
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM curated_memories').get() as {
      n: number;
    };
    const totalRows = totalRow.n;

    // Id-derived join: promote() stamps the receipt's memory_id with the
    // curated memory's own id, so accounting is a NOT EXISTS over that column
    // filtered to the row-creating action classes.
    const placeholders = ROW_CREATING_ACTIONS.map(() => '?').join(', ');
    const orphans = db
      .prepare(
        `SELECT m.id AS id, m.tenant_id AS tenantId, m.promoted_at AS promotedAt
         FROM curated_memories m
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_events e
           WHERE e.memory_id = m.id AND e.action IN (${placeholders})
         )
         ORDER BY m.promoted_at, m.id`,
      )
      .all(...ROW_CREATING_ACTIONS) as OrphanRow[];

    const accountedRows = totalRows - orphans.length;
    const ok = orphans.length === 0;

    if (json) {
      process.stdout.write(
        JSON.stringify({
          ok,
          totalRows,
          accountedRows,
          orphanCount: orphans.length,
          orphans,
          acceptedActions: ROW_CREATING_ACTIONS,
        }) + '\n',
      );
      return ok ? 0 : 2;
    }

    if (ok) {
      process.stdout.write(`corpus accounting OK\n`);
      process.stdout.write(`Total rows:     ${totalRows}\n`);
      process.stdout.write(`Accounted rows: ${accountedRows}\n`);
      process.stdout.write(`Accepted receipt classes: ${ROW_CREATING_ACTIONS.join(', ')}\n`);
      return 0;
    }

    process.stderr.write(
      `CORPUS_UNACCOUNTED: ${orphans.length} of ${totalRows} curated_memories row(s) have no ` +
        `row-creating audit receipt (accepted classes: ${ROW_CREATING_ACTIONS.join(', ')}).\n` +
        `A durable corpus row without its receipt is the signature of a raw SQL INSERT that ` +
        `bypassed the curator promoter.\n\n`,
    );
    for (const o of orphans) {
      process.stderr.write(`  ${o.id}  tenant=${o.tenantId}  promoted_at=${o.promotedAt}\n`);
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
