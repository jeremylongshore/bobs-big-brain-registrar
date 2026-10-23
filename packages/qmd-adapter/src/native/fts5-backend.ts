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
const QUESTION_MAX_DOCS = 25000;
const QUESTION_MAX_TERM_POSTINGS = 2000;
const QUESTION_MAX_TOTAL_POSTINGS = 10000;
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
  private readonly countStmt: Database.Statement;
  private readonly boundedDocCountStmt: Database.Statement;
  private readonly boundedTermCountStmt: Database.Statement;
  private readonly scopedBoundedTermCountStmt: Database.Statement;

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
    this.countStmt = this.db.prepare('SELECT count(*) AS n FROM docs');
    this.boundedDocCountStmt = this.db.prepare(
      'SELECT count(*) AS n FROM (SELECT rowid FROM docs LIMIT ?)',
    );
    const termCount = 'SELECT count(*) AS n FROM (SELECT rowid FROM docs WHERE docs MATCH ?';
    this.boundedTermCountStmt = this.db.prepare(termCount + ' LIMIT ?)');
    this.scopedBoundedTermCountStmt = this.db.prepare(
      termCount + ' AND collection IN (SELECT value FROM json_each(?)) LIMIT ?)',
    );
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
    if (terms.length < 2 || !Number.isSafeInteger(k) || k <= 0) return [];
    const minimum = Math.ceil(terms.length * 0.6);
    // Keep every probe and the final query on one WAL read snapshot. A second
    // connection cannot grow the postings between our checks and ranking.
    return this.db
      .transaction(() => {
        if (!this.questionWithinBounds(terms, allowedCollections)) return [];
        return this.questionRows(terms, minimum, Math.min(k, 200), allowedCollections).map((row) =>
          this.toHit(row),
        );
      })
      .deferred();
  }

  /** Refuse broad fallback work; LIMIT is inside each aggregate's input. */
  private questionWithinBounds(terms: readonly string[], collections: readonly string[]): boolean {
    const docs = this.boundedDocCountStmt.get(QUESTION_MAX_DOCS + 1) as { n: number };
    if (docs.n > QUESTION_MAX_DOCS) return false;
    let total = 0;
    for (const term of terms) {
      const match = `"${term}"`;
      const count = (
        collections.length === 0
          ? this.boundedTermCountStmt.get(match, QUESTION_MAX_TERM_POSTINGS + 1)
          : this.scopedBoundedTermCountStmt.get(
              match,
              JSON.stringify(collections),
              QUESTION_MAX_TERM_POSTINGS + 1,
            )
      ) as { n: number };
      total += count.n;
      if (count.n > QUESTION_MAX_TERM_POSTINGS || total > QUESTION_MAX_TOTAL_POSTINGS) return false;
    }
    return true;
  }

  /** Count distinct literal matches inside SQLite before any candidate cutoff. */
  private questionRows(
    terms: readonly string[],
    minimum: number,
    k: number,
    allowedCollections: readonly string[],
  ): SearchRow[] {
    const scope =
      allowedCollections.length === 0 ? '' : ' AND collection IN (SELECT value FROM json_each(?))';
    const perTerm = 'SELECT rowid AS docRowId FROM docs WHERE docs MATCH ?' + scope;
    const params = terms.flatMap((term) =>
      allowedCollections.length === 0
        ? [`"${term}"`]
        : [`"${term}"`, JSON.stringify(allowedCollections)],
    );
    const match = terms.map((term) => `"${term}"`).join(' OR ');
    // SQL text depends only on bounded term count and the presence of scope;
    // user terms and collection names are always bound values. FTS5 tokenization
    // supplies accent semantics without loading document bodies into JS.
    const statement = this.db.prepare(
      'WITH term_matches AS (' +
        terms.map(() => perTerm).join(' UNION ALL ') +
        '), coverage AS (SELECT docRowId, count(*) AS covered FROM term_matches GROUP BY docRowId HAVING count(*) >= ?) ' +
        "SELECT docs.rowid AS rowId, id, collection, snippet(docs, 2, '', '', '…', 16) AS snippet, bm25(docs) AS rank " +
        'FROM docs JOIN coverage ON docs.rowid = coverage.docRowId WHERE docs MATCH ? ' +
        'ORDER BY coverage.covered DESC, rank, docs.rowid LIMIT ?',
    );
    return statement.all(...params, minimum, match, k) as SearchRow[];
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
