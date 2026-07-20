import type Database from 'better-sqlite3';
import { runExport } from '@qmd-team-intent-kb/git-exporter';
import {
  MemoryRepository,
  ExportStateRepository,
  IndexStateRepository,
} from '@qmd-team-intent-kb/store';
import { reindex, type QmdAdapter } from '@qmd-team-intent-kb/qmd-adapter';

/** Outcome of one post-promotion refresh — for logging/tests, never thrown. */
export interface RefreshOutcome {
  /** True when the FULL export→reindex chain completed and was recorded. */
  ok: boolean;
  /** Set when the refresh was skipped (with why) rather than attempted. */
  skipped?: string;
  /** Set when a step failed (with the failing step's message). */
  error?: string;
}

/**
 * Port the promote route calls after a promotion COMMITS (D1). Kept as an
 * interface so tests can inject a fake and deployments without qmd can omit it.
 */
export interface IndexRefresher {
  refreshAfterPromotion(tenantId: string): Promise<RefreshOutcome>;
}

/** Wiring for {@link buildIndexRefresher}. */
export interface IndexRefresherOptions {
  db: Database.Database;
  /** The tenant-bound adapter the API already constructed for cited search. */
  adapter: QmdAdapter;
  /** git-exporter output dir — the same tree the adapter indexes. */
  exportDir: string;
  /** Export-state target id. Default matches the daemon/plugin: kb-export-default. */
  exportTargetId?: string;
  nowFn?: () => string;
  log?: (msg: string) => void;
}

/**
 * The D1 promote→searchable bridge for the API path.
 *
 * The curator-batch and plugin-govern paths already chain
 * promote → `runExport` → `ensureCollections`+`update` (edge-daemon cycle steps
 * 3–4; plugin `govern.ts` steps 3–4). The API's one-shot
 * `POST /api/candidates/:id/promote` had NO such step — a promoted memory sat
 * unsearchable until the next daemon cycle / nightly govern. This service
 * composes the SAME primitives (`runExport` + the `reindex` primitive the
 * canary/CLI already use — reuse, not reinvention) so the route can trigger a
 * scoped index update immediately AFTER the promotion transaction commits.
 *
 * Never inside the transaction: `promote()` commits the memory + its receipt
 * atomically (R9); this chain reads that committed state. Never throws: the
 * memory is already durable, so a failed refresh must degrade to "stale but
 * promoted" — which the D2 staleness gauge then reports — not fail the request.
 *
 * On FULL success it records `last_indexed_at` (IndexStateRepository), zeroing
 * the tenant's staleness gauge; on any failure the gauge keeps reporting stale
 * until the next successful chain (daemon cycle / govern pass) absorbs it.
 */
export function buildIndexRefresher(opts: IndexRefresherOptions): IndexRefresher {
  const memoryRepo = new MemoryRepository(opts.db);
  const exportStateRepo = new ExportStateRepository(opts.db);
  const indexStateRepo = new IndexStateRepository(opts.db);
  const targetId = opts.exportTargetId ?? 'kb-export-default';
  const nowFn = opts.nowFn ?? ((): string => new Date().toISOString());
  const log = opts.log ?? ((msg: string): void => void process.stderr.write(`${msg}\n`));

  return {
    async refreshAfterPromotion(tenantId: string): Promise<RefreshOutcome> {
      // The adapter's qmd registry + index are bound to ONE tenant. A promotion
      // in any other tenant cannot be absorbed by this adapter — skip rather
      // than reindex the wrong scope. The promotion still moves that tenant's
      // derived staleness, so the drift stays observable (D2).
      if (tenantId !== opts.adapter.boundTenantId) {
        return {
          ok: false,
          skipped: `adapter is bound to tenant ${opts.adapter.boundTenantId}, not ${tenantId}`,
        };
      }

      // Watermark BEFORE the chain runs: a promotion landing mid-chain may not
      // be absorbed, so marking with the pre-chain instant can only
      // under-claim freshness, never over-claim it.
      const indexedAt = nowFn();
      try {
        runExport(
          memoryRepo,
          exportStateRepo,
          { outputDir: opts.exportDir, targetId, tenantId },
          nowFn,
        );

        const reindexed = await reindex(opts.adapter);
        if (!reindexed.ok) {
          const msg = `${reindexed.error.code}: ${reindexed.error.message}`;
          log(`[index-refresher] reindex failed (tenant=${tenantId}): ${msg}`);
          return { ok: false, error: msg };
        }

        indexStateRepo.markIndexed(tenantId, indexedAt);
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[index-refresher] refresh failed (tenant=${tenantId}): ${msg}`);
        return { ok: false, error: msg };
      }
    },
  };
}
