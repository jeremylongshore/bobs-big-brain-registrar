import { join } from 'node:path';

import { resolveTeamKbPath } from '@qmd-team-intent-kb/common';

/** Base directory for qmd indexes, isolated from personal qmd usage */
export const QMD_INDEX_DIR = 'qmd-index';

/** Get the dedicated qmd index base path */
export function getQmdIndexBasePath(): string {
  return resolveTeamKbPath(QMD_INDEX_DIR);
}

/** Get the index path for a specific tenant */
export function getQmdTenantIndexPath(tenantId: string): string {
  return resolveTeamKbPath(`${QMD_INDEX_DIR}/${tenantId}`);
}

/** Get the index path for a specific tenant + collection */
export function getQmdCollectionIndexPath(tenantId: string, collection: string): string {
  return resolveTeamKbPath(`${QMD_INDEX_DIR}/${tenantId}/${collection}`);
}

/**
 * Environment overrides that isolate a tenant's qmd registry + index.
 *
 * qmd 2.x reads its collection registry from `$XDG_CONFIG_HOME/qmd/index.yml`
 * and its BM25 index from `$XDG_CACHE_HOME/qmd/index.sqlite`. Pointing both at
 * tenant-scoped subdirs of the tenant index path gives full per-tenant
 * isolation without the (nonexistent) `--data-dir` flag, and keeps the team
 * KB's qmd state out of the operator's personal `~/.config/qmd` / `~/.cache/qmd`.
 */
export function getQmdTenantEnv(tenantId: string): Record<string, string> {
  const base = getQmdTenantIndexPath(tenantId);
  return {
    XDG_CONFIG_HOME: join(base, 'config'),
    XDG_CACHE_HOME: join(base, 'cache'),
  };
}

/** Adapter configuration */
export interface QmdAdapterConfig {
  tenantId: string;
  /**
   * Absolute path to the git-exporter output directory. The adapter registers
   * each collection's source at `<exportDir>/<sourceSubdir>` so `qmd update`
   * indexes the markdown git-exporter writes. Must resolve to the same dir the
   * exporter writes to (the edge-daemon resolves `exportOutputDir` and passes
   * it here).
   */
  exportDir: string;
  qmdBinary?: string;
  timeout?: number;
  /**
   * Override for the native FTS5 fusion index file (tests use `:memory:`).
   * Defaults to `<qmd-index>/<tenantId>/native-fts5.sqlite` — derived data
   * next to the qmd index it fuses with.
   */
  nativeIndexPath?: string;
  /** Kill switch: serve qmd-only results with no native FTS5 fusion. */
  disableNativeFusion?: boolean;
  /**
   * Optional index-freshness probe (D2). Supplied by callers that own the
   * governed store (API / edge-daemon / CLI); when set, `adapter.health()`
   * reports `stalenessSeconds` from it. Absent → staleness is `null`
   * (unmeasured). See `StalenessProbe` in types.ts for the contract.
   */
  stalenessProbe?: () => number | null;
  /**
   * OPT-IN cross-encoder rerank stage (blueprint bead B1, 044-AT-DECR).
   * Explicit options only — no env magic. When omitted or `enabled: false`,
   * the query path is byte-identical to the pre-rerank deterministic fusion.
   * When enabled, the stage FAILS OPEN: any reranker failure serves the fused
   * order unchanged.
   */
  rerank?: {
    enabled: boolean;
    /** Reranker service base URL, e.g. `http://127.0.0.1:8097` (loopback only). */
    url: string;
    /** Hard per-request timeout (default 3000 ms). */
    timeoutMs?: number;
    /** Fused hits fed to the reranker (default 50). */
    candidateWindow?: number;
    /** Rerank-ordered hits returned (default 8). */
    topN?: number;
    /**
     * Truncate each document body sent to the model (default 1500 chars).
     * CPU cross-encoder latency scales ~linearly with total characters, so
     * this knob × candidateWindow IS the latency budget.
     */
    maxDocChars?: number;
    /**
     * Override for the sidecar score cache (tests use `:memory:`). Defaults to
     * `<qmd-index>/<tenantId>/rerank-cache.sqlite` — derived, deletable data.
     */
    cachePath?: string;
  };
  /**
   * OPT-IN dense retrieval arm (blueprint bead B4; 038/044-AT-DECR:
   * sqlite-vec + EmbeddingGemma-300M only). Explicit options only — no env
   * magic. When omitted or `enabled: false`, the query path is byte-identical
   * to the lexical-only deterministic fusion. When enabled, the arm FAILS
   * OPEN: embedder down / index unbuilt / any failure serves the lexical
   * fusion with no dense list.
   */
  dense?: {
    enabled: boolean;
    /** Embedding service base URL, e.g. `http://127.0.0.1:8098` (loopback only). */
    url: string;
    /** Hard timeout for the query-embed call (default 5000 ms). */
    timeoutMs?: number;
    /**
     * Override for the sqlite-vec sidecar index (tests use `:memory:`).
     * Defaults to `<qmd-index>/<tenantId>/dense-vec.sqlite` — derived,
     * rebuildable, deletable data next to the other derived indexes.
     */
    indexPath?: string;
    /** Dense KNN hits fed to the fusion, pre scope-filter (default 50). */
    searchK?: number;
    /** Truncate each doc to this many chars before embedding (default 1200). */
    maxDocChars?: number;
    /** Timeout for a document-batch embed call during indexing (default 120000 ms). */
    indexTimeoutMs?: number;
    /** Docs per embed request during indexing (default 16). */
    batchSize?: number;
  };
}

/** Default configuration values */
export const DEFAULT_QMD_BINARY = 'qmd';
export const DEFAULT_TIMEOUT = 30_000;
