import type { MemoryRepository, ExportStateRepository } from '@qmd-team-intent-kb/store';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import type { ExportChangeset, ExportConfig } from '../types.js';
import { getRelativePath, getCategoryDirectory } from '../formatter/directory-mapper.js';
import { join } from 'node:path';

/**
 * Detect what has changed since the last export and build a changeset.
 *
 * - First run (no export state): returns all memories across all lifecycle states.
 * - Subsequent runs: only memories whose `updatedAt` is strictly after `lastExportedAt`.
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

  if (exportState !== null) {
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
        // File may currently live in its category directory (from when it was active).
        const categoryDir = getCategoryDirectory(memory.category);
        const fromPath = join(config.outputDir, categoryDir, `${memory.id}.md`);
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

  return { toWrite, toArchive, toRemove: [], quarantined };
}
