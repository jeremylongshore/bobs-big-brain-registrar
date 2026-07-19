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
     * Override for the sidecar score cache (tests use `:memory:`). Defaults to
     * `<qmd-index>/<tenantId>/rerank-cache.sqlite` — derived, deletable data.
     */
    cachePath?: string;
  };
}

/** Default configuration values */
export const DEFAULT_QMD_BINARY = 'qmd';
export const DEFAULT_TIMEOUT = 30_000;
