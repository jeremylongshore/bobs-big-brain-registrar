import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ingestFromSpool, Curator } from '@qmd-team-intent-kb/curator';
import {
  loadOrCreateOriginSecret,
  ORIGIN_SECRET_UNAVAILABLE_WARNING,
} from '@qmd-team-intent-kb/common';
import { runExport } from '@qmd-team-intent-kb/git-exporter';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { resolveRepoContext } from '@qmd-team-intent-kb/repo-resolver';
import type { DaemonConfig, DaemonDependencies, CycleResult, DaemonLogger } from './types.js';
import { runStalenessSweep } from './staleness.js';
import { writeFeedback } from './feedback.js';
import { filterByRepoScope } from './repo-scope.js';
import { withRetry } from './retry.js';

/**
 * Check if enterprise managed settings disable memory capture.
 *
 * Reads ~/.claude/settings.json and checks for memoryCapture.enabled === false.
 * Safe default: if file is absent or unparseable, returns true (proceed).
 */
function isMemoryCaptureEnabled(): boolean {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return true;
    const raw = readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const memoryCapture = settings['memoryCapture'] as Record<string, unknown> | undefined;
    if (memoryCapture && memoryCapture['enabled'] === false) return false;
    return true;
  } catch {
    return true; // safe default: proceed if settings unreadable
  }
}

/**
 * Resolve the repo remote URL used for `scopeByRepo` filtering.
 *
 * Preference order:
 *   1. deps.repoContext is a RepoContext — use it directly (resolved once at startup).
 *   2. deps.repoContext is null         — startup resolution failed; scoping disabled.
 *   3. deps.repoContext is undefined    — not provided (e.g. test paths); fall back to
 *                                         resolving here per-cycle (legacy behaviour).
 *
 * On any resolver error, degrade gracefully: log a warning and return null
 * (scoping disabled for this cycle). Returns null when scoping is off.
 */
async function resolveScopedRemoteUrl(
  config: DaemonConfig,
  deps: DaemonDependencies,
  logger: DaemonLogger,
): Promise<string | null> {
  if (!config.scopeByRepo) return null;

  if (deps.repoContext === null) {
    // Startup resolution failed — scoping was already warned at daemon start
    logger.warn('[repo-scope] Startup resolver failed — repo-scope filter disabled for this cycle');
    return null;
  }

  if (deps.repoContext !== undefined) {
    // Happy path: pre-resolved at startup, no subprocess cost this cycle
    const remoteUrl = deps.repoContext.remoteUrl;
    if (!remoteUrl) {
      logger.warn(
        '[repo-scope] Resolver returned no remoteUrl — repo-scope filter disabled for this cycle',
      );
      return null;
    }
    return remoteUrl;
  }

  // Fallback: deps.repoContext not provided — resolve now (backward-compat for tests)
  try {
    const repoResult = await resolveRepoContext(process.cwd());
    if (!repoResult.ok) {
      logger.warn(
        `[repo-scope] Resolver failed (${repoResult.error.kind}) — repo-scope filter disabled for this cycle`,
      );
      return null;
    }
    const remoteUrl = repoResult.value.remoteUrl;
    if (!remoteUrl) {
      logger.warn(
        '[repo-scope] Resolver returned no remoteUrl — repo-scope filter disabled for this cycle',
      );
      return null;
    }
    return remoteUrl;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(
      `[repo-scope] Resolver threw unexpectedly: ${msg} — repo-scope filter disabled for this cycle`,
    );
    return null;
  }
}

/**
 * Step 1: ingest candidates from the spool, applying the per-cycle cap and
 * (when enabled) the repo-scope filter. Mutates `result.ingest`; returns the
 * candidates that survived capping + scoping.
 */
async function ingestStep(
  config: DaemonConfig,
  deps: DaemonDependencies,
  logger: DaemonLogger,
  resolvedRemoteUrl: string | null,
  result: CycleResult,
): Promise<MemoryCandidate[]> {
  try {
    const ingestResult = await ingestFromSpool(deps.candidateRepo, config.spoolDir);
    if (!ingestResult.ok) {
      result.ingest.errors.push(ingestResult.error);
      logger.error(`Ingest failed: ${ingestResult.error}`);
      return [];
    }

    // Threat #2: Cap candidates per cycle
    const capped = ingestResult.value.slice(0, config.maxCandidatesPerCycle);
    if (ingestResult.value.length > config.maxCandidatesPerCycle) {
      const msg = `Capped ingestion: ${ingestResult.value.length} found, processing ${config.maxCandidatesPerCycle}`;
      result.ingest.errors.push(msg);
      logger.warn(msg);
    }

    // Apply repo-scope filter when flag is on and resolver succeeded with a remoteUrl
    let ingestedCandidates = capped;
    if (config.scopeByRepo && resolvedRemoteUrl) {
      const scopeResult = filterByRepoScope(capped, resolvedRemoteUrl, logger);
      ingestedCandidates = scopeResult.kept;
      if (scopeResult.skipped > 0) {
        logger.warn(
          `[repo-scope] Skipped ${scopeResult.skipped} candidate(s) from mismatched repos`,
        );
      }
    }

    result.ingest.ingested = ingestedCandidates.length;
    return ingestedCandidates;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.ingest.errors.push(msg);
    logger.error(`Ingest error: ${msg}`);
    return [];
  }
}

/**
 * Step 2: curate the ingested candidates (dedup + policy + promote) and write
 * rejection feedback for MCP status visibility. Mutates `result.curation`.
 */
function curateStep(
  config: DaemonConfig,
  deps: DaemonDependencies,
  logger: DaemonLogger,
  candidates: MemoryCandidate[],
  nowFn: () => string,
  result: CycleResult,
): void {
  try {
    const curator = new Curator(
      {
        candidateRepo: deps.candidateRepo,
        memoryRepo: deps.memoryRepo,
        policyRepo: deps.policyRepo,
        auditRepo: deps.auditRepo,
      },
      {
        tenantId: config.tenantId,
        supersessionThreshold: config.supersessionThreshold,
        // Write-time provenance (H1): resolve the installation origin secret so
        // origin-claiming candidates verify; absent/unreadable → they reject
        // fail-closed as unverifiable while unattested candidates flow as before.
        originSecret: resolveOriginSecretSafe(logger),
      },
    );

    result.curation = curator.processBatch(candidates);
    logger.info(
      `Curation: ${result.curation.promoted} promoted, ${result.curation.rejected} rejected, ${result.curation.duplicates} duplicates`,
    );

    // Write rejection feedback for MCP status visibility
    if (result.curation.rejected > 0 || result.curation.flagged > 0) {
      try {
        writeFeedback(result.curation, nowFn);
      } catch (feedbackErr) {
        const msg = feedbackErr instanceof Error ? feedbackErr.message : String(feedbackErr);
        logger.warn(`Feedback write failed: ${msg}`);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Curation error: ${msg}`);
  }
}

/**
 * Step 2b: staleness sweep — auto-deprecate stale active memories.
 * Mutates `result.staleness`. No-op when the sweep is disabled.
 */
function stalenessStep(
  config: DaemonConfig,
  deps: DaemonDependencies,
  logger: DaemonLogger,
  nowFn: () => string,
  result: CycleResult,
): void {
  if (!config.enableStalenessSweep) return;
  try {
    result.staleness = runStalenessSweep(
      deps.memoryRepo,
      deps.auditRepo,
      { tenantId: config.tenantId, staleDays: config.staleDays },
      nowFn,
    );
    if (result.staleness.deprecated > 0) {
      logger.info(
        `Staleness sweep: ${result.staleness.deprecated} of ${result.staleness.scanned} deprecated`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Staleness sweep error: ${msg}`);
  }
}

/**
 * Step 3: git export — retried on transient push conflicts.
 * Mutates `result.export`. No-op when export is disabled.
 */
async function exportStep(
  config: DaemonConfig,
  deps: DaemonDependencies,
  logger: DaemonLogger,
  nowFn: () => string,
  result: CycleResult,
): Promise<void> {
  if (!config.enableExport) return;
  try {
    result.export = await withRetry(
      async () =>
        runExport(
          deps.memoryRepo,
          deps.exportStateRepo,
          {
            outputDir: config.exportOutputDir,
            targetId: config.exportTargetId,
            tenantId: config.tenantId,
          },
          nowFn,
        ),
      {
        maxRetries: config.maxRetries,
        baseDelayMs: config.retryBaseDelayMs,
        maxJitterMs: config.retryMaxJitterMs,
        sleepFn: config.sleepFn,
      },
    );
    logger.info(
      `Export: ${result.export.written.length} written, ${result.export.archived.length} archived`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Export error: ${msg}`);
  }
}

/**
 * Step 4: qmd index update — offline resilient, retried on transient qmd
 * errors. Mutates `result.indexUpdate`. No-op when disabled or no adapter.
 *
 * `indexedAt` is the freshness watermark to record on success. It MUST be
 * captured before the EXPORT step's curated_memories read (runCycle hoists it
 * to just before `exportStep`), not here at the start of the index update:
 * this step only re-indexes what the export already wrote, so the data this
 * cycle can possibly absorb was fixed at the export read. Capturing the
 * watermark here (as this step originally did) post-dated that read — a
 * promotion landing between the export's read and a here-captured watermark
 * got `last_indexed_at > promoted_at` and measured FRESH while its markdown
 * was never exported or indexed: a false-fresh on the dangerous side, letting
 * the canary staleness gate pass over degraded retrieval (PR #293 review
 * finding, MiniMax defect lane). With the pre-export watermark the same race
 * measures stale and is re-absorbed next cycle — under-claiming freshness is
 * the only allowed error direction. Mirrors the API path
 * (`apps/api` index-refresher, watermark before `runExport`).
 */
async function indexUpdateStep(
  config: DaemonConfig,
  deps: DaemonDependencies,
  logger: DaemonLogger,
  indexedAt: string,
  result: CycleResult,
): Promise<void> {
  if (!config.enableIndexUpdate || !deps.qmdAdapter) return;
  const adapter = deps.qmdAdapter;
  const retryOpts = {
    maxRetries: config.maxRetries,
    baseDelayMs: config.retryBaseDelayMs,
    maxJitterMs: config.retryMaxJitterMs,
    sleepFn: config.sleepFn,
  };
  try {
    await withRetry(async () => {
      const ensureResult = await adapter.ensureCollections();
      if (!ensureResult.ok) {
        throw new Error(ensureResult.error.message);
      }
      const updateResult = await adapter.update();
      if (!updateResult.ok) {
        throw new Error(updateResult.error.message);
      }
    }, retryOpts);
    result.indexUpdate = { ok: true };
    // Freshness consumption (D1/D2): the export→reindex chain COMPLETED, so
    // record it — this is what clears the derived index-dirty state and zeroes
    // the staleness gauge. Only on full success; a failed update must leave
    // the gauge reporting stale.
    try {
      deps.indexStateRepo?.markIndexed(config.tenantId, indexedAt);
    } catch (markErr) {
      const msg = markErr instanceof Error ? markErr.message : String(markErr);
      logger.warn(`Index-state mark failed (staleness gauge may over-report): ${msg}`);
    }
    logger.info('Index update complete');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.indexUpdate = { ok: false, error: msg };
    logger.warn(`Index update error: ${msg}`);
  }
}

/**
 * Run one full daemon cycle: ingest → curate → export → index update.
 *
 * Each step catches its own errors. A failed step does NOT abort the cycle —
 * it records the error and continues to the next step. The per-step logic
 * lives in named helpers (resolveScopedRemoteUrl / ingestStep / curateStep /
 * stalenessStep / exportStep / indexUpdateStep) so this coordinator stays a
 * thin, low-complexity sequence (bead `igs`).
 */
export async function runCycle(
  config: DaemonConfig,
  deps: DaemonDependencies,
  logger: DaemonLogger,
): Promise<CycleResult> {
  const nowFn = config.nowFn ?? (() => new Date().toISOString());
  const startedAt = nowFn();

  const result: CycleResult = {
    startedAt,
    completedAt: '',
    ingest: { ingested: 0, errors: [] },
    curation: null,
    staleness: null,
    export: null,
    indexUpdate: null,
  };

  // Threat #8: Enterprise managed settings check
  if (!isMemoryCaptureEnabled()) {
    logger.info('Memory capture disabled by enterprise settings — skipping cycle');
    result.completedAt = nowFn();
    return result;
  }

  const resolvedRemoteUrl = await resolveScopedRemoteUrl(config, deps, logger);

  const ingestedCandidates = await ingestStep(config, deps, logger, resolvedRemoteUrl, result);

  // Step 2: Curate — only if we ingested something
  if (ingestedCandidates.length > 0) {
    curateStep(config, deps, logger, ingestedCandidates, nowFn, result);
  }

  stalenessStep(config, deps, logger, nowFn, result);
  // Freshness watermark (D2) — hoisted to BEFORE the export step reads
  // curated_memories (#293 review finding). The export read is the moment the
  // set of promotions this cycle can absorb is fixed, so the watermark must
  // not post-date it: a promotion landing after this instant measures stale
  // (correct — its markdown was not exported this cycle) and is absorbed next
  // cycle. See indexUpdateStep's doc for the false-fresh race this prevents.
  const indexedAt = nowFn();
  await exportStep(config, deps, logger, nowFn, result);
  await indexUpdateStep(config, deps, logger, indexedAt, result);

  result.completedAt = nowFn();
  return result;
}

/**
 * Resolve the installation origin secret (H1) without letting a filesystem
 * fault abort the curation cycle. Returns undefined on failure, which the
 * origin gate treats fail-closed for origin-CLAIMING candidates only. The
 * degradation is WARNED with the same shared message the API boot and
 * curator CLI emit, so operators can grep one phrase across all surfaces.
 */
function resolveOriginSecretSafe(logger: DaemonLogger): string | undefined {
  try {
    return loadOrCreateOriginSecret();
  } catch (e) {
    logger.warn(
      `${ORIGIN_SECRET_UNAVAILABLE_WARNING} (${e instanceof Error ? e.message : String(e)})`,
    );
    return undefined;
  }
}
