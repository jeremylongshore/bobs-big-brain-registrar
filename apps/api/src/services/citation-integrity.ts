import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import {
  extractFrontmatter,
  getRelativePath,
  isExportRestricted,
  renderFrontmatter,
} from '@qmd-team-intent-kb/git-exporter';
import { getExportableCollections, resolveCitationPath } from '@qmd-team-intent-kb/qmd-adapter';
import type { AuditRepository, MemoryRepository } from '@qmd-team-intent-kb/store';

export type CitationFailureCode =
  | 'RECEIPT_TENANT_MISMATCH'
  | 'MEMORY_MISSING'
  | 'MEMORY_ID_MISMATCH'
  | 'MEMORY_TENANT_MISMATCH'
  | 'UNRESOLVABLE_CITATION'
  | 'UNSAFE_EXPORT_PATH'
  | 'EXPORT_MISSING'
  | 'EXPORT_NOT_REGULAR'
  | 'EXPORT_UNREADABLE'
  | 'HEADER_IDENTITY_MISMATCH';

export interface CitationIntegrityEntry {
  receiptId: string;
  memoryId: string;
  citation: string | null;
  status: 'checked' | 'excluded' | 'failed';
  code?: CitationFailureCode | 'EXPORT_RESTRICTED';
}

export interface CitationIntegrityReport {
  passed: boolean;
  totalPromotionCount: number;
  /** Same-tenant resolved identities permitted by the canonical export policy. */
  eligiblePromotionCount: number;
  excludedPromotionCount: number;
  checkedPromotionCount: number;
  /** Includes identity failures before export eligibility can be established. */
  failedPromotionCount: number;
  entries: CitationIntegrityEntry[];
}

export interface CitationIntegrityOptions {
  tenantId: string;
  exportDir: string;
  auditRepo: Pick<AuditRepository, 'findByTenantAndAction'>;
  memoryRepo: Pick<MemoryRepository, 'findById'>;
}

/**
 * Read-only snapshot check: promotion receipts contain memory IDs, not citations.
 * Resolve every export-eligible promoted identity through the canonical exporter
 * and qmd collection mapping, then compare its canonical frontmatter on disk.
 * This checks identity/header consistency, not body truth, entailment, index
 * availability, audit-chain authenticity or safety against concurrent writers.
 */
export function checkPromotedCitationIntegrity(
  options: CitationIntegrityOptions,
): CitationIntegrityReport {
  const { tenantId, auditRepo, memoryRepo } = options;
  // Resolve a caller's root alias once; only redirects below this root are
  // refused. Missing roots still produce per-receipt missing-export results.
  let exportDir = resolve(options.exportDir);
  try {
    exportDir = realpathSync(exportDir);
  } catch {
    // File inspection reports an absent or unreadable export tree below.
  }
  const receipts = auditRepo.findByTenantAndAction(tenantId, 'promoted');
  const entries: CitationIntegrityEntry[] = [];
  let eligiblePromotionCount = 0;
  let excludedPromotionCount = 0;
  let checkedPromotionCount = 0;

  for (const receipt of receipts) {
    const entry: CitationIntegrityEntry = {
      receiptId: receipt.id,
      memoryId: receipt.memoryId,
      citation: null,
      status: 'failed',
    };
    entries.push(entry);
    if (receipt.tenantId !== tenantId) {
      entry.code = 'RECEIPT_TENANT_MISMATCH';
      continue;
    }
    const memory = memoryRepo.findById(receipt.memoryId);
    if (memory === null) {
      entry.code = 'MEMORY_MISSING';
      continue;
    }
    if (memory.id !== receipt.memoryId) {
      entry.code = 'MEMORY_ID_MISMATCH';
      continue;
    }
    if (memory.tenantId !== tenantId) {
      entry.code = 'MEMORY_TENANT_MISMATCH';
      continue;
    }
    if (isExportRestricted(memory)) {
      entry.status = 'excluded';
      entry.code = 'EXPORT_RESTRICTED';
      excludedPromotionCount++;
      continue;
    }
    eligiblePromotionCount++;
    let file: string | null;
    try {
      const relativePath = getRelativePath(memory);
      const collection = getExportableCollections().find(
        (candidate) => candidate.sourceSubdir === dirname(relativePath),
      );
      if (collection === undefined) {
        entry.code = 'UNRESOLVABLE_CITATION';
        continue;
      }
      entry.citation = `qmd://${collection.name}/${memory.id}.md`;
      file = resolveCitationPath(exportDir, entry.citation);
      if (file === null || resolve(file) !== resolve(exportDir, relativePath)) {
        entry.code = 'UNRESOLVABLE_CITATION';
        continue;
      }
    } catch {
      entry.code = 'UNRESOLVABLE_CITATION';
      continue;
    }

    const expected = Buffer.from(renderFrontmatter(extractFrontmatter(memory)) + '\n\n', 'utf8');
    const failure = inspectExportHeader(exportDir, file, expected);
    if (failure !== undefined) {
      entry.code = failure;
      continue;
    }
    entry.status = 'checked';
    checkedPromotionCount++;
  }

  return {
    passed: eligiblePromotionCount > 0 && entries.every((entry) => entry.status !== 'failed'),
    totalPromotionCount: receipts.length,
    eligiblePromotionCount,
    excludedPromotionCount,
    checkedPromotionCount,
    failedPromotionCount: entries.filter((entry) => entry.status === 'failed').length,
    entries,
  };
}

/** Read only the expected canonical header, with no unbounded file-body read. */
function inspectExportHeader(
  exportDir: string,
  file: string,
  expected: Buffer,
): CitationFailureCode | undefined {
  let descriptor: number | undefined;
  try {
    const root = exportDir;
    const target = resolve(file);
    const confined = relative(root, target);
    if (
      confined === '' ||
      confined === '..' ||
      confined.startsWith('..' + sep) ||
      realpathSync(dirname(target)) !== dirname(target)
    ) {
      return 'UNSAFE_EXPORT_PATH';
    }
    const named = lstatSync(target);
    if (!named.isFile()) {
      return 'EXPORT_NOT_REGULAR';
    }
    if (realpathSync(target) !== target || target !== join(root, confined)) {
      return 'UNSAFE_EXPORT_PATH';
    }
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
      return 'UNSAFE_EXPORT_PATH';
    }
    const actual = Buffer.alloc(expected.length);
    let offset = 0;
    while (offset < actual.length) {
      const count = readSync(descriptor, actual, offset, actual.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== expected.length || !actual.equals(expected)) {
      return 'HEADER_IDENTITY_MISMATCH';
    }
    return undefined;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'EXPORT_MISSING'
      : 'EXPORT_UNREADABLE';
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
