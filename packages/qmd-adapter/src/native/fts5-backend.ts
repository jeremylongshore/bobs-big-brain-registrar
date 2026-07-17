import Database from 'better-sqlite3';
import type { RetrievalFn } from '../eval/eval-types.js';

/**
 * Native FTS5 (BM25) retrieval backend — bead 0t9.2.
 *
 * A keyword retriever built on SQLite's FTS5 full-text index, ranked by BM25. It
 * is a model-free, in-process alternative to qmd's `qmd search` that drops the
 * external Bun binary dependency entirely (the council's "lean" path; ADR 038).
 * Same shape as `QmdSearchResult` (file→id, score, snippet, collection), so it
 * slots behind the adapter's retrieval seam and runs through the eval harness
 * (bead 0t9.6) against the same datasets as qmd BM25, for a comparable number.
 *
 * Semantic recall (dense vectors) is a SEPARATE concern (bead 0t9.3) — this is
 * the keyword half only.
 */

export interface IndexedDoc {
  /** Stable doc identifier (e.g. the qmd:// citation / file path). */
  id: string;
  content: string;
  collection?: string;
}

export interface Fts5SearchHit {
  id: string;
  /** BM25 relevance, higher = more relevant (FTS5's bm25() negated). */
  score: number;
  snippet: string;
  collection: string;
}

/**
 * Build a safe FTS5 MATCH expression from a free-text query: extract word tokens
 * and quote each as a literal term joined by implicit AND. Quoting neutralizes
 * FTS5 operators (`AND` / `OR` / `NOT` / `*` / `"`), so a user query can never be
 * a query-injection or a syntax error. Returns '' when there are no usable tokens.
 */
export function buildFts5MatchQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(' ');
}

interface SearchRow {
  id: string;
  collection: string;
  snippet: string;
  rank: number;
}

export class Fts5Backend {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly searchStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(opts: { path?: string; db?: Database.Database } = {}) {
    // An injected db lets a caller (NativeIndexManager) share one SQLite file
    // between the FTS5 docs table and its own bookkeeping tables.
    this.db = opts.db ?? new Database(opts.path ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(id UNINDEXED, collection UNINDEXED, content)',
    );
    this.insertStmt = this.db.prepare('INSERT INTO docs(id, collection, content) VALUES (?, ?, ?)');
    this.deleteStmt = this.db.prepare('DELETE FROM docs WHERE id = ?');
    this.searchStmt = this.db.prepare(
      "SELECT id, collection, snippet(docs, 2, '', '', '…', 16) AS snippet, bm25(docs) AS rank " +
        'FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?',
    );
    this.countStmt = this.db.prepare('SELECT count(*) AS n FROM docs');
  }

  /** Index documents (upsert by id — a re-indexed doc replaces its prior copy). */
  index(docs: readonly IndexedDoc[]): void {
    const tx = this.db.transaction((items: readonly IndexedDoc[]) => {
      for (const doc of items) {
        this.deleteStmt.run(doc.id);
        this.insertStmt.run(doc.id, doc.collection ?? '', doc.content);
      }
    });
    tx(docs);
  }

  /**
   * Insert documents KNOWN to be absent from the index — skips the per-doc
   * delete. `id` is UNINDEXED in the FTS5 table, so each upsert delete is a
   * full scan of the virtual table; on a bulk first build that turns 17k
   * inserts into O(n²) minutes. Callers that track index membership (the
   * NativeIndexManager's files table) use this for new docs and reserve
   * `index()`/`remove()` for the few changed/deleted ones.
   */
  insert(docs: readonly IndexedDoc[]): void {
    const tx = this.db.transaction((items: readonly IndexedDoc[]) => {
      for (const doc of items) {
        this.insertStmt.run(doc.id, doc.collection ?? '', doc.content);
      }
    });
    tx(docs);
  }

  /** Remove documents by id (no-op for ids that are not indexed). */
  remove(ids: readonly string[]): void {
    const tx = this.db.transaction((items: readonly string[]) => {
      for (const id of items) this.deleteStmt.run(id);
    });
    tx(ids);
  }

  /** Remove every indexed document. */
  clear(): void {
    this.db.exec('DELETE FROM docs');
  }

  /** BM25 keyword search → top-k hits, most relevant first. */
  search(query: string, k = 10): Fts5SearchHit[] {
    const match = buildFts5MatchQuery(query);
    if (match.length === 0) return [];
    const rows = this.searchStmt.all(match, k) as SearchRow[];
    return rows.map((r) => ({
      id: r.id,
      collection: r.collection,
      snippet: r.snippet,
      score: -r.rank, // FTS5 bm25() is negative (best = most negative); negate so higher = better
    }));
  }

  count(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}

/** Adapt an `Fts5Backend` to the eval harness's `RetrievalFn` (ranked ids only). */
export function fts5RetrievalFn(backend: Fts5Backend): RetrievalFn {
  return (query: string, k: number) => Promise.resolve(backend.search(query, k).map((h) => h.id));
}
