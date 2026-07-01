import type { CandidateRepository } from '@qmd-team-intent-kb/store';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { computeContentHash, scanDisclosureFields } from '@qmd-team-intent-kb/common';
import { badRequest, notFound, unprocessable } from '../errors.js';

/**
 * Service layer for memory candidate intake and retrieval.
 * Validates all inputs with Zod before writing to the repository.
 */
export class CandidateService {
  constructor(private readonly repo: CandidateRepository) {}

  /**
   * Validate and intake a new memory candidate.
   * Computes the content hash and inserts the record.
   *
   * @throws a 400 ApiError on invalid (mis-shaped) input.
   * @throws a 422 ApiError when the content violates the no-compensation /
   *   no-PII disclosure rule — the candidate is rejected before it can enter
   *   the inbox (bead `3iu.1`).
   */
  intake(data: unknown): MemoryCandidate {
    const parsed = MemoryCandidate.safeParse(data);
    if (!parsed.success) {
      throw badRequest(`Invalid candidate: ${parsed.error.message}`);
    }
    const candidate = parsed.data;

    // Disclosure gate: enforce the no-compensation / no-PII / no-secret rule at
    // the boundary so the API returns a clean 422 (the same gate is also enforced
    // at the repository choke point as the real backstop — see
    // CandidateRepository.insert). The matched value is never echoed back
    // (PII non-leak).
    //
    // R10 fix (010-AT-RISK · bead compile-then-govern-e06.3): the early-check
    // scanned only content/title/tags, so a secret or PII hidden in an "odd"
    // metadata field (e.g. an SSN in `metadata.filePaths`, a key in
    // `projectContext`) slipped THIS boundary and only tripped the deeper
    // repository choke point — a worse error surface, and a real leak the moment
    // any path skips that backstop. The govern-decision eval demonstrates the
    // exact filePath leak this closes. We now scan the same free-text metadata
    // surface: filePaths, projectContext, repoUrl, branch, language, sessionId.
    // `category` is enum-constrained (MemoryCategory) so it carries no
    // attacker-controlled free text, but it is scanned too for parity with the
    // R10 spec — a no-op on the closed vocabulary, cheap insurance if the enum
    // ever widens.
    const meta = candidate.metadata;
    const metadataFreeText = [
      ...meta.filePaths,
      ...(meta.projectContext !== undefined ? [meta.projectContext] : []),
      ...(meta.repoUrl !== undefined ? [meta.repoUrl] : []),
      ...(meta.branch !== undefined ? [meta.branch] : []),
      ...(meta.language !== undefined ? [meta.language] : []),
      ...(meta.sessionId !== undefined ? [meta.sessionId] : []),
    ];
    const violation = scanDisclosureFields([
      candidate.content,
      candidate.title,
      candidate.category,
      ...candidate.metadata.tags,
      ...metadataFreeText,
    ]);
    if (violation !== null) {
      const kind =
        violation.category === 'pii'
          ? 'PII'
          : violation.category === 'secret'
            ? 'a credential / secret'
            : 'compensation / comp-split';
      throw unprocessable(
        `Candidate rejected: content contains disallowed ${kind} material and cannot enter the governed brain.`,
      );
    }

    const contentHash = computeContentHash(candidate.content);
    this.repo.insert(candidate, contentHash);
    return candidate;
  }

  /**
   * Retrieve a candidate by its UUID.
   * Throws a 404 ApiError if not found.
   */
  getById(id: string): MemoryCandidate {
    const candidate = this.repo.findById(id);
    if (candidate === null) throw notFound(`Candidate ${id} not found`);
    return candidate;
  }

  /**
   * List candidates, optionally filtered by tenant.
   * When no tenantId is provided, a 400 ApiError is thrown — the API
   * always requires a tenant scope for list operations.
   */
  list(tenantId: string | undefined): MemoryCandidate[] {
    if (tenantId !== undefined && tenantId.length > 0) {
      return this.repo.findByTenant(tenantId);
    }
    throw badRequest('tenantId query parameter is required');
  }

  /**
   * Internal helper — check whether a content hash is already stored.
   * Returns null when no match exists.
   */
  findByHash(hash: string): MemoryCandidate | null {
    return this.repo.findByContentHash(hash);
  }
}
