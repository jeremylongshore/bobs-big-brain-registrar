import type { MemoryRepository, ExportStateRepository } from '@qmd-team-intent-kb/store';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import type { ExportChangeset, ExportConfig } from '../types.js';
import { getRelativePath, getActiveDirectory } from '../formatter/directory-mapper.js';
import { join } from 'node:path';
import { findStaleFiles } from './stale-files.js';

/** Default ceiling on orphan removals per reconcile run (mass-delete guard). */
export const DEFAULT_MAX_ORPHAN_REMOVALS = 50;

/**
 * Detect what has changed since the last export and build a changeset.
 *
 * - First run (no export state): returns all memories across all lifecycle states.
 * - Subsequent runs: only memories whose `updatedAt` is strictly after `lastExportedAt`.
 * - Reconcile mode (`config.reconcile`): every memory, regardless of export state,
 *   plus `toRemove` for stale files on disk (see `findStaleFiles`).
 *
 * Active / deprecated memories → `toWrite`
 * Archived / superseded memories → `toArchive` (move from category dir to archive/)
 */
export function detectChanges(
  memoryRepo: MemoryRepository,
  exportStateRepo: ExportStateRepository,
  config: ExportConfig,
): ExportChangeset {
  const exportState = exportStateRepo.get(config.targetId);

  let memories: CuratedMemory[];
  // Read failures (5bm.12): a row that fails domain validation on read — e.g. a
  // legacy category later removed from the enum — is isolated per-row rather than
  // aborting the batch, then quarantined below alongside mapping failures.
  const readFailures: Array<{ id: string; reason: string }> = [];

  if (config.tenantId !== undefined) {
    const res = memoryRepo.findByTenantResilient(config.tenantId);
    memories = res.memories;
    readFailures.push(...res.failures);
  } else {
    const parts = (['active', 'deprecated', 'superseded', 'archived'] as const).map((lc) =>
      memoryRepo.findByLifecycleResilient(lc),
    );
    memories = parts.flatMap((p) => p.memories);
    readFailures.push(...parts.flatMap((p) => p.failures));
  }

  // The full set, before any incremental filtering — reconcile mode compares the
  // whole tree against it; incremental mode never reads it past this point.
  const allMemories = memories;
  const reconcile = config.reconcile === true;

  if (exportState !== null && !reconcile) {
    memories = memories.filter((m) => m.updatedAt > exportState.lastExportedAt);
  }

  const toWrite: ExportChangeset['toWrite'] = [];
  const toArchive: ExportChangeset['toArchive'] = [];
  // A row we could not even deserialize is quarantined with an empty category —
  // we never got a valid domain object to read one from.
  const quarantined: ExportChangeset['quarantined'] = readFailures.map((f) => ({
    id: f.id,
    category: '',
    reason: f.reason,
  }));

  for (const memory of memories) {
    // Per-memory quarantine (5bm.12): the directory-mapper is fail-closed (5bm.5)
    // and throws on an unknown category. Catch it here so ONE malformed memory
    // is set aside and reported — not allowed to abort the export of every other
    // memory. A quarantined memory is neither written nor silently dropped into
    // curated/; the operator fixes it at source (recategorize, 5bm.7).
    try {
      if (memory.lifecycle === 'archived' || memory.lifecycle === 'superseded') {
        // File may currently live in its active-time directory (category dir,
        // or bulk/ for a bulk_import memory — 5bm.8).
        const activeDir = getActiveDirectory(memory);
        const fromPath = join(config.outputDir, activeDir, `${memory.id}.md`);
        const toPath = join(config.outputDir, getRelativePath(memory));
        toArchive.push({ memory, fromPath, toPath });
      } else {
        const filePath = join(config.outputDir, getRelativePath(memory));
        toWrite.push({ memory, filePath });
      }
    } catch (err) {
      quarantined.push({
        id: memory.id,
        category: memory.category ?? '',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!reconcile) {
    return { toWrite, toArchive, toRemove: [], quarantined };
  }

  // Reconcile: also find files the DB no longer justifies (see findStaleFiles).
  const stale = findStaleFiles(
    config.outputDir,
    allMemories,
    new Set(quarantined.map((q) => q.id)),
    config.tenantId,
    config.maxOrphanRemovals ?? DEFAULT_MAX_ORPHAN_REMOVALS,
  );
  return {
    toWrite,
    toArchive,
    toRemove: stale.toRemove,
    quarantined,
    ...(stale.removalBlocked !== undefined ? { removalBlocked: stale.removalBlocked } : {}),
  };
}
