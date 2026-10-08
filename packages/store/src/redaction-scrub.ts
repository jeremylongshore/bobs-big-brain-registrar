/**
 * Physical scrub for governed redaction (Epic K bead K3).
 *
 * A redaction UPDATE changes what a query returns. It does not by itself remove
 * the old bytes from the files: SQLite leaves replaced text in freed cells and
 * free pages, in the FTS5 index segments (`curated_memories_fts` is an
 * external-content index kept by triggers), and in the write-ahead log until it
 * is checkpointed. These helpers close that gap and then let the caller PROVE it
 * with a byte scan of the database, `-wal` and `-shm` files.
 *
 * Order of use:
 *   1. {@link enableSecureDelete}  — before the UPDATE, so freed cells are zeroed.
 *   2. the redaction transaction   — the caller's content rewrite + receipts.
 *   3. {@link scrubFreedPages}     — FTS rebuild, WAL truncate, VACUUM, WAL truncate.
 *   4. {@link scanStoreFilesForFragments} — byte scan for the removed text.
 *
 * None of this touches `audit_events`. The hash chain covers audit rows only,
 * so a content rewrite leaves every existing receipt verifiable as it was.
 *
 * @module redaction-scrub
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';

/** What each physical-scrub step did. `errors` is empty on a complete scrub. */
export interface PhysicalScrubReport {
  /** The FTS5 index was rebuilt from the current table content. */
  ftsRebuilt: boolean;
  /** The write-ahead log was checkpointed and truncated to zero bytes. */
  walTruncated: boolean;
  /** The database file was rewritten without free pages. */
  vacuumed: boolean;
  /** One entry per step that did not complete. */
  errors: string[];
}

/**
 * Turn on `secure_delete` for this connection so content freed by the redaction
 * UPDATE (and by the FTS rebuild) is overwritten with zeros rather than left in
 * place. Returns true when the pragma reports it is on.
 */
export function enableSecureDelete(db: Database.Database): boolean {
  const value = db.pragma('secure_delete = ON', { simple: true });
  return value === 1;
}

/** Checkpoint the WAL and truncate it; false when another connection blocked it. */
function truncateWal(db: Database.Database): boolean {
  const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  return rows[0] !== undefined && rows[0].busy === 0;
}

/**
 * Remove the bytes a redaction freed: rebuild the FTS5 index, truncate the WAL,
 * VACUUM the database and truncate the WAL again (VACUUM itself writes through
 * the WAL). Must run OUTSIDE a transaction. Never throws: a step that cannot
 * complete — typically because another process holds the database — is recorded
 * in `errors`, and the caller decides how loudly to report it.
 */
export function scrubFreedPages(db: Database.Database): PhysicalScrubReport {
  const report: PhysicalScrubReport = {
    ftsRebuilt: false,
    walTruncated: false,
    vacuumed: false,
    errors: [],
  };
  const step = (name: string, run: () => boolean): boolean => {
    try {
      if (run()) return true;
      report.errors.push(`${name}: blocked by another connection`);
    } catch (e) {
      report.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return false;
  };

  report.ftsRebuilt = step('fts-rebuild', () => {
    const hasFts =
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('curated_memories_fts') !== undefined;
    if (hasFts) {
      db.exec("INSERT INTO curated_memories_fts(curated_memories_fts) VALUES ('rebuild')");
    }
    return true;
  });
  step('wal-checkpoint', () => truncateWal(db));
  report.vacuumed = step('vacuum', () => {
    db.exec('VACUUM');
    return true;
  });
  report.walTruncated = step('wal-checkpoint-after-vacuum', () => truncateWal(db));
  return report;
}

/** The on-disk files of a SQLite store: the database, its WAL and its shm index. */
export function storeFilesOf(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

/** Result of a byte scan of the store files for removed text. */
export interface FragmentScanReport {
  /** Files that existed and were scanned. */
  filesScanned: string[];
  /** How many fragments were searched for. */
  fragmentCount: number;
  /**
   * Indexes (into the caller's fragment list) of fragments still present in at
   * least one file. Indexes, not text: the report never carries a fragment.
   */
  residualFragmentIndexes: number[];
  /** Files in which at least one fragment was found. */
  residualFiles: string[];
}

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Scan one file for every needle, in chunks that overlap by the longest needle.
 * Adds each needle index found to `found`; returns how many distinct needles
 * this file holds.
 */
function scanFile(path: string, needles: Buffer[], found: Set<number>): number {
  const overlap = Math.max(0, ...needles.map((n) => n.length)) - 1;
  const size = statSync(path).size;
  const buffer = Buffer.alloc(SCAN_CHUNK_BYTES + Math.max(overlap, 0));
  const inFile = new Set<number>();
  const fd = openSync(path, 'r');
  try {
    let position = 0;
    let carried = 0;
    while (position < size) {
      const read = readSync(fd, buffer, carried, SCAN_CHUNK_BYTES, position);
      if (read <= 0) break;
      const window = buffer.subarray(0, carried + read);
      needles.forEach((needle, index) => {
        if (needle.length === 0 || inFile.has(index)) return;
        if (window.indexOf(needle) !== -1) inFile.add(index);
      });
      position += read;
      carried = Math.min(Math.max(overlap, 0), window.length);
      buffer.copyWithin(0, window.length - carried, window.length);
    }
  } finally {
    closeSync(fd);
  }
  for (const index of inFile) found.add(index);
  return inFile.size;
}

/** One file that still holds removed text: its path and how many fragments. Never the text. */
export interface FragmentFileHit {
  file: string;
  /** Distinct fragments found in this file. */
  fragments: number;
}

/** Result of a byte scan of an arbitrary file list for removed text. */
export interface FilesFragmentScanReport {
  /** Files that existed and were scanned. */
  filesScanned: string[];
  /** How many fragments were searched for. */
  fragmentCount: number;
  /** Indexes (into the caller's fragment list) of fragments found anywhere. Never text. */
  residualFragmentIndexes: number[];
  /** Files holding at least one fragment, with a per-file count. */
  hits: FragmentFileHit[];
}

/**
 * Byte-scan any list of files for each fragment's UTF-8 bytes. Missing files are
 * skipped (not an error). The report carries file paths, counts and fragment
 * INDEXES only, so it can be logged without disclosing what it looked for.
 * Same blind spot as {@link scanStoreFilesForFragments}: only contiguous bytes
 * are found.
 */
export function scanFilesForFragments(
  files: readonly string[],
  fragments: readonly string[],
): FilesFragmentScanReport {
  const needles = fragments.map((f) => Buffer.from(f, 'utf8'));
  const found = new Set<number>();
  const filesScanned: string[] = [];
  const hits: FragmentFileHit[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    filesScanned.push(file);
    if (needles.length === 0) continue;
    const count = scanFile(file, needles, found);
    if (count > 0) hits.push({ file, fragments: count });
  }
  return {
    filesScanned,
    fragmentCount: fragments.length,
    residualFragmentIndexes: [...found].sort((a, b) => a - b),
    hits,
  };
}

/**
 * Byte-scan the store's files (database, `-wal`, `-shm`) for each fragment's
 * UTF-8 bytes. This is the evidence a redaction's physical scrub worked: after
 * {@link scrubFreedPages}, a removed fragment should appear in none of them.
 *
 * Limits, stated plainly: the scan finds a fragment only where its bytes are
 * contiguous in the file. A row larger than a database page spills into
 * overflow pages, so a fragment that straddled a page boundary in the OLD row
 * can be missed. It also says nothing about copies outside these three files
 * (backups, exports, other indexes).
 */
export function scanStoreFilesForFragments(
  dbPath: string,
  fragments: readonly string[],
): FragmentScanReport {
  const scan = scanFilesForFragments(storeFilesOf(dbPath), fragments);
  return {
    filesScanned: scan.filesScanned,
    fragmentCount: scan.fragmentCount,
    residualFragmentIndexes: scan.residualFragmentIndexes,
    residualFiles: scan.hits.map((hit) => hit.file),
  };
}

/** A live row that still contains a searched fragment — table and id, never text. */
export interface FragmentRowHit {
  table: 'curated_memories' | 'candidates' | 'audit_events';
  id: string;
}

const ROW_SEARCHES: ReadonlyArray<{ table: FragmentRowHit['table']; columns: readonly string[] }> =
  [
    {
      table: 'curated_memories',
      columns: ['content', 'title', 'metadata_json', 'policy_evaluations_json'],
    },
    { table: 'candidates', columns: ['content', 'title', 'metadata_json'] },
    { table: 'audit_events', columns: ['reason', 'details_json'] },
  ];

/**
 * Find LIVE rows whose text columns still contain `fragment`. Used to explain a
 * byte-scan hit: text that is still in a current row (another memory holding
 * the same line, or the same secret) is not a scrub failure, it is a second row
 * to redact. Returns table + id only.
 */
export function findRowsContaining(
  db: Database.Database,
  fragment: string,
  limit = 20,
): FragmentRowHit[] {
  const hits: FragmentRowHit[] = [];
  for (const search of ROW_SEARCHES) {
    const where = search.columns.map((c) => `instr(COALESCE(${c}, ''), @fragment) > 0`);
    const rows = db
      .prepare(`SELECT id FROM ${search.table} WHERE ${where.join(' OR ')} LIMIT @limit`)
      .all({ fragment, limit }) as Array<{ id: string }>;
    for (const row of rows) hits.push({ table: search.table, id: row.id });
  }
  return hits;
}
