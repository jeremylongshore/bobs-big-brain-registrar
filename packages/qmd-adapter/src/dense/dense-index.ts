import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { denseScore, type DenseScore } from './embed-client.js';

/**
 * sqlite-vec sidecar index for the dense retrieval arm (blueprint bead B4;
 * decisions 038-AT-DECR + 044-AT-DECR: sqlite-vec + EmbeddingGemma-300M only,
 * skipping qmd's 2.2 GB hybrid).
 *
 * One SQLite file at `<qmd-index>/<tenant>/dense-vec.sqlite` holding:
 *
 *   dense_meta  — model_id / model_version (the PINNED weights hash from
 *                 weights-manifest.ts) + vector dims. Opening against a
 *                 different model or dims WIPES the index: embeddings from
 *                 different weights are not comparable, so a model bump
 *                 invalidates every prior vector with zero migration logic
 *                 (the same trick as the rerank score cache).
 *   dense_docs  — one row per embedded doc, keyed by the `qmd://` citation
 *                 (the cross-backend join key) + the content hash of the
 *                 exact text that was embedded, so re-embedding is
 *                 incremental: unchanged docs are never re-sent to the model.
 *   dense_vec   — the vec0 virtual table (one float[dims] row per doc,
 *                 rowid-linked to dense_docs) carrying `collection` as a vec0
 *                 PARTITION KEY. Created lazily on the first upsert, when the
 *                 true dimension is known from the model — never hardcoded.
 *                 The partition key lets scope filtering happen INSIDE the KNN
 *                 (`WHERE collection IN (...)`) rather than after it: under the
 *                 default `curated` scope the archive collection (embedded but
 *                 out of scope) would otherwise consume the k nearest slots and
 *                 starve the curated recall this arm exists to buy — a real
 *                 risk in this corpus, where archive is ~38% of all docs.
 *
 * DERIVED DATA, NEVER AUTHORITATIVE: rebuildable from kb-export + the
 * embedding service at any time, deletable at any time, outside backup scope
 * — exactly like the native FTS5 index and the rerank cache beside it.
 */

/** One embedded document's bookkeeping row. */
export interface DenseDocEntry {
  docId: string;
  contentHash: string;
}

/** One ranked hit from the dense KNN search. */
export interface DenseSearchHit {
  /** The `qmd://` citation — same id space as the lexical backends. */
  id: string;
  /**
   * Cosine similarity to the query embedding (vectors are L2-normalized, so
   * this is derived deterministically from the vec0 L2 distance). Branded:
   * model-derived, retrieval-side only.
   */
  score: DenseScore;
  snippet: string;
  collection: string;
}

/** Stored characters of leading doc text used as the fallback snippet. */
export const DENSE_SNIPPET_CHARS = 160;

export class DenseVecIndex {
  private readonly db: Database.Database;
  private dims: number | null;

  constructor(opts: { path: string; modelId: string; modelVersion: string }) {
    if (opts.path !== ':memory:') {
      mkdirSync(dirname(opts.path), { recursive: true });
    }
    this.db = new Database(opts.path);
    // Throws when the sqlite-vec native extension cannot load — the caller
    // (adapter) treats a constructor throw as "no dense arm" and degrades.
    sqliteVec.load(this.db);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS dense_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); ' +
        'CREATE TABLE IF NOT EXISTS dense_docs (' +
        'rowid INTEGER PRIMARY KEY, doc_id TEXT NOT NULL UNIQUE, collection TEXT NOT NULL, ' +
        'content_hash TEXT NOT NULL, snippet TEXT NOT NULL, embedded_ms INTEGER NOT NULL)',
    );

    // Model pin gate: vectors from different weights are not comparable.
    const storedModel = this.getMeta('model_id');
    const storedVersion = this.getMeta('model_version');
    if (
      (storedModel !== null && storedModel !== opts.modelId) ||
      (storedVersion !== null && storedVersion !== opts.modelVersion)
    ) {
      this.wipe();
    }
    this.setMeta('model_id', opts.modelId);
    this.setMeta('model_version', opts.modelVersion);

    const storedDims = this.getMeta('dims');
    this.dims = storedDims === null ? null : Number(storedDims);
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM dense_meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO dense_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /** Drop every embedded doc + vector (meta survives; dims reset). */
  private wipe(): void {
    this.db.exec('DELETE FROM dense_docs; DROP TABLE IF EXISTS dense_vec');
    this.db.prepare('DELETE FROM dense_meta WHERE key = ?').run('dims');
    this.dims = null;
  }

  /**
   * Ensure the vec0 table exists for `dims`-dimensional vectors. A dimension
   * change (impossible without a model change, but belt-and-braces) wipes and
   * recreates — mixed-dimension KNN is meaningless.
   */
  private ensureVecTable(dims: number): void {
    if (this.dims === dims) return;
    if (this.dims !== null) this.wipe();
    this.db.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS dense_vec USING ' +
        `vec0(collection text partition key, embedding float[${dims}])`,
    );
    this.setMeta('dims', String(dims));
    this.dims = dims;
  }

  /**
   * Upsert one embedded document. `contentHash` MUST be the hash of the exact
   * (truncated) text the embedding was computed from — it is the incremental
   * re-embed key.
   */
  upsert(doc: {
    docId: string;
    collection: string;
    contentHash: string;
    snippet: string;
    embedding: Float32Array;
  }): void {
    this.ensureVecTable(doc.embedding.length);
    const tx = this.db.transaction(() => {
      const prior = this.db
        .prepare('SELECT rowid FROM dense_docs WHERE doc_id = ?')
        .get(doc.docId) as { rowid: number } | undefined;
      if (prior !== undefined) {
        // vec0 rejects non-INTEGER rowid bindings; BigInt binds as INTEGER.
        this.db.prepare('DELETE FROM dense_vec WHERE rowid = ?').run(BigInt(prior.rowid));
        this.db.prepare('DELETE FROM dense_docs WHERE rowid = ?').run(prior.rowid);
      }
      const inserted = this.db
        .prepare(
          'INSERT INTO dense_docs (doc_id, collection, content_hash, snippet, embedded_ms) ' +
            'VALUES (?, ?, ?, ?, ?)',
        )
        .run(doc.docId, doc.collection, doc.contentHash, doc.snippet, Date.now());
      this.db
        .prepare('INSERT INTO dense_vec (rowid, collection, embedding) VALUES (?, ?, ?)')
        .run(
          BigInt(inserted.lastInsertRowid),
          doc.collection,
          Buffer.from(doc.embedding.buffer, doc.embedding.byteOffset, doc.embedding.byteLength),
        );
    });
    tx();
  }

  /** Remove documents by citation id (no-op for ids that are not indexed). */
  remove(docIds: readonly string[]): void {
    const tx = this.db.transaction(() => {
      for (const docId of docIds) {
        const prior = this.db
          .prepare('SELECT rowid FROM dense_docs WHERE doc_id = ?')
          .get(docId) as { rowid: number } | undefined;
        if (prior === undefined) continue;
        this.db.prepare('DELETE FROM dense_vec WHERE rowid = ?').run(BigInt(prior.rowid));
        this.db.prepare('DELETE FROM dense_docs WHERE rowid = ?').run(prior.rowid);
      }
    });
    tx();
  }

  /** Every indexed doc's (docId, contentHash) — the indexer's diff input. */
  entries(): DenseDocEntry[] {
    return (
      this.db.prepare('SELECT doc_id, content_hash FROM dense_docs').all() as Array<{
        doc_id: string;
        content_hash: string;
      }>
    ).map((r) => ({ docId: r.doc_id, contentHash: r.content_hash }));
  }

  /**
   * KNN search: top-`k` nearest docs to `queryEmbedding` (vec0 L2 distance;
   * inputs are L2-normalized so the ordering equals cosine ordering, and the
   * reported score is the exact cosine similarity `1 − d²/2`).
   *
   * `allowedCollections` (empty = no filter, i.e. scope `all`) is pushed INTO
   * the KNN via the vec0 `collection` partition key, so the k returned rows are
   * the k nearest *within scope* — out-of-scope collections (e.g. archive under
   * a curated search) never occupy a slot. This is the correctness fix that a
   * post-hoc `.filter()` cannot give: filtering after a top-k over ALL
   * collections would silently shrink an in-scope result set below k.
   */
  search(
    queryEmbedding: Float32Array,
    k: number,
    allowedCollections: readonly string[] = [],
  ): DenseSearchHit[] {
    if (this.dims === null || k <= 0) return [];
    if (queryEmbedding.length !== this.dims) return []; // wrong-model query vector
    const scopeClause =
      allowedCollections.length === 0
        ? ''
        : `AND v.collection IN (${allowedCollections.map(() => '?').join(', ')}) `;
    const rows = this.db
      .prepare(
        'SELECT d.doc_id AS id, v.collection AS collection, d.snippet AS snippet, v.distance AS distance ' +
          'FROM dense_vec v JOIN dense_docs d ON d.rowid = v.rowid ' +
          `WHERE v.embedding MATCH ? AND k = ? ${scopeClause}ORDER BY v.distance`,
      )
      .all(
        Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength),
        k,
        ...allowedCollections,
      ) as Array<{ id: string; collection: string; snippet: string; distance: number }>;
    return rows.map((r) => ({
      id: r.id,
      collection: r.collection,
      snippet: r.snippet,
      score: denseScore(1 - (r.distance * r.distance) / 2),
    }));
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM dense_docs').get() as { n: number }).n;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed — nothing to do
    }
  }
}
