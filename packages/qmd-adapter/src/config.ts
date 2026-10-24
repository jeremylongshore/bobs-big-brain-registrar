import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { getTeamKbBasePath, resolveTeamKbPath } from '@qmd-team-intent-kb/common';
import type { OwnedQmdRuntime } from './executor/resolve-command.js';

/** Base directory for qmd indexes, isolated from personal qmd usage */
export const QMD_INDEX_DIR = 'qmd-index';

/** Get the dedicated qmd index base path */
export function getQmdIndexBasePath(): string {
  return resolveTeamKbPath(QMD_INDEX_DIR);
}

/** Get the index path for a specific tenant */
export function getQmdTenantIndexPath(tenantId: string, basePath?: string): string {
  const root = resolve(basePath ?? getTeamKbBasePath(), QMD_INDEX_DIR);
  const parts = tenantId.split(sep);
  if (
    !tenantId ||
    tenantId.includes('\0') ||
    isAbsolute(tenantId) ||
    parts.some((p) => p === '.' || p === '..' || p === '')
  )
    throw new Error('Tenant index identity must be a nonempty relative path without traversal');
  const path = resolve(root, tenantId);
  const within = relative(root, path);
  if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`))
    throw new Error('Tenant index path escapes the configured TeamKB base');
  return path;
}

/** Get the index path for a specific tenant + collection */
export function getQmdCollectionIndexPath(tenantId: string, collection: string): string {
  return resolveTeamKbPath(`${QMD_INDEX_DIR}/${tenantId}/${collection}`);
}

/**
 * Environment overrides that isolate a tenant's qmd registry + index.
 *
 * Preserve qmd's existing tenant XDG layout while binding QMD_CONFIG_DIR and
 * INDEX_PATH explicitly. Pair this environment with withQmdTenantSelector:
 * the selector disables ancestor .qmd discovery, which otherwise overrides
 * the default index path. This helper alone does not disable that discovery.
 */
export function getQmdTenantEnv(tenantId: string, basePath?: string): Record<string, string> {
  const base = getQmdTenantIndexPath(tenantId, basePath);
  return {
    XDG_CONFIG_HOME: join(base, 'config'),
    XDG_CACHE_HOME: join(base, 'cache'),
    QMD_CONFIG_DIR: join(base, 'config', 'qmd'),
    INDEX_PATH: join(base, 'cache', 'qmd', 'index.sqlite'),
  };
}

/** Explicit selector disables qmd's ancestor .qmd discovery; query literals stay after --. */
export function withQmdTenantSelector(args: readonly string[]): string[] {
  const literal = args.indexOf('--');
  const at = literal < 0 ? args.length : literal;
  return [...args.slice(0, at), '--index', 'index', ...args.slice(at)];
}

/** Loopback endpoint served by the pinned EmbeddingGemma user service. */
export const DEFAULT_DENSE_URL = 'http://127.0.0.1:8098';

/** Configuration for the sqlite-vec + EmbeddingGemma retrieval arm. */
export interface DenseConfig {
  enabled: boolean;
  /** Embedding service base URL (loopback-only in the supported deployment). */
  url: string;
  /** Hard timeout for the query-embed call (default 5000 ms). */
  timeoutMs?: number;
  /** Override for the derived sqlite-vec sidecar index. */
  indexPath?: string;
  /** Dense KNN hits fed to the fusion, pre scope-filter (default 50). */
  searchK?: number;
  /** Truncate each doc to this many chars before embedding (default 2000). */
  maxDocChars?: number;
  /** Timeout for a document-batch embed call during indexing (default 120000 ms). */
  indexTimeoutMs?: number;
  /** Docs per embed request during indexing (default 1; larger batches require measured capacity). */
  batchSize?: number;
  /**
   * Observer invoked when a QUERY's dense arm degrades — embed failure, embed
   * timeout, unavailable construction, unbuilt/empty index, incompatible query
   * dimensions, or a missing query vector — immediately before the arm fails open
   * and returns zero candidates.
   *
   * Production leaves this unset, and {@link getDefaultDenseConfig} never sets
   * it: fail-open is correct in serving, because a user with a slow embedder
   * should still get lexical results rather than an error.
   *
   * MEASUREMENT is the opposite case, and that asymmetry is why this exists.
   * Silent fail-open makes a contended eval indistinguishable from a real
   * regression: measured 2026-08-02, the same frozen snapshot and the same
   * prebuilt index scored semantic Recall@10 0.9643 on an idle box and 0.7679
   * under load 9.5 on 8 cores — with ZERO errors logged, because every
   * timed-out query silently contributed zero dense candidates. A floor
   * committed against the first number would then go red on contention rather
   * than on a regression, and a gate that cries wolf gets ignored.
   *
   * So the eval harness sets this and refuses to render a verdict when it
   * fires. Never throw from the callback — it runs inside the fail-open catch.
   */
  onQueryDegraded?: (reason: unknown) => void;
}

/**
 * Resolve the production dense default.
 *
 * The library remains explicit-by-config so lexical-only fixtures and callers
 * can opt out deliberately. Production entrypoints call this helper, which
 * makes dense retrieval default-on while retaining one documented emergency
 * kill switch for a broken local embedder.
 */
export function getDefaultDenseConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DenseConfig {
  const rawEnabled = env['TEAMKB_DENSE_ENABLED']?.trim().toLowerCase();
  const enabled = rawEnabled === undefined || !['0', 'false', 'off', 'no'].includes(rawEnabled);
  return { enabled, url: DEFAULT_DENSE_URL };
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
  /** Opt-in artifact declaration; a declared missing/broken artifact never uses legacy discovery. */
  qmdRuntime?: OwnedQmdRuntime;
  /** Explicit TeamKB base for tenant indexes; defaults to normal ambient base resolution. */
  basePath?: string;
  /** Limit for interactive qmd commands (default {@link DEFAULT_TIMEOUT}). */
  timeout?: number;
  /**
   * Limit for index-maintenance qmd commands — update / embed / cleanup /
   * collection add (default: {@link QMD_TIMEOUT_ENV}, else
   * {@link DEFAULT_MAINTENANCE_TIMEOUT}).
   */
  maintenanceTimeout?: number;
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
   * Dense retrieval arm (blueprint bead B4; 038/044-AT-DECR: sqlite-vec +
   * EmbeddingGemma-300M only). The production entrypoints pass
   * {@link getDefaultDenseConfig}; direct library callers remain lexical-only
   * when this field is omitted. When enabled, the arm FAILS OPEN: embedder
   * down / index unbuilt / any failure serves the lexical fusion with no dense
   * list.
   */
  dense?: DenseConfig;
}

/** Default configuration values */
export const DEFAULT_QMD_BINARY = 'qmd';
/**
 * Per-call limit for interactive qmd commands (search, `collection list`,
 * `status`, `--version`). Unchanged by the maintenance timeout below: a query
 * that cannot answer in 30 s should fail (and fall open to the other arms)
 * rather than hold a request.
 */
export const DEFAULT_TIMEOUT = 30_000;

/**
 * Per-call limit for index-MAINTENANCE qmd commands (`update`, `embed`,
 * `cleanup`, `collection add`) — the reindex path.
 *
 * Why 10 minutes (bead compile-then-govern-39z.20): measured 2026-10-11 on the
 * dev box (8 cores, load ~3.5), a cold `qmd update` of the 18,046-document
 * kb-export took 130 s and a warm (no-change) one took 4 s; on 2026-10-08 at
 * load ~12 a routine update ran past a minute. The old 30 s query budget
 * killed those updates mid-write. 600 s gives a cold rebuild ~4.5x headroom
 * for contention and matches the eval anchor's measured `collection add`
 * budget (ANCHOR_QMD_TIMEOUT_MS), while still bounding a genuinely hung qmd.
 */
export const DEFAULT_MAINTENANCE_TIMEOUT = 600_000;

/** Env var overriding {@link DEFAULT_MAINTENANCE_TIMEOUT} (milliseconds, positive integer). */
export const QMD_TIMEOUT_ENV = 'TEAMKB_QMD_TIMEOUT_MS';

/**
 * Parse a timeout in milliseconds. Returns `null` for anything that is not a
 * positive integer, so callers decide whether bad input is a usage error (the
 * CLI) or falls back to the default (library construction).
 */
export function parseTimeoutMs(raw: string | undefined): number | null {
  const v = raw?.trim();
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve the maintenance timeout from {@link QMD_TIMEOUT_ENV}. An unset or
 * invalid value yields the default — library construction must never throw on
 * a typo'd env var (the CLI validates it strictly and exits 2 instead).
 */
export function resolveMaintenanceTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return parseTimeoutMs(env[QMD_TIMEOUT_ENV]) ?? DEFAULT_MAINTENANCE_TIMEOUT;
}
