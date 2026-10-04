import type { MemoryRepository, ExportStateRepository } from '@qmd-team-intent-kb/store';
import type { ExportConfig, ExportResult } from './types.js';
import { isExportRestricted } from './sensitivity.js';
import { detectChanges } from './diff/change-detector.js';
import { formatMemoryAsMarkdown } from './formatter/markdown-formatter.js';
import { writeFile, archiveFile, removeFile } from './writer/file-writer.js';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Main export orchestrator.
 *
 * Steps:
 * 1. Detect changes since last export
 * 2. Write new/updated files to their category directory
 * 3. Archive superseded/archived files to `archive/`
 * 4. Remove deleted files (changeset `toRemove`)
 * 5. Record the current timestamp as the new export state
 *
 * With `config.reconcile` the incremental `updatedAt` filter is dropped and the
 * export tree is reconciled against the DB as a whole (see `detectChanges`):
 * missing, stale, mis-filed and orphaned files are all converged, which is what
 * makes lifecycle changes made outside a promotion (batch-transition,
 * recategorize) land on disk. Every step is content-compared, so a crash at any
 * point leaves a tree the next reconcile run repairs, and a clean re-run
 * changes nothing.
 *
 * Idempotent: re-running when there are no changes produces no file writes.
 * Does NOT run `git commit` or `git push` — file generation only.
 *
 * @param nowFn - Optional injectable clock, defaults to `new Date().toISOString()`.
 *                Pass a deterministic value in tests to avoid real-time skew.
 */
export function runExport(
  memoryRepo: MemoryRepository,
  exportStateRepo: ExportStateRepository,
  config: ExportConfig,
  nowFn: () => string = () => new Date().toISOString(),
): ExportResult {
  const changeset = detectChanges(memoryRepo, exportStateRepo, config);

  const written: string[] = [];
  const archived: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  // Carry forward the memories the change-detector could not map (5bm.12) and
  // append any that fail during formatting/writing below.
  const quarantined = [...changeset.quarantined];
  let unchanged = 0;

  for (const item of changeset.toWrite) {
    if (isExportRestricted(item.memory)) {
      skipped.push(item.memory.id);
      continue;
    }
    // Per-memory quarantine (5bm.12): a formatter/write failure on one memory
    // must not abort the whole run — set it aside and keep exporting the rest.
    try {
      const content = formatMemoryAsMarkdown(item.memory);

      // Skip if file content is already identical (idempotency guard)
      if (existsSync(item.filePath)) {
        const existing = readFileSync(item.filePath, 'utf8');
        if (existing === content) {
          unchanged++;
          continue;
        }
      }

      writeFile(item.filePath, content);
      written.push(item.filePath);
    } catch (err) {
      quarantined.push({
        id: item.memory.id,
        category: item.memory.category ?? '',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const item of changeset.toArchive) {
    if (isExportRestricted(item.memory)) {
      skipped.push(item.memory.id);
      continue;
    }
    try {
      const content = formatMemoryAsMarkdown(item.memory);
      // Idempotency guard (mirrors the toWrite path): already archived with
      // identical bytes and no stale active-dir copy -> nothing to do.
      if (
        !existsSync(item.fromPath) &&
        existsSync(item.toPath) &&
        readFileSync(item.toPath, 'utf8') === content
      ) {
        unchanged++;
        continue;
      }
      archiveFile(item.fromPath, item.toPath, content);
      archived.push(item.toPath);
    } catch (err) {
      quarantined.push({
        id: item.memory.id,
        category: item.memory.category ?? '',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const filePath of changeset.toRemove) {
    if (removeFile(filePath)) {
      removed.push(filePath);
    }
  }

  exportStateRepo.set(config.targetId, nowFn());

  return {
    written,
    archived,
    removed,
    skipped,
    quarantined,
    unchanged,
    totalProcessed:
      changeset.toWrite.length + changeset.toArchive.length + changeset.toRemove.length,
    ...(changeset.removalBlocked !== undefined ? { removalBlocked: changeset.removalBlocked } : {}),
  };
}
