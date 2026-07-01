import type { Result } from '@qmd-team-intent-kb/common';
import type { SearchScope } from '@qmd-team-intent-kb/schema';
import type { QmdError } from '../types.js';
import type { QmdAdapter } from '../adapter.js';
import { reindex } from '../reindex/reindex.js';

/**
 * A known-positive control: a query the governed corpus is expected to answer.
 *
 * The corpus is the team's own knowledge base, so these are phrased against
 * durable, load-bearing concepts that must always be present for the brain to
 * be considered searchable at all. They are deliberately generic (not tied to a
 * single memory that could be archived) so a green canary means "search works",
 * not "this exact row exists".
 */
export interface CanaryControl {
  /** The control query. */
  query: string;
  /** Minimum hits for this control to pass. Default 1 — a known-positive must never return zero. */
  minHits?: number;
  /** Scope to search. Default `'all'` so the canary is not narrowed by curated-only filtering. */
  scope?: SearchScope;
}

/**
 * The default known-positive controls for the governed brain.
 *
 * These map to first-class, permanent themes of this KB (audit receipts,
 * governance, backup/DR, retrieval, the compile→govern architecture). If ANY of
 * them returns zero hits, the index is empty/stale/misrouted — the exact
 * "SEARCH DEGRADED, 0 hits for known-positive controls" failure this canary
 * exists to catch loudly instead of silently.
 */
export const DEFAULT_CANARY_CONTROLS: readonly CanaryControl[] = [
  { query: 'audit chain receipts' },
  { query: 'governed brain backup' },
  { query: 'compile then govern architecture' },
];

/** Per-control result. */
export interface CanaryControlResult {
  query: string;
  minHits: number;
  hits: number;
  /** `hits >= minHits`. */
  passed: boolean;
  /** Set only when the control could not be evaluated (search command failed). */
  error?: QmdError;
}

/** Aggregate canary outcome. */
export interface SearchCanaryReport {
  /** True only when EVERY control passed. */
  healthy: boolean;
  /** The tenant the canary ran against, for diagnosis. */
  tenantId: string;
  controls: CanaryControlResult[];
  /** Set when `heal` was requested and a self-heal reindex was attempted. */
  healed?: {
    attempted: boolean;
    reindexOk: boolean;
    /** Whether the re-check after the heal passed. */
    recheckHealthy: boolean;
  };
}

async function runControls(
  adapter: QmdAdapter,
  tenantId: string,
  controls: readonly CanaryControl[],
): Promise<CanaryControlResult[]> {
  const results: CanaryControlResult[] = [];
  for (const control of controls) {
    const minHits = control.minHits ?? 1;
    const scope = control.scope ?? 'all';
    const searchResult: Result<{ length: number }, QmdError> = await adapter.query(
      control.query,
      scope,
      tenantId,
    );
    if (!searchResult.ok) {
      results.push({
        query: control.query,
        minHits,
        hits: 0,
        passed: false,
        error: searchResult.error,
      });
      continue;
    }
    const hits = searchResult.value.length;
    results.push({ query: control.query, minHits, hits, passed: hits >= minHits });
  }
  return results;
}

/** Options for {@link runSearchCanary}. */
export interface SearchCanaryOptions {
  /** Override the default controls. */
  controls?: readonly CanaryControl[];
  /**
   * When true, and the first pass is unhealthy, attempt an idempotent
   * {@link reindex} then re-run the controls once. The canary still reports
   * `healthy` off the FINAL state, so a heal that fixes the index turns the run
   * green — but the `healed` block records that intervention happened (so the
   * degradation is never silent even when auto-repaired).
   */
  heal?: boolean;
}

/**
 * Search-health canary: run known-positive control queries and report whether
 * the governed brain is actually searchable.
 *
 * This is the loud alarm the "SEARCH DEGRADED" incident lacked. `brain_search`
 * degrades to an empty result rather than throwing (a missing/misrouted index
 * reads as "nothing retrievable"), so a broken index is INVISIBLE at the tool
 * surface — every query just quietly returns nothing. This canary makes that
 * failure detectable and CI/cron-actionable: if a known-positive control comes
 * back with zero hits, `healthy` is false and the caller (CLI `exit 1`, nightly
 * gate) fails loudly.
 *
 * Never throws — a failed search command is captured per-control as
 * `passed: false` with the underlying `QmdError`, so the canary itself can't be
 * the thing that crashes the pipeline.
 */
export async function runSearchCanary(
  adapter: QmdAdapter,
  tenantId: string,
  options: SearchCanaryOptions = {},
): Promise<SearchCanaryReport> {
  const controls = options.controls ?? DEFAULT_CANARY_CONTROLS;

  const firstPass = await runControls(adapter, tenantId, controls);
  const firstHealthy = firstPass.every((c) => c.passed);

  if (firstHealthy || !options.heal) {
    return { healthy: firstHealthy, tenantId, controls: firstPass };
  }

  // Unhealthy + heal requested: attempt an idempotent reindex, then re-check.
  const reindexResult = await reindex(adapter);
  const secondPass = await runControls(adapter, tenantId, controls);
  const recheckHealthy = secondPass.every((c) => c.passed);

  return {
    healthy: recheckHealthy,
    tenantId,
    controls: secondPass,
    healed: { attempted: true, reindexOk: reindexResult.ok, recheckHealthy },
  };
}

/** Render a canary report as a compact, log-friendly summary. */
export function formatCanaryReport(report: SearchCanaryReport): string {
  const header = report.healthy
    ? `SEARCH HEALTHY (tenant=${report.tenantId})`
    : `SEARCH DEGRADED (tenant=${report.tenantId})`;
  const lines = report.controls.map((c) => {
    const status = c.passed ? 'OK ' : 'FAIL';
    const err = c.error ? ` [${c.error.code}: ${c.error.message}]` : '';
    return `  [${status}] "${c.query}" -> ${c.hits} hits (min ${c.minHits})${err}`;
  });
  if (report.healed) {
    lines.push(
      `  heal: attempted, reindexOk=${report.healed.reindexOk}, recheckHealthy=${report.healed.recheckHealthy}`,
    );
  }
  return [header, ...lines].join('\n');
}
