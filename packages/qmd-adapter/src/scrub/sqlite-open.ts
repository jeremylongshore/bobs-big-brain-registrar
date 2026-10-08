import { existsSync, readFileSync, statSync } from 'node:fs';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * Opening index databases for the scrub without surprising anyone.
 *
 * LIVE: a normal read-write connection with a SHORT busy timeout, so a
 * database held by the API, an MCP session or a running `qmd update` is
 * reported as busy (by name) instead of hanging the operator's shell.
 *
 * DRY-RUN: must not write. A read-only SQLite connection to a WAL database
 * still CREATES `-wal` and `-shm` when they are absent (measured: better-sqlite3
 * 13 / SQLite 3.5x), so:
 *   - when the WAL is absent or empty, the database file is read into memory
 *     and opened from that buffer (header patched from WAL to rollback mode,
 *     which only changes how the in-memory copy journals). Nothing on disk is
 *     opened for writing, and no file is created.
 *   - when the WAL holds frames, the file is opened read-only in place. The
 *     database and WAL bytes are not changed; SQLite does update read-lock
 *     slots in the existing `-shm` (shared-memory coordination state, which
 *     every reader — including the live API — touches).
 *   - a WAL with frames but no `-shm` cannot be read without creating one, so
 *     the dry run refuses that file instead.
 */

/** True for SQLite's lock-contention errors (SQLITE_BUSY*, SQLITE_LOCKED*). */
export function isBusyError(error: unknown): boolean {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED');
}

/** Message of any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function walFrames(path: string): number {
  const wal = `${path}-wal`;
  return existsSync(wal) ? statSync(wal).size : 0;
}

/** Open a database for a dry run without writing to, or creating, any file. */
export function openForDryRun(path: string): Database.Database {
  if (walFrames(path) === 0) {
    const buffer = readFileSync(path);
    // Bytes 18/19 are the file-format read/write versions: 2 = WAL. An
    // in-memory database cannot use WAL, so present the copy as rollback mode.
    if (buffer.length > 19 && buffer[18] === 2) {
      buffer[18] = 1;
      buffer[19] = 1;
    }
    return new Database(buffer, { readonly: true });
  }
  if (!existsSync(`${path}-shm`)) {
    throw new Error(
      'the WAL holds frames but there is no -shm; a dry run cannot read it without creating one',
    );
  }
  return new Database(path, { readonly: true, fileMustExist: true });
}

/** Open a database read-write for the live scrub, with a bounded busy wait. */
export function openForScrub(path: string, busyTimeoutMs: number): Database.Database {
  return new Database(path, { fileMustExist: true, timeout: busyTimeoutMs });
}

/** True when `name` exists in sqlite_master as a table (virtual or not). */
export function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** Load sqlite-vec when the database holds a vec0 table we must read or delete from. */
export function loadVecIfNeeded(db: Database.Database, vecTable: string): boolean {
  if (!hasTable(db, vecTable)) return false;
  sqliteVec.load(db);
  return true;
}

/** Checkpoint and truncate the WAL; false when another connection kept it from finishing. */
export function truncateWal(db: Database.Database): boolean {
  const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  return rows[0] !== undefined && rows[0].busy === 0;
}
