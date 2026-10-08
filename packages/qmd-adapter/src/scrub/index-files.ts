import type Database from 'better-sqlite3';

import type { ExportTruth, ExportedDoc } from './export-truth.js';
import { memoryIdOfPath, qmdKey } from './export-truth.js';
import { hasTable, loadVecIfNeeded } from './sqlite-open.js';
import type { TableShape } from './schema-guard.js';
import { DENSE_INDEX_SCHEMA, NATIVE_INDEX_SCHEMA, QMD_INDEX_SCHEMA } from './schema-guard.js';

/**
 * The three per-tenant index files and, for each, how to find what must go
 * (plan) and how to remove it (apply). Planning is read-only and runs the same
 * way in a dry run and inside the live scrub's write transaction.
 */

/** Row counts a scrub removes (or, in a dry run, would remove). Counts only — never text. */
export interface RemovalCounts {
  /** Rows for a memory the caller named (a redaction in progress). */
  targetedDocuments: number;
  /** Active rows whose document is not exported at that path with that content. */
  staleDocuments: number;
  /** qmd soft-deleted rows (`active = 0`) — they keep the old content referenced. */
  inactiveDocuments: number;
  /** FTS rows not backed by a kept document. */
  ftsRows: number;
  /** qmd `content` rows no document references. */
  orphanContent: number;
  /** Vector rows (qmd content_vectors, dense vec0) not backed by a kept document. */
  orphanVectors: number;
  /** qmd `llm_cache` rows (derived cache; cleared). */
  cacheRows: number;
  /** native `files` bookkeeping rows dropped so the next refresh re-reads the export. */
  fileRows: number;
}

export function emptyCounts(): RemovalCounts {
  return {
    targetedDocuments: 0,
    staleDocuments: 0,
    inactiveDocuments: 0,
    ftsRows: 0,
    orphanContent: 0,
    orphanVectors: 0,
    cacheRows: 0,
    fileRows: 0,
  };
}

export function totalRemovals(counts: RemovalCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/** What the planners need to know about the world. */
export interface PlanContext {
  truth: ExportTruth;
  /** truth keyed by qmd's (collection, path). */
  qmdTruth: Map<string, ExportedDoc>;
  /** Memory ids whose rows must go regardless of the export (redaction in progress). */
  dropMemoryIds: ReadonlySet<string>;
}

/** A per-file plan: what to delete, and the counts to report. */
export interface FilePlan {
  counts: RemovalCounts;
  /** Active document rows before the scrub (the mass-removal guard's denominator). */
  activeDocuments: number;
  apply: (db: Database.Database) => void;
}

/** One kind of index file. */
export interface IndexFileKind {
  kind: 'qmd' | 'native' | 'dense';
  /** Path relative to the tenant directory. */
  relativePath: string;
  schema: readonly TableShape[];
  /** vec0 table that needs sqlite-vec loaded to read or delete from. */
  vecTable: string | null;
  plan: (db: Database.Database, ctx: PlanContext) => FilePlan;
}

/** Is a document row stale against the export? Returns 'targeted', 'stale' or null (keep). */
function classify(
  ctx: PlanContext,
  memoryPath: string,
  matchesExport: () => boolean,
): 'targeted' | 'stale' | null {
  if (ctx.dropMemoryIds.has(memoryIdOfPath(memoryPath))) return 'targeted';
  // A missing or empty export tree reconciles nothing: treating every row as
  // stale would empty the index on a misconfigured --export-dir.
  if (!ctx.truth.present) return null;
  return matchesExport() ? null : 'stale';
}

function runDeletes(db: Database.Database, sql: string, keys: readonly unknown[]): void {
  if (keys.length === 0) return;
  const stmt = db.prepare(sql);
  for (const key of keys) stmt.run(key);
}

// ── qmd BM25 cache: cache/qmd/index.sqlite ──────────────────────────────────

interface QmdDocRow {
  id: number;
  collection: string;
  path: string;
  hash: string;
  active: number;
}

function planQmd(db: Database.Database, ctx: PlanContext): FilePlan {
  const counts = emptyCounts();
  const docs = db
    .prepare('SELECT id, collection, path, hash, active FROM documents')
    .all() as QmdDocRow[];
  const deleteIds: number[] = [];
  const keepIds = new Set<number>();
  const keepHashes = new Set<string>();
  let activeDocuments = 0;
  for (const doc of docs) {
    if (doc.active !== 1) {
      counts.inactiveDocuments += 1;
      deleteIds.push(doc.id);
      continue;
    }
    activeDocuments += 1;
    const verdict = classify(
      ctx,
      doc.path,
      () => ctx.qmdTruth.get(qmdKey(doc.collection, doc.path))?.qmdHash === doc.hash,
    );
    if (verdict === null) {
      keepIds.add(doc.id);
      keepHashes.add(doc.hash);
      continue;
    }
    counts[verdict === 'targeted' ? 'targetedDocuments' : 'staleDocuments'] += 1;
    deleteIds.push(doc.id);
  }

  const ftsRowids = (
    db.prepare('SELECT rowid AS id FROM documents_fts').all() as Array<{
      id: number;
    }>
  )
    .map((row) => row.id)
    .filter((id) => !keepIds.has(id));
  counts.ftsRows = ftsRowids.length;

  const orphanHashes = (db.prepare('SELECT hash FROM content').all() as Array<{ hash: string }>)
    .map((row) => row.hash)
    .filter((hash) => !keepHashes.has(hash));
  counts.orphanContent = orphanHashes.length;

  const orphanVectors = hasTable(db, 'content_vectors')
    ? (
        db.prepare('SELECT hash, seq FROM content_vectors').all() as Array<{
          hash: string;
          seq: number;
        }>
      ).filter((row) => !keepHashes.has(row.hash))
    : [];
  counts.orphanVectors = orphanVectors.length;

  const hasCache = hasTable(db, 'llm_cache');
  counts.cacheRows = hasCache
    ? (db.prepare('SELECT count(*) AS n FROM llm_cache').get() as { n: number }).n
    : 0;

  return {
    counts,
    activeDocuments,
    apply: (target) => {
      runDeletes(target, 'DELETE FROM documents WHERE id = ?', deleteIds);
      runDeletes(target, 'DELETE FROM documents_fts WHERE rowid = ?', ftsRowids);
      runDeletes(target, 'DELETE FROM content WHERE hash = ?', orphanHashes);
      if (hasTable(target, 'vectors_vec')) {
        runDeletes(
          target,
          'DELETE FROM vectors_vec WHERE hash_seq = ?',
          orphanVectors.map((row) => `${row.hash}_${row.seq}`),
        );
      }
      const delVector = target.prepare('DELETE FROM content_vectors WHERE hash = ? AND seq = ?');
      for (const row of orphanVectors) delVector.run(row.hash, row.seq);
      if (hasCache) target.exec('DELETE FROM llm_cache');
      target.exec("INSERT INTO documents_fts(documents_fts) VALUES ('rebuild')");
      target.exec("INSERT INTO documents_fts(documents_fts) VALUES ('optimize')");
    },
  };
}

// ── native FTS5: native-fts5.sqlite ─────────────────────────────────────────

interface NativeDocRow {
  rowid: number;
  id: string;
  content: string;
}

function planNative(db: Database.Database, ctx: PlanContext): FilePlan {
  const counts = emptyCounts();
  const rows = db.prepare('SELECT rowid, id, content FROM docs').all() as NativeDocRow[];
  const deleteRowids: number[] = [];
  const dropFileDocIds = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const verdict = classify(ctx, row.id, () => {
      const exported = ctx.truth.byDocId.get(row.id);
      return exported !== undefined && exported.content === row.content && !seen.has(row.id);
    });
    if (verdict === null) {
      seen.add(row.id);
      continue;
    }
    deleteRowids.push(row.rowid);
    if (verdict === 'targeted') {
      // Keep the files row: its mtime still matches the (not yet reconciled)
      // export file, so a live refresh does NOT re-read the old text. The
      // exporter's rewrite changes the mtime and the refresh re-adds the doc.
      counts.targetedDocuments += 1;
    } else {
      counts.staleDocuments += 1;
      dropFileDocIds.add(row.id);
    }
  }
  // A doc id that still has a kept row keeps its files row too, or the next
  // refresh would insert a second copy beside the kept one.
  for (const docId of seen) dropFileDocIds.delete(docId);
  const hasFiles = hasTable(db, 'files');
  const fileRows = hasFiles
    ? (db.prepare('SELECT doc_id FROM files').all() as Array<{ doc_id: string }>).filter((row) =>
        dropFileDocIds.has(row.doc_id),
      ).length
    : 0;
  counts.fileRows = fileRows;
  return {
    counts,
    activeDocuments: rows.length,
    apply: (target) => {
      runDeletes(target, 'DELETE FROM docs WHERE rowid = ?', deleteRowids);
      if (hasFiles) runDeletes(target, 'DELETE FROM files WHERE doc_id = ?', [...dropFileDocIds]);
      target.exec("INSERT INTO docs(docs) VALUES ('rebuild')");
      target.exec("INSERT INTO docs(docs) VALUES ('optimize')");
    },
  };
}

// ── dense sidecar: dense-vec.sqlite ─────────────────────────────────────────

interface DenseDocRow {
  rowid: number;
  doc_id: string;
  content_hash: string;
}

function planDense(db: Database.Database, ctx: PlanContext): FilePlan {
  const counts = emptyCounts();
  const rows = db
    .prepare('SELECT rowid, doc_id, content_hash FROM dense_docs')
    .all() as DenseDocRow[];
  const deleteRowids: number[] = [];
  const keepRowids = new Set<number>();
  for (const row of rows) {
    // The stored hash is of the exact text embedded; a mismatch is a row the
    // next dense sync would re-embed anyway, so removing it costs no extra work.
    const verdict = classify(
      ctx,
      row.doc_id,
      () => ctx.truth.byDocId.get(row.doc_id)?.denseHash === row.content_hash,
    );
    if (verdict === null) {
      keepRowids.add(row.rowid);
      continue;
    }
    counts[verdict === 'targeted' ? 'targetedDocuments' : 'staleDocuments'] += 1;
    deleteRowids.push(row.rowid);
  }
  const hasVec = hasTable(db, 'dense_vec');
  const orphanVecRowids = hasVec
    ? (db.prepare('SELECT rowid FROM dense_vec').all() as Array<{ rowid: number }>)
        .map((row) => row.rowid)
        .filter((rowid) => !keepRowids.has(rowid))
    : [];
  counts.orphanVectors = orphanVecRowids.length;
  return {
    counts,
    activeDocuments: rows.length,
    apply: (target) => {
      // vec0 rejects non-INTEGER rowid bindings; BigInt binds as INTEGER.
      if (hasVec) {
        runDeletes(
          target,
          'DELETE FROM dense_vec WHERE rowid = ?',
          orphanVecRowids.map((rowid) => BigInt(rowid)),
        );
      }
      runDeletes(target, 'DELETE FROM dense_docs WHERE rowid = ?', deleteRowids);
    },
  };
}

/** The per-tenant index files the scrub knows, in scrub order. */
export const INDEX_FILE_KINDS: readonly IndexFileKind[] = [
  {
    kind: 'qmd',
    relativePath: 'cache/qmd/index.sqlite',
    schema: QMD_INDEX_SCHEMA,
    vecTable: 'vectors_vec',
    plan: planQmd,
  },
  {
    kind: 'native',
    relativePath: 'native-fts5.sqlite',
    schema: NATIVE_INDEX_SCHEMA,
    vecTable: null,
    plan: planNative,
  },
  {
    kind: 'dense',
    relativePath: 'dense-vec.sqlite',
    schema: DENSE_INDEX_SCHEMA,
    vecTable: 'dense_vec',
    plan: planDense,
  },
];

/** Load sqlite-vec for a kind that has a vec0 table present. */
export function prepareVec(db: Database.Database, kind: IndexFileKind): void {
  if (kind.vecTable !== null) loadVecIfNeeded(db, kind.vecTable);
}
