/** Error from a qmd operation */
export interface QmdError {
  code: 'not_available' | 'not_initialized' | 'command_failed' | 'parse_error' | 'timeout';
  message: string;
  command?: string;
  stderr?: string;
}

/** Result of executing a qmd CLI command */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Health status of the qmd installation and index */
export interface QmdHealthStatus {
  available: boolean;
  version: string | null;
  initialized: boolean;
  collections: string[];
  /**
   * Index freshness (D2): seconds since the OLDEST promotion in the governed
   * store that is NOT yet reflected in the search index.
   *
   * Contract (mirrors `IndexStateRepository.stalenessSeconds` in the store):
   *   - `null` — unmeasured: no staleness probe was wired into this adapter,
   *     or measurement has not begun (no export→reindex chain has ever
   *     recorded completion for the tenant). Fail-open by design so a fresh
   *     deploy does not false-alarm.
   *   - `0`    — measured and fresh: the index has absorbed every promotion.
   *   - `> 0`  — measured and stale: promote→search latency in seconds.
   */
  stalenessSeconds: number | null;
}

/**
 * Injectable freshness probe (D2). The adapter layer is deliberately store-free,
 * so callers that own the governed store (API, edge-daemon, CLI) supply this —
 * typically `() => new IndexStateRepository(db).stalenessSeconds(tenantId)`.
 * Must follow the null/0/positive contract on
 * {@link QmdHealthStatus.stalenessSeconds}.
 */
export type StalenessProbe = () => number | null;

/** A single search result from qmd */
export interface QmdSearchResult {
  file: string;
  score: number;
  snippet: string;
  collection: string;
}
