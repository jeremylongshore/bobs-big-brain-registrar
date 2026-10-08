import type Database from 'better-sqlite3';

/**
 * Schema guard for the index scrub (umbrella bead compile-then-govern-39z.19).
 *
 * The scrub deletes rows from three SQLite files it does not all own. The qmd
 * BM25 cache (`cache/qmd/index.sqlite`) is written by the pinned `@tobilu/qmd`
 * binary, so its layout can change under us on a version bump. Deleting rows
 * from a table whose meaning we guessed is how a scrub corrupts an index or,
 * worse, reports "clean" while the text sits in a column it never looked at.
 * So the scrub FAILS CLOSED: before it reads or writes a file it compares the
 * tables and columns it depends on with the layout recorded here, and refuses
 * the file on any difference.
 *
 * The qmd layout is tied to {@link PINNED_QMD_VERSION}. A unit test asserts the
 * root `package.json` pins exactly that version, so bumping qmd without
 * re-checking this layout fails CI rather than drifting silently.
 */

/** The `@tobilu/qmd` version whose index layout {@link QMD_INDEX_SCHEMA} records. */
export const PINNED_QMD_VERSION = '2.5.3';

/** One table's expected columns (exact set, order-insensitive). */
export interface TableShape {
  table: string;
  columns: readonly string[];
  /** Absent tables are allowed (created lazily by the owner); present ones must match. */
  optional?: boolean;
  /** FTS5 virtual table: its CREATE statement must use fts5 and keep its own content. */
  fts5?: boolean;
}

/** qmd 2.5.3 `index.sqlite`: the tables the scrub reads or deletes from. */
export const QMD_INDEX_SCHEMA: readonly TableShape[] = [
  {
    table: 'documents',
    columns: ['id', 'collection', 'path', 'title', 'hash', 'created_at', 'modified_at', 'active'],
  },
  { table: 'content', columns: ['hash', 'doc', 'created_at'] },
  { table: 'documents_fts', columns: ['filepath', 'title', 'body'], fts5: true },
  {
    table: 'content_vectors',
    columns: ['hash', 'seq', 'pos', 'model', 'embedded_at', 'embed_fingerprint', 'total_chunks'],
    optional: true,
  },
  { table: 'llm_cache', columns: ['hash', 'result', 'created_at'], optional: true },
];

/** `native-fts5.sqlite` (owned by this package: native/fts5-backend.ts + native-index-manager.ts). */
export const NATIVE_INDEX_SCHEMA: readonly TableShape[] = [
  { table: 'docs', columns: ['id', 'collection', 'content'], fts5: true },
  { table: 'files', columns: ['path', 'doc_id', 'mtime_ms'], optional: true },
];

/** `dense-vec.sqlite` (owned by this package: dense/dense-index.ts). */
export const DENSE_INDEX_SCHEMA: readonly TableShape[] = [
  {
    table: 'dense_docs',
    columns: ['rowid', 'doc_id', 'collection', 'content_hash', 'snippet', 'embedded_ms'],
  },
  { table: 'dense_meta', columns: ['key', 'value'] },
];

function columnsOf(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}

/** Problems with one table, or [] when it matches. */
function checkTable(db: Database.Database, shape: TableShape): string[] {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(shape.table) as { sql: string | null } | undefined;
  if (row === undefined) {
    return shape.optional === true ? [] : [`table ${shape.table} is missing`];
  }
  const problems: string[] = [];
  if (shape.fts5 === true) {
    const sql = (row.sql ?? '').toLowerCase();
    if (!/using\s+fts5\s*\(/.test(sql)) problems.push(`${shape.table} is not an FTS5 table`);
    // External-content and contentless tables keep no text of their own, so a
    // 'rebuild' would read it from somewhere this guard has not checked.
    if (/\bcontent\s*=/.test(sql)) {
      problems.push(`${shape.table} is an external-content or contentless FTS5 table`);
    }
  }
  const actual = columnsOf(db, shape.table);
  if (!sameSet(actual, shape.columns)) {
    problems.push(
      `${shape.table} columns are [${[...actual].sort().join(', ')}], expected [${[...shape.columns]
        .sort()
        .join(', ')}]`,
    );
  }
  return problems;
}

/**
 * Compare a database with an expected layout. Returns one message per
 * difference (table and column NAMES only — never row data); [] means match.
 */
export function checkSchema(db: Database.Database, expected: readonly TableShape[]): string[] {
  return expected.flatMap((shape) => checkTable(db, shape));
}
