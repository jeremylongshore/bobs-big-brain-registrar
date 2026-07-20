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

import { createPublicKey, createPrivateKey } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';

import {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  MemoryLinksRepository,
  verifyAuditChain,
  computeManifestHash,
  appendSignedMergeAnchor,
  readSignedMergeAnchors,
  verifySignedMergeAnchors,
} from '@qmd-team-intent-kb/store';
import type {
  createDatabase as CreateDatabase,
  ExceptionManifest,
  ExceptionManifestEntry,
  AuditChainRow,
} from '@qmd-team-intent-kb/store';

import { Curator } from './curator.js';
import { ingestFromSpoolDetailed } from './intake/spool-intake.js';
import { mergeGovern } from './merge/merge-gate.js';
import { walkProvenance } from './provenance/provenance-walk.js';

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

  provenance-walk --memory-id <id> --db <path> [--brain <path>] [--spool <dir>]... [--json]
    Walk one curated memory's provenance chain across the govern/compile
    boundary: curated_memories row → id derivation → 'promoted' receipt →
    candidates row → content-addressed candidate id → spool manifest entry
    (the bridge) → ICO compile trace. Prints PASS / FAIL / UNVERIFIABLE per
    link with the evidence backing it. Opens the db READ-ONLY.
    Exit: 0 all PASS · 1 any FAIL (broken chain) · 3 no FAIL but >=1
    UNVERIFIABLE (artifact absent, e.g. no brain dir on CI) · 2 usage error.

  merge-govern <cloneA-db> <cloneB-db> --db <target> --tenant <id>
               [--dry-run] [--json] [--anchor <path>] [--commit <sha>]
    Re-govern the UNION of two clones' promoted rows into the target store
    (govern-at-merge gate). Clone DBs are opened READ-ONLY and never written;
    the target DB is the ONLY write surface. Every union row is re-governed as
    UNTRUSTED (disclosure choke point + full enabled policy from the TARGET
    db); failures are quarantined, never admitted. With --anchor, appends a
    per-actor Ed25519-SIGNED merge anchor binding the merged chain head to the
    two pre-merge clone heads (requires MERGE_ANCHOR_PRIVATE_KEY_HEX in the
    environment, sourced from the SOPS-encrypted key file — never plaintext).

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

Options for 'provenance-walk':
  --memory-id <id>  The curated_memories id to walk (required).
  --db <path>       SQLite path to read READ-ONLY (required). Never mutated.
  --brain <path>    ICO brain root holding audit/traces/. Its basename is the
                    workspaceId used in the candidate-id derivation.
                    Default: ~/.teamkb/brain.
  --spool <dir>     Directory scanned recursively for spool *.manifest.json
                    sidecars. Repeatable. Default: <db-dir>/spool and
                    <db-dir>/brain/spool.
  --json            Emit a structured JSON envelope in place of the summary.

Options for 'merge-govern':
  --db <path>     Target (merged) SQLite path — the ONLY db written (required).
  --tenant <id>   Tenant scope for policy + audit events (required).
  --dry-run       Run the full gate but write nothing (merge preview).
  --anchor <path> Append a signed merge anchor to this log after a non-dry-run
                  merge. Signing key comes from MERGE_ANCHOR_PRIVATE_KEY_HEX.
  --commit <sha>  Optional Dolt/git commit SHA recorded in the anchor.
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
    case 'provenance-walk':
      return cmdProvenanceWalk(argv.slice(1), deps);
    case 'merge-govern':
      return cmdMergeGovern(argv.slice(1), deps);
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

// ---------------------------------------------------------------------------
// provenance-walk
//
// Walk one memory's full provenance chain across the govern/compile boundary
// (046-AT-ARCH): the INTKB store rows + 'promoted' receipt (govern), the
// UUID-v5 id lineage, the spool manifest bridge, and the ICO compile trace
// (compile). Each link is verified against the artifact that actually backs
// it; an absent artifact is honestly UNVERIFIABLE, never PASS.
// ---------------------------------------------------------------------------

interface ProvenanceWalkOpts {
  memoryId: string;
  dbPath: string;
  brainDir?: string;
  spoolDirs: string[];
  json: boolean;
}

function parseProvenanceWalkArgs(
  args: string[],
): { ok: true; opts: ProvenanceWalkOpts } | { ok: false; message: string } {
  let memoryId: string | undefined;
  let dbPath: string | undefined;
  let brainDir: string | undefined;
  const spoolDirs: string[] = [];
  let json = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case '--memory-id':
        memoryId = args[i + 1];
        i += 2;
        break;
      case '--db':
        dbPath = args[i + 1];
        i += 2;
        break;
      case '--brain':
        brainDir = args[i + 1];
        i += 2;
        break;
      case '--spool': {
        const dir = args[i + 1];
        if (dir !== undefined) spoolDirs.push(dir);
        i += 2;
        break;
      }
      case '--json':
        json = true;
        i += 1;
        break;
      default:
        return { ok: false, message: `unknown flag: ${arg}` };
    }
  }

  if (memoryId === undefined || memoryId.trim() === '') {
    return { ok: false, message: 'missing required flag: --memory-id <id>' };
  }
  // --db is mandatory for the same reason as verify-corpus-accounting: an
  // implicit in-memory store would make every link a verdict about nothing.
  if (dbPath === undefined || dbPath.trim() === '') {
    return {
      ok: false,
      message: 'missing required flag: --db <path> (refusing to walk an implicit in-memory store)',
    };
  }

  return { ok: true, opts: { memoryId, dbPath, brainDir, spoolDirs, json } };
}

/** Directory containing a db path (mirror of defaultManifestPath's logic). */
function dbDir(dbPath: string): string {
  const idx = Math.max(dbPath.lastIndexOf('/'), dbPath.lastIndexOf('\\'));
  return idx >= 0 ? dbPath.slice(0, idx) : '.';
}

async function cmdProvenanceWalk(args: string[], deps: CuratorCliDeps): Promise<number> {
  const parsed = parseProvenanceWalkArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`curator-cli provenance-walk: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const { memoryId, dbPath, json } = parsed.opts;
  const brainDir = parsed.opts.brainDir ?? `${homedir()}/.teamkb/brain`;
  const spoolDirs =
    parsed.opts.spoolDirs.length > 0
      ? parsed.opts.spoolDirs
      : [`${dbDir(dbPath)}/spool`, `${dbDir(dbPath)}/brain/spool`];

  // Open READ-ONLY — a verifier must never mutate a live brain.
  const db = deps.createDb({ dbPath, readonly: true });
  try {
    const result = walkProvenance(db, memoryId, { spoolDirs, brainDir });

    if (json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return result.exitCode;
    }

    process.stdout.write(`provenance walk: memory ${result.memoryId}\n`);
    process.stdout.write(`brain root:  ${brainDir}\n`);
    process.stdout.write(`spool dirs:  ${spoolDirs.join(', ')}\n\n`);
    for (const link of result.links) {
      process.stdout.write(`  [${link.status.padEnd(12)}] ${link.link}\n`);
      process.stdout.write(`      ${link.evidence}\n`);
    }
    process.stdout.write(
      `\nChain: ${result.passCount} PASS / ${result.failCount} FAIL / ` +
        `${result.unverifiableCount} UNVERIFIABLE\n`,
    );
    if (result.failCount > 0) {
      process.stderr.write(
        `PROVENANCE_BROKEN: ${result.failCount} link(s) contradicted by the artifacts that back them.\n`,
      );
    } else if (result.unverifiableCount > 0) {
      process.stdout.write(
        `Some links are UNVERIFIABLE: their backing artifacts are absent on this host — ` +
          `absence of evidence, not contradiction.\n`,
      );
    }
    return result.exitCode;
  } finally {
    try {
      (db as unknown as { close?: () => void }).close?.();
    } catch {
      // non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// merge-govern (Wave-2 E3/F3)
//
// CLI wiring for the govern-at-merge gate (merge/merge-gate.ts). Read/write
// posture is the contract: the two clone DBs are opened READ-ONLY and are
// never written; the target DB (--db) is the ONLY write surface. Every union
// row is re-governed as UNTRUSTED against the TARGET db's enabled policy —
// survivors promote through the canonical path, failures quarantine.
//
// With --anchor, a per-actor Ed25519-SIGNED merge anchor (store
// signed-merge-anchor.ts) is appended after a successful non-dry-run merge,
// binding the merged chain head to the two PRE-merge clone chain heads.
//
// Trust-model honesty (do not overstate): the per-actor signature gives
// cross-actor ATTRIBUTION of merge events on the MERGE path only — a signed
// anchor proves which key-holder anchored which merged head. Local
// single-writer mode still has NO non-repudiation: a single local actor with
// write access and the key can rewrite and re-sign. Cross-actor guarantees
// additionally require the anchor log to be committed somewhere the writer
// cannot quietly rewrite (git push / OpenTimestamps).
// ---------------------------------------------------------------------------

/** Environment variable carrying the hex PKCS8 DER Ed25519 private key.
 *  Sourced at runtime from the SOPS-encrypted key file (see the merge-govern
 *  runbook) — never committed plaintext, never printed. */
const MERGE_ANCHOR_KEY_ENV = 'MERGE_ANCHOR_PRIVATE_KEY_HEX';

interface MergeGovernOpts {
  cloneAPath: string;
  cloneBPath: string;
  dbPath: string;
  tenantId: string;
  dryRun: boolean;
  anchorPath?: string;
  commitHash?: string;
  json: boolean;
}

function parseMergeGovernArgs(
  args: string[],
): { ok: true; opts: MergeGovernOpts } | { ok: false; message: string } {
  const positionals: string[] = [];
  let dbPath: string | undefined;
  let tenantId: string | undefined;
  let dryRun = false;
  let anchorPath: string | undefined;
  let commitHash: string | undefined;
  let json = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case '--db':
        dbPath = args[i + 1];
        i += 2;
        break;
      case '--tenant':
        tenantId = args[i + 1];
        i += 2;
        break;
      case '--dry-run':
        dryRun = true;
        i += 1;
        break;
      case '--anchor':
        anchorPath = args[i + 1];
        i += 2;
        break;
      case '--commit':
        commitHash = args[i + 1];
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
        positionals.push(arg);
        i += 1;
    }
  }

  if (positionals.length !== 2) {
    return {
      ok: false,
      message: `expected exactly two positional arguments <cloneA-db> <cloneB-db>, got ${positionals.length}`,
    };
  }
  // --db is mandatory: without it the merge would write into an implicit
  // in-memory store and the whole governed result would be silently discarded
  // on exit (same refusal rationale as verify-corpus-accounting).
  if (dbPath === undefined || dbPath.trim() === '') {
    return { ok: false, message: 'missing required flag: --db <target-path>' };
  }
  if (tenantId === undefined || tenantId.trim() === '') {
    return { ok: false, message: 'missing required flag: --tenant <id>' };
  }
  if (anchorPath !== undefined && dryRun) {
    return { ok: false, message: '--anchor cannot be combined with --dry-run (nothing to anchor)' };
  }
  // --commit must be an actual commit SHA (7-40 hex chars, git's abbreviated
  // to full range; case-insensitive — some tools print uppercase hex). A
  // branch name or 'HEAD' is a MOVABLE ref that resolves differently over
  // time — a durable anchor record must carry the immutable object id, never
  // something that drifts after the fact. Accepted SHAs are normalized to
  // lowercase before storage so the durable record has one canonical casing.
  if (commitHash !== undefined && !/^[0-9a-fA-F]{7,40}$/.test(commitHash)) {
    return {
      ok: false,
      message:
        `--commit must be a 7-40 character hex commit SHA (got "${commitHash}"); ` +
        `resolve refs first, e.g. git rev-parse HEAD`,
    };
  }

  return {
    ok: true,
    opts: {
      cloneAPath: positionals[0]!,
      cloneBPath: positionals[1]!,
      dbPath,
      tenantId,
      dryRun,
      anchorPath,
      commitHash: commitHash?.toLowerCase(),
      json,
    },
  };
}

/** The last chained entry_hash of a store's audit chain ('' when empty) —
 *  captured from each clone BEFORE the merge, these are the anchor `parents`. */
function chainHeadOf(repo: AuditRepository): string {
  const rows = repo.findAllChronological().filter((r) => r.entry_hash !== null);
  return rows.length > 0 ? (rows[rows.length - 1]!.entry_hash ?? '') : '';
}

/**
 * Derive the hex SPKI DER public key from a hex PKCS8 DER Ed25519 private key.
 * Deriving (rather than accepting a second env var) makes a mismatched
 * pub/priv pair impossible — the signature always verifies against the
 * embedded signerPublicKey. Auditors compare that embedded key against the
 * COMMITTED public key (keys/merge-anchor-signer.pub).
 */
function derivePublicKeyHex(privateKeyHex: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyHex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  // Round-trip via JWK: an Ed25519 private JWK carries the public point in
  // `x`; dropping `d` yields the public JWK. (The @types/node overloads for
  // createPublicKey(KeyObject) lag the runtime, so JWK is the typed path.)
  const jwk = privateKey.export({ format: 'jwk' });
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  return createPublicKey({ key: publicJwk, format: 'jwk' })
    .export({ type: 'spki', format: 'der' })
    .toString('hex');
}

/** How long a stale anchor lock may sit before being stolen (a crashed holder). */
const ANCHOR_LOCK_STALE_MS = 60_000;
/** Poll interval while waiting for the anchor lock. */
const ANCHOR_LOCK_POLL_MS = 100;

/**
 * Serialize the anchor read→compute→append→verify critical section across
 * concurrent merge-govern invocations via an exclusive-create lockfile at
 * `<anchorPath>.lock` (O_EXCL — atomic on a local filesystem).
 *
 * Why this exists (review finding, PR #299): the Lamport clock is derived by
 * READING the log's last record and appending last+1. Unserialized, two
 * concurrent invocations both read the same tail and mint DUPLICATE clocks
 * (and the same prevAnchorHash — a log fork). Chose a CLI-side lockfile over
 * deriving the clock inside appendSignedMergeAnchor because (a) the store API
 * documents lamportClock as a caller-owned counter — moving derivation into
 * the signing primitive conflates process mutual exclusion with cryptography
 * and ripples through every existing caller; and (b) in-append derivation
 * would NOT fix the race anyway: the read and the appendFileSync would still
 * be two unserialized steps. Only mutual exclusion serializes them. Same
 * pattern as the ecosystem's flock-on-the-brain write lock; same-host
 * serialization only, matching the anchor log's single-host posture.
 *
 * A lock older than {@link ANCHOR_LOCK_STALE_MS} is presumed abandoned (a
 * crashed holder) and stolen. Returns a release function; throws after
 * `timeoutMs` (env-overridable via MERGE_ANCHOR_LOCK_TIMEOUT_MS for tests).
 *
 * ## Stale-steal soundness bound (PR #299 re-review finding 4)
 *
 * Stealing keys on the lock file's mtime, which is stamped ONCE at creation —
 * so a live holder whose critical section outlived the 60s threshold could in
 * principle be mistaken for crashed. That misidentification is prevented by a
 * BOUND, not a heartbeat: the locked section is one small JSONL read, one
 * SQLite chain scan, one Ed25519 sign, one appendFileSync, and one re-verify —
 * sub-second in practice even at a ~25k-row audit chain, i.e. two orders of
 * magnitude below the 60s threshold. Chose documenting this bound over
 * heartbeating the mtime from inside the section because a heartbeat adds
 * real concurrency machinery (an interval, cleanup on every throw path, its
 * own failure modes) to defend a window that cannot be reached; if the
 * section ever grows work that can stall (e.g. remote anchoring), add the
 * mtime heartbeat THEN, alongside that change.
 */
async function acquireAnchorLock(anchorPath: string): Promise<() => void> {
  const lockPath = `${anchorPath}.lock`;
  const timeoutMs = Number(process.env['MERGE_ANCHOR_LOCK_TIMEOUT_MS'] ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone — nothing to release.
        }
      };
    } catch {
      // Lock held. Steal it only if stale (holder presumed crashed).
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > ANCHOR_LOCK_STALE_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            // another waiter stole it first — loop and retry.
          }
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry immediately.
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for the anchor lock ${lockPath} — ` +
            `another merge-govern appears to be anchoring; retry, or remove the lock ` +
            `if its holder is dead`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, ANCHOR_LOCK_POLL_MS));
    }
  }
}

async function cmdMergeGovern(args: string[], deps: CuratorCliDeps): Promise<number> {
  const parsed = parseMergeGovernArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`curator-cli merge-govern: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const opts = parsed.opts;

  // Fail BEFORE opening any database when signing was requested but the key is
  // absent — a merge that succeeds and then cannot anchor would leave the
  // operator with a written merge and no receipt for it.
  let privateKeyHex: string | undefined;
  if (opts.anchorPath !== undefined) {
    privateKeyHex = process.env[MERGE_ANCHOR_KEY_ENV];
    if (privateKeyHex === undefined || privateKeyHex.trim() === '') {
      process.stderr.write(
        `curator-cli merge-govern: --anchor requires ${MERGE_ANCHOR_KEY_ENV} in the environment ` +
          `(decrypt the SOPS-encrypted signing key at runtime; see the merge-govern runbook). ` +
          `The key value is never a flag so it cannot land in shell history or process listings.\n`,
      );
      return 2;
    }
  }

  // Clone DBs: READ-ONLY. They are evidence, never a write surface.
  const cloneADb = deps.createDb({ dbPath: opts.cloneAPath, readonly: true });
  const cloneBDb = deps.createDb({ dbPath: opts.cloneBPath, readonly: true });
  // Target DB: the one write surface.
  const targetDb = deps.createDb({ dbPath: opts.dbPath });
  try {
    const cloneAMemories = new MemoryRepository(cloneADb).findByTenantAndLifecycle(
      opts.tenantId,
      'active',
    );
    const cloneBMemories = new MemoryRepository(cloneBDb).findByTenantAndLifecycle(
      opts.tenantId,
      'active',
    );
    // Pre-merge clone chain heads — the DAG `parents` of the signed anchor.
    const parentA = chainHeadOf(new AuditRepository(cloneADb));
    const parentB = chainHeadOf(new AuditRepository(cloneBDb));

    const memoryRepo = new MemoryRepository(targetDb);
    const auditRepo = new AuditRepository(targetDb);
    const linksRepo = new MemoryLinksRepository(targetDb);
    // Policy comes from the TARGET store (the same lookup the curator uses):
    // the merged brain's own governance re-judges every row. No enabled policy
    // → mergeGovern's no-policy branch (disclosure choke point + dedupe only).
    const policies = new PolicyRepository(targetDb).findByTenant(opts.tenantId);
    const policy = policies.find((p) => p.enabled);

    const result = mergeGovern(
      cloneAMemories,
      cloneBMemories,
      { memoryRepo, auditRepo, linksRepo },
      {
        ...(policy !== undefined ? { policy } : {}),
        tenantId: opts.tenantId,
        dryRun: opts.dryRun,
      },
    );

    // F3: signed merge anchor over the merged head (non-dry-run only; enforced
    // at parse time). Lamport clock: monotonic per anchor log — last + 1. The
    // whole read→compute→append→verify section runs under the anchor lock so
    // concurrent invocations cannot mint duplicate clocks or fork the log
    // (see acquireAnchorLock for the race and the chose-X-over-Y rationale).
    let anchor: ReturnType<typeof appendSignedMergeAnchor> | undefined;
    let anchorVerifyOk: boolean | undefined;
    if (opts.anchorPath !== undefined && privateKeyHex !== undefined) {
      const releaseLock = await acquireAnchorLock(opts.anchorPath);
      try {
        const existing = readSignedMergeAnchors(opts.anchorPath);
        const lamportClock =
          existing.length > 0 ? existing[existing.length - 1]!.lamportClock + 1 : 1;
        anchor = appendSignedMergeAnchor(auditRepo, opts.anchorPath, {
          tenantId: opts.tenantId,
          parents: [parentA, parentB],
          lamportClock,
          privateKeyHex,
          publicKeyHex: derivePublicKeyHex(privateKeyHex),
          commitHash: opts.commitHash ?? null,
        });
        anchorVerifyOk = verifySignedMergeAnchors(auditRepo, opts.anchorPath, [
          parentA,
          parentB,
        ]).ok;
      } finally {
        releaseLock();
      }
    }

    // The overall verdict is gated on the anchor verification when an anchor
    // was requested: a merge whose just-appended anchor does NOT verify must
    // never report success in EITHER output mode (PR #299 re-review finding 1
    // — the JSON branch used to hardcode ok:true / exit 0 while the
    // human-readable branch correctly failed).
    const anchorFailed = anchor !== undefined && anchorVerifyOk !== true;

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          ok: !anchorFailed,
          dry_run: opts.dryRun,
          tenant_id: opts.tenantId,
          clone_a: { path: opts.cloneAPath, rows: cloneAMemories.length, chain_head: parentA },
          clone_b: { path: opts.cloneBPath, rows: cloneBMemories.length, chain_head: parentB },
          policy: policy?.name ?? null,
          union_size: result.unionSize,
          promoted_count: result.promoted.length,
          quarantined_count: result.quarantined.length,
          quarantined: result.quarantined,
          ...(anchorFailed ? { code: 'ANCHOR_VERIFY_FAILED' } : {}),
          ...(anchor !== undefined
            ? {
                anchor: {
                  path: opts.anchorPath,
                  anchor_hash: anchor.anchorHash,
                  chain_head: anchor.chainHead,
                  parents: anchor.parents,
                  lamport_clock: anchor.lamportClock,
                  signer_public_key: anchor.signerPublicKey,
                  verified: anchorVerifyOk,
                },
              }
            : {}),
        }) + '\n',
      );
      if (anchorFailed) {
        process.stderr.write(
          `merge-govern: signed-anchor verification FAILED after append — inspect the anchor log\n`,
        );
        return 1;
      }
      return 0;
    }

    process.stdout.write(
      `merge-govern ${opts.dryRun ? '(dry-run) ' : ''}complete\n` +
        `Clone A:      ${cloneAMemories.length} active row(s) from ${opts.cloneAPath}\n` +
        `Clone B:      ${cloneBMemories.length} active row(s) from ${opts.cloneBPath}\n` +
        `Policy:       ${policy?.name ?? '(none enabled — disclosure + dedupe only)'}\n` +
        `Union:        ${result.unionSize}\n` +
        `Promoted:     ${result.promoted.length}\n` +
        `Quarantined:  ${result.quarantined.length}\n`,
    );
    for (const q of result.quarantined) {
      // Ids + category + rule only — never content (non-leak contract).
      process.stdout.write(`  quarantined ${q.memoryId} (${q.category}: ${q.reason})\n`);
    }
    if (anchor !== undefined) {
      process.stdout.write(
        `Signed anchor: ${opts.anchorPath}\n` +
          `  anchorHash:  ${anchor.anchorHash}\n` +
          `  chainHead:   ${anchor.chainHead}\n` +
          `  parents:     ${anchor.parents.join(', ')}\n` +
          `  lamport:     ${anchor.lamportClock}\n` +
          `  verified:    ${anchorVerifyOk === true ? 'ok' : 'FAILED'}\n`,
      );
      if (anchorFailed) {
        process.stderr.write(
          `merge-govern: signed-anchor verification FAILED after append — inspect the anchor log\n`,
        );
        return 1;
      }
    }
    return 0;
  } catch (err) {
    // MergeIdInvariantError (a non-content-derived id crossed the clone
    // boundary) and any store failure land here: report, never half-write —
    // mergeGovern validates the whole union before any promotion.
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: msg, code: 'MERGE_GOVERN_FAILED' }) + '\n',
      );
    } else {
      process.stderr.write(`merge-govern failed: ${msg}\n`);
    }
    return 1;
  } finally {
    for (const db of [cloneADb, cloneBDb, targetDb]) {
      try {
        (db as unknown as { close?: () => void }).close?.();
      } catch {
        // non-fatal
      }
    }
  }
}
