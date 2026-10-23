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

const QUESTION_STARTERS = new Set(
  'what where when which who why how can could do does is are should would tell explain'.split(' '),
);
const QUESTION_FUNCTION_WORDS = new Set(
  (
    'a an the and or of to for from in on at by with without about as into through ' +
    'what where when which who why how can could do does did is are was were be been being ' +
    'should would will shall may might must have has had i me my we us our you your he she it its they them their ' +
    'this that these those there here please tell explain'
  ).split(' '),
);

/** Only broaden bounded, unquoted natural questions; every term remains literal. */
function questionTerms(query: string): string[] {
  if (query.length > 4096 || query.includes('"') || !/^\p{L}/u.test(query.trim())) return [];
  const tokens =
    query
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!QUESTION_STARTERS.has(tokens[0] ?? '')) return [];
  const terms = [
    ...new Set(tokens.filter((term) => term.length > 1 && !QUESTION_FUNCTION_WORDS.has(term))),
  ];
  return terms.length <= 12 ? terms : [];
}

interface SearchRow {
  rowId: number;
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
  private readonly scopedSearchStmt: Database.Statement;
  private readonly coverageStmt: Database.Statement;
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
    const selectHits =
      "SELECT rowid AS rowId, id, collection, snippet(docs, 2, '', '', '…', 16) AS snippet, bm25(docs) AS rank " +
      'FROM docs WHERE docs MATCH ?';
    this.searchStmt = this.db.prepare(selectHits + ' ORDER BY rank LIMIT ?');
    this.scopedSearchStmt = this.db.prepare(
      selectHits + ' AND collection IN (SELECT value FROM json_each(?)) ORDER BY rank LIMIT ?',
    );
    this.coverageStmt = this.db.prepare(
      'SELECT rowid AS rowId FROM docs WHERE docs MATCH ? AND rowid IN (SELECT value FROM json_each(?))',
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

  private searchRows(match: string, k: number, allowedCollections: readonly string[]): SearchRow[] {
    return (
      allowedCollections.length === 0
        ? this.searchStmt.all(match, k)
        : this.scopedSearchStmt.all(match, JSON.stringify(allowedCollections), k)
    ) as SearchRow[];
  }

  private toHit(row: SearchRow): Fts5SearchHit {
    return { id: row.id, collection: row.collection, snippet: row.snippet, score: -row.rank };
  }

  /** BM25 keyword search; apply collection scope before the top-k cutoff. */
  search(query: string, k = 10, allowedCollections: readonly string[] = []): Fts5SearchHit[] {
    const match = buildFts5MatchQuery(query);
    if (match.length === 0) return [];
    return this.searchRows(match, k, allowedCollections).map((row) => this.toHit(row));
  }

  /** Last-resort question retrieval. Caller must first exhaust all strict/dense arms. */
  searchQuestionFallback(
    query: string,
    k = 10,
    allowedCollections: readonly string[] = [],
  ): Fts5SearchHit[] {
    const terms = questionTerms(query);
    if (terms.length === 0 || !Number.isSafeInteger(k) || k <= 0) return [];
    const match = terms.map((term) => `"${term}"`).join(' OR ');
    const rows = this.searchRows(match, Math.min(200, Math.max(64, k * 4)), allowedCollections);
    const coverage = this.countCoverage(terms, rows);
    const minimum = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.6);
    return rows
      .filter((row) => (coverage.get(row.rowId) ?? 0) >= minimum)
      .sort(
        (a, b) => (coverage.get(b.rowId) ?? 0) - (coverage.get(a.rowId) ?? 0) || a.rank - b.rank,
      )
      .slice(0, k)
      .map((row) => this.toHit(row));
  }

  private countCoverage(terms: readonly string[], rows: readonly SearchRow[]): Map<number, number> {
    const coverage = new Map<number, number>();
    const ids = JSON.stringify(rows.map((row) => row.rowId));
    for (const term of terms) {
      const matches = this.coverageStmt.all(`"${term}"`, ids) as { rowId: number }[];
      for (const row of matches) coverage.set(row.rowId, (coverage.get(row.rowId) ?? 0) + 1);
    }
    return coverage;
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
