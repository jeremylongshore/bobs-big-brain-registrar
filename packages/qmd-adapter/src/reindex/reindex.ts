import type { Result } from '@qmd-team-intent-kb/common';
import type { QmdError } from '../types.js';
import type { QmdAdapter } from '../adapter.js';

/** Outcome of an idempotent reindex run. */
export interface ReindexReport {
  /** Collections newly registered this run (empty on a re-run — that is the idempotency signal). */
  collectionsCreated: string[];
  /** Whether `qmd update` (re-index of every registered collection) completed. */
  indexUpdated: boolean;
}

/**
 * Rebuild a tenant's qmd index from the git-exporter output tree — the single
 * repeatable, idempotent reindex primitive.
 *
 * This is the exact `ensureCollections()` → `update()` sequence the edge-daemon
 * runs at the end of every cycle (`apps/edge-daemon/src/cycle.ts` step 4),
 * lifted into one named operation so it can also run standalone (CLI / canary
 * self-heal / runbook) against a live `~/.teamkb` without booting the daemon.
 *
 * Why this exists (bead compile-then-govern-e06.13 / risk register R11 /
 * umbrella #27): the qmd-index is Tier-C DERIVED state — rebuildable purely from
 * `kb-export`, never source-of-truth. When a tenant's index is empty or stale
 * (e.g. a tenant whose collections were never registered, so `qmd search`
 * returns `[]` on known-positive controls — the "SEARCH DEGRADED" failure this
 * fixes), this restores it without touching `teamkb.db` or `brain/raw/`.
 *
 * Idempotent by construction:
 *   - `ensureCollections()` registers only missing collections (mkdir -p +
 *     `qmd collection add` guarded by a `collection list` check), so a re-run
 *     reports `collectionsCreated: []`.
 *   - `qmd update` re-indexes changed/added files against the registered
 *     collections; running it twice with no corpus change is a no-op.
 *
 * Fail-closed: the first failing step returns its `QmdError` and the second
 * step is NOT attempted — a caller must never conclude "reindexed" off a
 * half-built index.
 */
export async function reindex(adapter: QmdAdapter): Promise<Result<ReindexReport, QmdError>> {
  const ensureResult = await adapter.ensureCollections();
  if (!ensureResult.ok) {
    return { ok: false, error: ensureResult.error };
  }

  const updateResult = await adapter.update();
  if (!updateResult.ok) {
    return { ok: false, error: updateResult.error };
  }

  return {
    ok: true,
    value: { collectionsCreated: ensureResult.value, indexUpdated: true },
  };
}
