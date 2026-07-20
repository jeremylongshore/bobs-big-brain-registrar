import type { SearchScope } from '@qmd-team-intent-kb/schema';
import type { QmdError, StalenessProbe } from '../types.js';
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
  // Estate / ops themes that must stay searchable (day-1 operator brain).
  // If any returns 0 hits, the index is empty/stale/misrouted or corpus was gutted.
  { query: 'SOPS age secrets' },
  { query: 'beads issue tracking' },
  { query: 'Contabo VPS intentsolutions' },
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

/** Index-staleness gate outcome (D2). */
export interface CanaryStalenessResult {
  /**
   * Measured staleness in seconds — `null` means unmeasured (no probe data /
   * measurement not started), which PASSES: the gate asserts on measured
   * staleness only, never on the absence of measurement.
   */
  stalenessSeconds: number | null;
  /** The threshold the gate enforced. */
  maxStalenessSeconds: number;
  /** `stalenessSeconds === null || stalenessSeconds <= maxStalenessSeconds`. */
  passed: boolean;
}

/** Aggregate canary outcome. */
export interface SearchCanaryReport {
  /** True only when EVERY control passed (and the staleness gate, when enabled). */
  healthy: boolean;
  /** The tenant the canary ran against, for diagnosis. */
  tenantId: string;
  controls: CanaryControlResult[];
  /**
   * Set when a staleness gate was requested (`maxStalenessSeconds` +
   * `stalenessProbe`). A failed gate makes the whole canary unhealthy: promoted
   * memories older than the threshold that search cannot see yet is the same
   * "retrievability degraded" class as a 0-hit control.
   */
  staleness?: CanaryStalenessResult;
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
  controls: readonly CanaryControl[],
): Promise<CanaryControlResult[]> {
  const results: CanaryControlResult[] = [];
  for (const control of controls) {
    const minHits = control.minHits ?? 1;
    const scope = control.scope ?? 'all';
    // Probe the qmd backend DIRECTLY, not the fused query() surface: the
    // canary exists to catch an empty/unregistered qmd index (the incident)
    // and drive `reindex`. The native FTS5 fusion half (vps.2) would keep
    // serving hits over an empty qmd index — graceful degradation for users,
    // but exactly the masking this canary must see through. The adapter was
    // constructed for `tenantId`, so the direct call stays tenant-scoped.
    const searchResult = await adapter.search.search(control.query, scope);
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
  /**
   * Index-staleness gate (D2): fail the canary when the measured
   * `stalenessSeconds` exceeds this threshold. Requires `stalenessProbe`; when
   * either is absent the gate is skipped (no `staleness` block in the report).
   */
  maxStalenessSeconds?: number;
  /**
   * Freshness probe supplying the measured staleness — the adapter layer is
   * store-free, so the caller that owns the governed store injects it (the CLI
   * wires `IndexStateRepository.stalenessSeconds`). `null` = unmeasured, which
   * PASSES the gate (fail-open on fresh deploys; see IndexStateRepository).
   */
  stalenessProbe?: StalenessProbe;
}

/** Evaluate the staleness gate; a throwing probe degrades to unmeasured (null). */
function runStalenessGate(
  maxStalenessSeconds: number,
  probe: StalenessProbe,
): CanaryStalenessResult {
  let stalenessSeconds: number | null;
  try {
    stalenessSeconds = probe();
  } catch {
    stalenessSeconds = null;
  }
  return {
    stalenessSeconds,
    maxStalenessSeconds,
    passed: stalenessSeconds === null || stalenessSeconds <= maxStalenessSeconds,
  };
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

  // Staleness gate (D2), evaluated ONCE up front: it reads the governed store,
  // not the index, so a heal's reindex cannot change the measured value — only
  // the chain owner's `markIndexed` (export→reindex completion) clears it.
  const staleness =
    options.maxStalenessSeconds !== undefined && options.stalenessProbe !== undefined
      ? runStalenessGate(options.maxStalenessSeconds, options.stalenessProbe)
      : undefined;
  const stalenessPassed = staleness?.passed ?? true;

  // Fail-closed tenant guard, preserved from when the canary probed the fused
  // query() surface (which refuses mismatched tenants): a canary pointed at
  // the wrong tenant reports degraded without touching the executor at all.
  if (tenantId !== adapter.boundTenantId) {
    return {
      healthy: false,
      tenantId,
      controls: controls.map((c) => ({
        query: c.query,
        minHits: c.minHits ?? 1,
        hits: 0,
        passed: false,
      })),
      staleness,
    };
  }

  const firstPass = await runControls(adapter, controls);
  const firstHealthy = firstPass.every((c) => c.passed);

  if (firstHealthy || !options.heal) {
    return { healthy: firstHealthy && stalenessPassed, tenantId, controls: firstPass, staleness };
  }

  // Unhealthy + heal requested: attempt an idempotent reindex, then re-check.
  const reindexResult = await reindex(adapter);
  const secondPass = await runControls(adapter, controls);
  const recheckHealthy = secondPass.every((c) => c.passed);

  return {
    healthy: recheckHealthy && stalenessPassed,
    tenantId,
    controls: secondPass,
    staleness,
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
  if (report.staleness) {
    const s = report.staleness;
    const status = s.passed ? 'OK ' : 'FAIL';
    const value = s.stalenessSeconds === null ? 'unmeasured' : `${s.stalenessSeconds}s`;
    lines.push(`  [${status}] index staleness -> ${value} (max ${s.maxStalenessSeconds}s)`);
  }
  if (report.healed) {
    lines.push(
      `  heal: attempted, reindexOk=${report.healed.reindexOk}, recheckHealthy=${report.healed.recheckHealthy}`,
    );
  }
  return [header, ...lines].join('\n');
}
