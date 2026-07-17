import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

import { getExportableCollections } from '../collections/collection-registry.js';
import { Fts5Backend, type Fts5SearchHit } from './fts5-backend.js';

/**
 * Persistent native FTS5 index over the git-exporter output tree — the piece
 * that activates the dormant `Fts5Backend` (bead 0t9.2) on the production
 * query path (retrieval epic, bead qmd-team-intent-kb-vps.2).
 *
 * Document ids are the same `qmd://<collection>/<id>.md` citations the qmd
 * binary emits, so the two backends' result lists join by id for RRF fusion.
 * The index is DERIVED data (like the qmd index itself): cheaply rebuildable
 * from kb-export, deliberately outside backup scope, stored per-tenant under
 * the qmd-index dir.
 *
 * Freshness is incremental: a `files` bookkeeping table records each indexed
 * file's mtime; `ensureFresh()` stats the export tree (cheap — a readdir+stat
 * sweep, no content reads) and re-reads only added/changed files, removing
 * deleted ones. A TTL throttles the sweep so per-query overhead stays flat.
 */
export class NativeIndexManager {
  private readonly backend: Fts5Backend;
  private readonly db: Database.Database;
  private readonly exportDir: string;
  private readonly refreshTtlMs: number;
  private lastRefreshMs = 0;

  private readonly selectFiles: Database.Statement;
  private readonly upsertFile: Database.Statement;
  private readonly deleteFile: Database.Statement;

  constructor(opts: { exportDir: string; indexPath: string; refreshTtlMs?: number }) {
    this.exportDir = opts.exportDir;
    this.refreshTtlMs = opts.refreshTtlMs ?? 15_000;
    if (opts.indexPath !== ':memory:') {
      mkdirSync(dirname(opts.indexPath), { recursive: true });
    }
    this.db = new Database(opts.indexPath);
    this.backend = new Fts5Backend({ db: this.db });
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, doc_id TEXT NOT NULL, mtime_ms REAL NOT NULL)',
    );
    this.selectFiles = this.db.prepare('SELECT path, doc_id, mtime_ms FROM files');
    this.upsertFile = this.db.prepare(
      'INSERT INTO files(path, doc_id, mtime_ms) VALUES (?, ?, ?) ' +
        'ON CONFLICT(path) DO UPDATE SET doc_id = excluded.doc_id, mtime_ms = excluded.mtime_ms',
    );
    this.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
  }

  /**
   * Bring the index up to date with the export tree if the TTL has elapsed.
   * Returns the number of files (re)indexed — 0 on a no-op sweep.
   */
  ensureFresh(nowMs: number = Date.now()): number {
    if (nowMs - this.lastRefreshMs < this.refreshTtlMs) return 0;
    this.lastRefreshMs = nowMs;

    // Current on-disk state of every exportable collection.
    const onDisk = new Map<string, { docId: string; mtimeMs: number; collection: string }>();
    for (const def of getExportableCollections()) {
      const dir = join(this.exportDir, def.sourceSubdir);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const path = join(dir, name);
        let mtimeMs: number;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {
          continue; // deleted between readdir and stat
        }
        onDisk.set(path, { docId: `qmd://${def.name}/${name}`, mtimeMs, collection: def.name });
      }
    }

    const stored = new Map<string, { docId: string; mtimeMs: number }>();
    for (const row of this.selectFiles.all() as Array<{
      path: string;
      doc_id: string;
      mtime_ms: number;
    }>) {
      stored.set(row.path, { docId: row.doc_id, mtimeMs: row.mtime_ms });
    }

    // Collect the whole delta first, then write it in ONE batch: per-doc
    // index() calls are one SQLite transaction (fsync) each, which turns a
    // 17k-file first build into minutes; batched it is seconds.
    // New docs take the pure-insert fast path; only CHANGED docs pay the
    // FTS5 upsert delete (id is UNINDEXED → each delete scans the virtual
    // table, so 17k first-build upserts would be O(n²) minutes).
    const toInsert: Array<{ id: string; content: string; collection: string }> = [];
    const toReplace: Array<{ id: string; content: string; collection: string }> = [];
    const metaUpserts: Array<{ path: string; docId: string; mtimeMs: number }> = [];
    for (const [path, info] of onDisk) {
      const prior = stored.get(path);
      if (prior !== undefined && prior.mtimeMs === info.mtimeMs) continue;
      let content: string;
      try {
        content = readFileSync(path, 'utf8');
      } catch {
        continue; // deleted mid-sweep; the next sweep drops it
      }
      const doc = { id: info.docId, content, collection: info.collection };
      if (prior === undefined) toInsert.push(doc);
      else toReplace.push(doc);
      metaUpserts.push({ path, docId: info.docId, mtimeMs: info.mtimeMs });
    }

    const toRemove: Array<{ path: string; docId: string }> = [];
    for (const [path, prior] of stored) {
      if (onDisk.has(path)) continue;
      toRemove.push({ path, docId: prior.docId });
    }

    if (toInsert.length > 0) this.backend.insert(toInsert);
    if (toReplace.length > 0) this.backend.index(toReplace);
    if (toRemove.length > 0) this.backend.remove(toRemove.map((r) => r.docId));
    if (metaUpserts.length > 0 || toRemove.length > 0) {
      const tx = this.db.transaction(() => {
        for (const m of metaUpserts) this.upsertFile.run(m.path, m.docId, m.mtimeMs);
        for (const r of toRemove) this.deleteFile.run(r.path);
      });
      tx();
    }

    return toInsert.length + toReplace.length;
  }

  /**
   * BM25 search over the export tree, filtered to `allowedCollections`
   * (empty array = no filter). Refreshes the index first (TTL-throttled).
   */
  search(query: string, k: number, allowedCollections: readonly string[]): Fts5SearchHit[] {
    this.ensureFresh();
    const hits = this.backend.search(query, k);
    if (allowedCollections.length === 0) return hits;
    return hits.filter((h) => allowedCollections.includes(h.collection));
  }

  count(): number {
    return this.backend.count();
  }

  close(): void {
    this.backend.close();
  }
}

/**
 * Process-wide manager cache keyed by index path, so callers that construct a
 * fresh `QmdAdapter` per request (the plugin's MCP handlers do) share one open
 * index + TTL clock instead of re-opening SQLite on every search. `:memory:`
 * paths are never cached — each would be a distinct empty database anyway.
 */
const managerCache = new Map<string, NativeIndexManager>();

export function getNativeIndexManager(opts: {
  exportDir: string;
  indexPath: string;
  refreshTtlMs?: number;
}): NativeIndexManager {
  if (opts.indexPath === ':memory:') return new NativeIndexManager(opts);
  const cached = managerCache.get(opts.indexPath);
  if (cached !== undefined) return cached;
  const manager = new NativeIndexManager(opts);
  managerCache.set(opts.indexPath, manager);
  return manager;
}
