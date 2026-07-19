import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { computeContentHash } from '@qmd-team-intent-kb/common';

import { getExportableCollections } from '../collections/collection-registry.js';
import type { QmdSearchResult } from '../types.js';
import type { RerankCache } from './rerank-cache.js';
import type { RerankClient, RerankScore } from './rerank-client.js';

/**
 * The rerank stage — an OPT-IN, read-path-only re-ordering of the fused
 * retrieval list by a local cross-encoder (blueprint bead B1; decision
 * 044-AT-DECR).
 *
 * Pipeline position: AFTER `fuseReciprocalRank` in `QmdAdapter.query()`.
 * Top-`candidateWindow` (default 50) fused hits go in; the top-`topN`
 * (default 8) rerank-ordered hits come out.
 *
 * FAIL-OPEN INVARIANT: on ANY failure — service down, timeout, unreadable
 * export files, cache corruption, anything thrown — `apply()` returns the
 * ORIGINAL fused list untouched. The deterministic fused order is always the
 * floor the serving path can stand on; the model only ever proposes a better
 * ordering, it is never load-bearing.
 *
 * Determinism at the edges: equal rerank scores tie-break by prior fused rank
 * (then nothing else is needed — fused rank is already a total order).
 */

export interface RerankStageOptions {
  client: RerankClient;
  /** Score cache; null/omitted = uncached calls. */
  cache?: RerankCache | null;
  /** Root of the git-exporter output tree the citations resolve against. */
  exportDir: string;
  /** How many fused hits to consider (default 50). */
  candidateWindow?: number;
  /** How many rerank-ordered hits to return (default 8). */
  topN?: number;
  /** Truncate each document body sent to the model (default 1500 chars). */
  maxDocChars?: number;
}

export const DEFAULT_CANDIDATE_WINDOW = 50;
export const DEFAULT_RERANK_TOP_N = 8;
export const DEFAULT_MAX_DOC_CHARS = 1500;

/**
 * Resolve a `qmd://<collection>/<file>.md` citation to its export-tree path,
 * or null when the collection is unknown / the citation is malformed. The
 * basename guard rejects any id whose file part is not a plain child name, so
 * an index entry can never read outside its collection directory.
 */
export function resolveCitationPath(exportDir: string, citation: string): string | null {
  if (!citation.startsWith('qmd://')) return null;
  const rest = citation.slice('qmd://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const collectionName = rest.slice(0, slash);
  const fileName = rest.slice(slash + 1);
  if (fileName.length === 0 || basename(fileName) !== fileName) return null;
  const def = getExportableCollections().find((c) => c.name === collectionName);
  if (def === undefined) return null;
  return join(exportDir, def.sourceSubdir, fileName);
}

interface Candidate {
  hit: QmdSearchResult;
  /** Position in the fused list (0-based) — the deterministic tie-breaker. */
  fusedRank: number;
  text: string;
  contentHash: string;
  score?: RerankScore;
}

export class RerankStage {
  private readonly client: RerankClient;
  private readonly cache: RerankCache | null;
  private readonly exportDir: string;
  private readonly candidateWindow: number;
  private readonly topN: number;
  private readonly maxDocChars: number;

  constructor(options: RerankStageOptions) {
    this.client = options.client;
    this.cache = options.cache ?? null;
    this.exportDir = options.exportDir;
    this.candidateWindow = options.candidateWindow ?? DEFAULT_CANDIDATE_WINDOW;
    this.topN = options.topN ?? DEFAULT_RERANK_TOP_N;
    this.maxDocChars = options.maxDocChars ?? DEFAULT_MAX_DOC_CHARS;
  }

  /**
   * Re-order `fused` by cross-encoder relevance to `query`; return the top-N.
   * Returns the ORIGINAL `fused` list unchanged on any failure (fail-open).
   */
  async apply(query: string, fused: readonly QmdSearchResult[]): Promise<QmdSearchResult[]> {
    try {
      if (fused.length <= 1) return [...fused];
      const candidates = fused.slice(0, this.candidateWindow).map((hit, i): Candidate => {
        const text = this.resolveDocText(hit);
        return { hit, fusedRank: i, text, contentHash: computeContentHash(text) };
      });

      // Cache pass: content-addressed lookups keyed on (query, doc content).
      const misses: Candidate[] = [];
      for (const candidate of candidates) {
        const cached = this.cache?.get(query, candidate.contentHash) ?? null;
        if (cached !== null) candidate.score = cached;
        else misses.push(candidate);
      }

      // Model pass for the misses only.
      if (misses.length > 0) {
        const scored = await this.client.rerank(
          query,
          misses.map((c) => c.text),
        );
        if (scored === null || scored.length !== misses.length) {
          return [...fused]; // fail open to the deterministic fused order
        }
        for (const { index, score } of scored) {
          const candidate = misses[index];
          if (candidate === undefined) return [...fused];
          candidate.score = score;
          this.cache?.set(query, candidate.contentHash, score);
        }
      }

      if (candidates.some((c) => c.score === undefined)) return [...fused];

      // Deterministic ordering: score desc, then prior fused rank asc.
      const reordered = [...candidates].sort(
        (a, b) => (b.score as number) - (a.score as number) || a.fusedRank - b.fusedRank,
      );

      // The returned hits carry the model's relevance score (read-path display/
      // ordering only — a RerankScore can never become a govern score; see the
      // seam firewall in packages/policy-engine/src/deterministic-score.ts).
      return reordered.slice(0, this.topN).map((c) => ({ ...c.hit, score: c.score as number }));
    } catch {
      return [...fused];
    }
  }

  /** Health probe for the underlying rerank service. */
  async healthy(): Promise<boolean> {
    return this.client.healthy();
  }

  /**
   * Resolve the document text a hit's citation points at, truncated to
   * `maxDocChars`. Falls back to the hit's snippet when the export file
   * cannot be resolved/read — a weaker signal beats dropping the doc.
   */
  private resolveDocText(hit: QmdSearchResult): string {
    const path = resolveCitationPath(this.exportDir, hit.file);
    if (path !== null) {
      try {
        return readFileSync(path, 'utf8').slice(0, this.maxDocChars);
      } catch {
        // fall through to snippet
      }
    }
    return hit.snippet.slice(0, this.maxDocChars);
  }
}
