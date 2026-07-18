import type { MemoryRepository, ExportStateRepository } from '@qmd-team-intent-kb/store';
import { Sensitivity } from '@qmd-team-intent-kb/schema';
import type { ExportConfig, ExportResult } from './types.js';

/** Sensitivity threshold: memories at or above 'confidential' are skipped */
const CONFIDENTIAL_INDEX = Sensitivity.options.indexOf('confidential');

function isSensitivityRestricted(level: string): boolean {
  const idx = Sensitivity.options.indexOf(level as (typeof Sensitivity.options)[number]);
  return idx >= CONFIDENTIAL_INDEX;
}
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
    if (isSensitivityRestricted(item.memory.sensitivity)) {
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
    if (isSensitivityRestricted(item.memory.sensitivity)) {
      skipped.push(item.memory.id);
      continue;
    }
    try {
      const content = formatMemoryAsMarkdown(item.memory);
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
  };
}
