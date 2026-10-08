import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import type Database from 'better-sqlite3';
import { scanFilesForFragments } from '@qmd-team-intent-kb/store';

import type { ExportTruth } from './export-truth.js';
import { loadExportTruth, memoryIdOfPath, qmdTruthIndex } from './export-truth.js';
import type { FilePlan, IndexFileKind, PlanContext, RemovalCounts } from './index-files.js';
import { INDEX_FILE_KINDS, emptyCounts, prepareVec, totalRemovals } from './index-files.js';
import { checkSchema } from './schema-guard.js';
import {
  errorMessage,
  isBusyError,
  openForDryRun,
  openForScrub,
  truncateWal,
} from './sqlite-open.js';

/**
 * Index scrub for governed redaction (umbrella bead compile-then-govern-39z.19).
 *
 * A redaction rewrites a memory in teamkb.db and scrubs that database's files.
 * The derived search indexes under `<base>/qmd-index/<tenant>/` are separate
 * SQLite files that kept the removed text, found on the live brain 2026-10-04:
 *
 *   1. qmd's BM25 cache keeps a soft-deleted (`active = 0`) document row and
 *      its `content` row after a file changes, and its FTS5 segments keep the
 *      old tokens until a rebuild.
 *   2. the native FTS5 index keeps the old row of a moved document, and its
 *      `-wal` keeps the text until a checkpoint truncates it.
 *   3. there is one directory PER TENANT (the API's tenant and the plugin's
 *      `local` tenant at least), and a reindex touches only the one it runs for.
 *   4. the dense sidecar stores a 160-character plaintext snippet per document.
 *
 * For EVERY tenant directory it discovers (no tenant names are hard-coded),
 * this reconciles each index file against kb-export — the source of truth for
 * what should be indexed — and deletes rows whose document is not exported at
 * that path with that content, qmd's inactive rows, orphaned qmd `content`
 * and vector rows, and qmd's derived LLM cache; rebuilds and optimizes both
 * FTS5 indexes; then, with `secure_delete` on, truncates the WAL, runs
 * VACUUM and truncates the WAL again. An optional byte scan of every file
 * under the index directory checks for caller-supplied removed fragments and
 * reports file names and counts, never the fragment text.
 *
 * Fail-closed guards: an unexpected table layout refuses the file
 * (`schema_refused`); a busy database is reported by name (`busy`); a
 * reconcile that would remove more than a quarter of a file's documents is
 * refused (`mass_removal_refused`) unless the caller allows it; a missing or
 * empty export tree disables reconciliation instead of emptying the index.
 *
 * Removed rows are re-added from kb-export by the next reindex / refresh, so
 * the scrub costs recall only for documents whose export is stale.
 */

/** Per-file outcome. */
export type IndexFileStatus =
  | 'clean'
  | 'scrubbed'
  | 'would_scrub'
  | 'busy'
  | 'schema_refused'
  | 'mass_removal_refused'
  | 'failed';

export interface IndexFileReport {
  kind: IndexFileKind['kind'];
  /** Path relative to the index directory, e.g. `local/native-fts5.sqlite`. */
  file: string;
  status: IndexFileStatus;
  /** Rows removed (live) or that would be removed (dry run). */
  removed: RemovalCounts;
  ftsRebuilt: boolean;
  walTruncated: boolean;
  vacuumed: boolean;
  /** Table/column names, step names and SQLite messages — never row data. */
  errors: string[];
}

export interface TenantScrubReport {
  tenant: string;
  files: IndexFileReport[];
}

export interface IndexFragmentScan {
  filesScanned: number;
  fragmentsChecked: number;
  /** Fragments whose bytes are still in some file under the index directory. */
  residualFragments: number;
  /** Of those, how many no current export file (other than a dropped memory's) explains. */
  unexplainedResidualFragments: number;
  residualFiles: Array<{ file: string; fragments: number }>;
  /** Export doc ids that still hold a residual fragment — other memories to look at. */
  explainedBy: string[];
}

export interface IndexScrubReport {
  indexDir: string;
  exportDir: string;
  dryRun: boolean;
  /** False when the index directory does not exist (nothing to scrub). */
  indexDirExists: boolean;
  /** False when kb-export is missing/empty: only targeted, inactive and orphan rows are removed. */
  exportPresent: boolean;
  tenants: TenantScrubReport[];
  fragmentScan: IndexFragmentScan | null;
  warnings: string[];
  /** Some file had an unexpected layout and was not touched. */
  schemaRefused: boolean;
  /** Every file was scrubbed (or, dry run, read) and no unexplained fragment remains. */
  complete: boolean;
}

export interface IndexScrubOptions {
  /** The qmd-index base directory holding one subdirectory per tenant. */
  indexDir: string;
  /** The git-exporter output tree (kb-export). */
  exportDir: string;
  dryRun?: boolean;
  /** Memory ids whose rows go regardless of the export (a redaction in progress). */
  dropMemoryIds?: readonly string[];
  /** Removed text to byte-scan for. Held in memory only; never written or reported. */
  fragments?: readonly string[];
  /**
   * When true, a residual fragment that some OTHER memory's current export
   * file still holds counts as explained (the redaction CLI's rule, matching
   * its database scan). When false (standalone default), any residual is
   * incomplete.
   */
  explainedResidualIsComplete?: boolean;
  /** Allow a reconcile to remove more than the mass-removal limit. */
  allowMassRemoval?: boolean;
  /** SQLite busy wait per statement (default 2000 ms). */
  busyTimeoutMs?: number;
  /** Chars the dense index embedded per doc (default 2000, the indexer default). */
  denseMaxDocChars?: number;
}

/** A reconcile removing more than this share of a file's documents is refused. */
const MASS_REMOVAL_FRACTION = 0.25;
/** …unless it removes no more than this many. */
export const MASS_REMOVAL_FLOOR = 50;

const DEFAULT_BUSY_TIMEOUT_MS = 2000;

/** Tenant directories under the index dir: real directories holding a known index file. */
export function discoverTenants(indexDir: string): string[] {
  if (!existsSync(indexDir)) return [];
  return readdirSync(indexDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((tenant) =>
      INDEX_FILE_KINDS.some((kind) => existsSync(join(indexDir, tenant, kind.relativePath))),
    )
    .sort();
}

/** Every regular file under a directory (symlinks are not followed). */
export function listFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesUnder(path));
    else if (entry.isFile() && lstatSync(path).isFile()) out.push(path);
  }
  return out.sort();
}

function isMassRemoval(plan: FilePlan): boolean {
  const stale = plan.counts.staleDocuments;
  return (
    stale > MASS_REMOVAL_FLOOR && stale > Math.ceil(plan.activeDocuments * MASS_REMOVAL_FRACTION)
  );
}

function newFileReport(kind: IndexFileKind, file: string): IndexFileReport {
  return {
    kind: kind.kind,
    file,
    status: 'failed',
    removed: emptyCounts(),
    ftsRebuilt: false,
    walTruncated: false,
    vacuumed: false,
    errors: [],
  };
}

/** Read-only: plan only. */
function dryRunFile(path: string, kind: IndexFileKind, ctx: PlanContext, report: IndexFileReport) {
  const db = openForDryRun(path);
  try {
    prepareVec(db, kind);
    const problems = checkSchema(db, kind.schema);
    if (problems.length > 0) {
      report.status = 'schema_refused';
      report.errors.push(...problems);
      return;
    }
    const plan = kind.plan(db, ctx);
    report.removed = plan.counts;
    if (isMassRemoval(plan)) {
      report.status = 'mass_removal_refused';
      report.errors.push(massRemovalMessage(plan));
      return;
    }
    report.status = totalRemovals(plan.counts) > 0 ? 'would_scrub' : 'clean';
  } finally {
    db.close();
  }
}

function massRemovalMessage(plan: FilePlan): string {
  return (
    `reconcile would remove ${plan.counts.staleDocuments} of ${plan.activeDocuments} documents; ` +
    'reindex this tenant first, check --export-dir, or pass --allow-mass-removal'
  );
}

/** Delete + rebuild inside one IMMEDIATE transaction. Returns false when refused. */
function deleteAndRebuild(
  db: Database.Database,
  kind: IndexFileKind,
  ctx: PlanContext,
  report: IndexFileReport,
  allowMassRemoval: boolean,
): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const plan = kind.plan(db, ctx);
    report.removed = plan.counts;
    if (!allowMassRemoval && isMassRemoval(plan)) {
      db.exec('ROLLBACK');
      report.status = 'mass_removal_refused';
      report.errors.push(massRemovalMessage(plan));
      return false;
    }
    plan.apply(db);
    db.exec('COMMIT');
    report.ftsRebuilt = kind.kind !== 'dense';
    return true;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** WAL truncate → VACUUM → WAL truncate. Busy steps are recorded, not thrown. */
function compact(db: Database.Database, report: IndexFileReport): void {
  if (!truncateWal(db)) report.errors.push('wal-checkpoint: blocked by another connection');
  db.exec('VACUUM');
  report.vacuumed = true;
  report.walTruncated = truncateWal(db);
  if (!report.walTruncated) {
    report.errors.push('wal-checkpoint-after-vacuum: blocked by another connection');
  }
}

function liveScrubFile(
  path: string,
  kind: IndexFileKind,
  ctx: PlanContext,
  report: IndexFileReport,
  opts: IndexScrubOptions,
): void {
  const db = openForScrub(path, opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
  try {
    prepareVec(db, kind);
    const problems = checkSchema(db, kind.schema);
    if (problems.length > 0) {
      report.status = 'schema_refused';
      report.errors.push(...problems);
      return;
    }
    db.pragma('secure_delete = ON');
    if (!deleteAndRebuild(db, kind, ctx, report, opts.allowMassRemoval === true)) return;
    compact(db, report);
    report.status = report.errors.length === 0 ? 'scrubbed' : 'busy';
  } finally {
    db.close();
  }
}

function scrubFile(
  indexDir: string,
  tenant: string,
  kind: IndexFileKind,
  ctx: PlanContext,
  opts: IndexScrubOptions,
): IndexFileReport | null {
  const path = join(indexDir, tenant, kind.relativePath);
  if (!existsSync(path)) return null;
  const report = newFileReport(kind, relative(indexDir, path));
  try {
    if (opts.dryRun === true) dryRunFile(path, kind, ctx, report);
    else liveScrubFile(path, kind, ctx, report, opts);
  } catch (error) {
    report.status = isBusyError(error) ? 'busy' : 'failed';
    report.errors.push(
      isBusyError(error)
        ? `database is busy (held by another process): ${errorMessage(error)}`
        : errorMessage(error),
    );
  }
  return report;
}

/** Export doc ids (excluding dropped memories) that hold each fragment. */
function explainResiduals(
  truth: ExportTruth,
  fragments: readonly string[],
  residual: readonly number[],
  dropMemoryIds: ReadonlySet<string>,
): { unexplained: number; explainedBy: string[] } {
  const explainedBy = new Set<string>();
  let unexplained = 0;
  for (const index of residual) {
    const fragment = fragments[index]!;
    let explained = false;
    for (const doc of truth.byDocId.values()) {
      if (dropMemoryIds.has(memoryIdOfPath(doc.name))) continue;
      if (doc.content.includes(fragment)) {
        explainedBy.add(doc.docId);
        explained = true;
      }
    }
    if (!explained) unexplained += 1;
  }
  return { unexplained, explainedBy: [...explainedBy].sort() };
}

function scanIndexDir(
  opts: IndexScrubOptions,
  truth: ExportTruth,
  dropMemoryIds: ReadonlySet<string>,
): IndexFragmentScan {
  const fragments = opts.fragments ?? [];
  const scan = scanFilesForFragments(listFilesUnder(opts.indexDir), fragments);
  const { unexplained, explainedBy } = explainResiduals(
    truth,
    fragments,
    scan.residualFragmentIndexes,
    dropMemoryIds,
  );
  return {
    filesScanned: scan.filesScanned.length,
    fragmentsChecked: scan.fragmentCount,
    residualFragments: scan.residualFragmentIndexes.length,
    unexplainedResidualFragments: unexplained,
    residualFiles: scan.hits.map((hit) => ({
      file: relative(opts.indexDir, hit.file),
      fragments: hit.fragments,
    })),
    explainedBy,
  };
}

const READ_OK: ReadonlySet<IndexFileStatus> = new Set(['clean', 'scrubbed', 'would_scrub']);

function isComplete(
  tenants: readonly TenantScrubReport[],
  scan: IndexFragmentScan | null,
  opts: IndexScrubOptions,
): boolean {
  const filesOk = tenants.every((t) => t.files.every((f) => READ_OK.has(f.status)));
  if (!filesOk) return false;
  if (scan === null || opts.dryRun === true) return true;
  const residual =
    opts.explainedResidualIsComplete === true
      ? scan.unexplainedResidualFragments
      : scan.residualFragments;
  return residual === 0;
}

/**
 * Scrub (or, with `dryRun`, report on) every tenant's derived indexes. Never
 * throws for a per-file problem: each lands in that file's report. The caller
 * maps `schemaRefused` / `complete` to an exit code.
 */
export function scrubIndexes(opts: IndexScrubOptions): IndexScrubReport {
  const truth = loadExportTruth(opts.exportDir, opts.denseMaxDocChars);
  const dropMemoryIds = new Set(opts.dropMemoryIds ?? []);
  const ctx: PlanContext = { truth, qmdTruth: qmdTruthIndex(truth), dropMemoryIds };
  const warnings: string[] = [];
  if (!truth.present) {
    warnings.push(
      'export tree is missing or empty: reconcile skipped (only targeted, inactive and orphan rows are removed)',
    );
  }
  const indexDirExists = existsSync(opts.indexDir);
  const tenants = discoverTenants(opts.indexDir).map((tenant) => ({
    tenant,
    files: INDEX_FILE_KINDS.map((kind) => scrubFile(opts.indexDir, tenant, kind, ctx, opts)).filter(
      (report): report is IndexFileReport => report !== null,
    ),
  }));
  const fragmentScan =
    opts.fragments !== undefined && opts.fragments.length > 0
      ? scanIndexDir(opts, truth, dropMemoryIds)
      : null;
  return {
    indexDir: opts.indexDir,
    exportDir: opts.exportDir,
    dryRun: opts.dryRun === true,
    indexDirExists,
    exportPresent: truth.present,
    tenants,
    fragmentScan,
    warnings,
    schemaRefused: tenants.some((t) => t.files.some((f) => f.status === 'schema_refused')),
    complete: isComplete(tenants, fragmentScan, opts),
  };
}
