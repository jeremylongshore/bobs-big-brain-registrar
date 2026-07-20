import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import { rerankScore, type RerankScore } from './rerank-client.js';

/**
 * Content-addressed sidecar cache for rerank scores (blueprint bead B1).
 *
 * A cross-encoder pass over 50 documents costs real inference time; the same
 * (query, document) pair always yields the same score for the same model
 * weights, so the score is content-addressable:
 *
 *   key           = sha256(query + '\x00' + docContentHash)
 *   model_id      = the GGUF file the score came from
 *   model_version = the pinned SHA-256 of those weights
 *
 * The '\x00' separator prevents boundary ambiguity between query and hash.
 * Keying on the weights hash means a model bump invalidates every prior score
 * with zero migration logic.
 *
 * DERIVED DATA, NEVER AUTHORITATIVE: this sidecar lives next to the other
 * derived indexes (`<qmd-index>/<tenant>/rerank-cache.sqlite`), is rebuilt
 * lazily by cache misses, and can be deleted at any time. Every operation is
 * wrapped so a cache failure (corrupt file, read-only fs, missing native dep)
 * degrades to uncached rerank calls — never to a serving failure.
 */
export class RerankCache {
  private readonly db: Database.Database;
  private readonly getStmt: Database.Statement;
  private readonly setStmt: Database.Statement;
  private readonly modelId: string;
  private readonly modelVersion: string;
  private broken = false;

  constructor(opts: { path: string; modelId: string; modelVersion: string }) {
    this.modelId = opts.modelId;
    this.modelVersion = opts.modelVersion;
    if (opts.path !== ':memory:') {
      mkdirSync(dirname(opts.path), { recursive: true });
    }
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS rerank_scores (' +
        'key TEXT NOT NULL, model_id TEXT NOT NULL, model_version TEXT NOT NULL, ' +
        'score REAL NOT NULL, created_ms INTEGER NOT NULL, ' +
        'PRIMARY KEY (key, model_id, model_version))',
    );
    this.getStmt = this.db.prepare(
      'SELECT score FROM rerank_scores WHERE key = ? AND model_id = ? AND model_version = ?',
    );
    this.setStmt = this.db.prepare(
      'INSERT INTO rerank_scores (key, model_id, model_version, score, created_ms) ' +
        'VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(key, model_id, model_version) DO UPDATE SET ' +
        'score = excluded.score, created_ms = excluded.created_ms',
    );
  }

  /** Content-addressed cache key for a (query, document-content-hash) pair. */
  static cacheKey(query: string, docContentHash: string): string {
    return computeContentHash(query + '\x00' + docContentHash);
  }

  /** Cached score, or null on miss (or on any cache failure — degrades silently). */
  get(query: string, docContentHash: string): RerankScore | null {
    if (this.broken) return null;
    try {
      const row = this.getStmt.get(
        RerankCache.cacheKey(query, docContentHash),
        this.modelId,
        this.modelVersion,
      ) as { score: number } | undefined;
      return row === undefined ? null : rerankScore(row.score);
    } catch {
      this.broken = true;
      return null;
    }
  }

  /** Store a score. Failures are swallowed (the cache is never load-bearing). */
  set(query: string, docContentHash: string, score: RerankScore): void {
    if (this.broken) return;
    try {
      this.setStmt.run(
        RerankCache.cacheKey(query, docContentHash),
        this.modelId,
        this.modelVersion,
        score,
        Date.now(),
      );
    } catch {
      this.broken = true;
    }
  }

  count(): number {
    try {
      return (this.db.prepare('SELECT count(*) AS n FROM rerank_scores').get() as { n: number }).n;
    } catch {
      return 0;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed / broken — nothing to do
    }
  }
}
