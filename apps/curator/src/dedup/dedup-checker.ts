import { computeContentHash } from '@qmd-team-intent-kb/common';
import type { MemoryRepository } from '@qmd-team-intent-kb/store';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';

/** Result of a duplicate check against the curated memory store */
export interface DedupResult {
  isDuplicate: boolean;
  /** ID of the existing curated memory that matched, when isDuplicate is true */
  matchedMemoryId?: string;
  matchType?: 'exact_hash';
  contentHash: string;
}

/**
 * Two-tier deduplication check:
 *   1. Exact SHA-256 content hash match against curated memories (definitive)
 *   2. (Future) qmd similarity search — flagging only, not implemented here
 *
 * Returns a DedupResult with isDuplicate=true when an exact match is found,
 * or isDuplicate=false for novel content. The contentHash is always populated
 * so callers can reuse it without re-computing.
 *
 * TENANT SCOPING (B1, bead compile-then-govern-jfv.2.1): when `tenantId` is
 * supplied the match is scoped to that tenant's memories, so a candidate is never
 * suppressed as a "duplicate" of a DIFFERENT tenant's memory (a cross-tenant leak
 * the API's promotion-service already guards against). The Curator always passes
 * its `config.tenantId`. Omitting `tenantId` preserves the legacy global match for
 * any caller that has not opted in.
 */
export function checkDuplicate(
  candidate: MemoryCandidate,
  memoryRepo: MemoryRepository,
  tenantId?: string,
): DedupResult {
  const contentHash = computeContentHash(candidate.content);
  const existing =
    tenantId !== undefined
      ? memoryRepo.findByContentHashAndTenant(contentHash, tenantId)
      : memoryRepo.findByContentHash(contentHash);

  if (existing !== null) {
    return {
      isDuplicate: true,
      matchedMemoryId: existing.id,
      matchType: 'exact_hash',
      contentHash,
    };
  }

  return { isDuplicate: false, contentHash };
}
