import { computeContentHash } from '@qmd-team-intent-kb/common';
import { PolicyPipeline, type PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import { promote, detectSupersession } from '@qmd-team-intent-kb/curator';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import type {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  MemoryLinksRepository,
} from '@qmd-team-intent-kb/store';
import { badRequest, notFound, unprocessable } from '../errors.js';

/** Title-similarity threshold for supersession, matching the curator default. */
const SUPERSESSION_THRESHOLD = 0.6;

/**
 * Promotes an inbox candidate to a governed memory in one shot (bead `3iu.2`).
 *
 * Closes the brain-stack-audit Gap 1: candidates and memories are separate
 * stores, and the lifecycle/transition machine only operates on already-governed
 * memories — so without this an admin had to re-import a proposal by hand. This
 * service runs the SAME governance path the curator batch pipeline runs (dedup →
 * policy → `promote()`), so an admin promoting one candidate gets identical
 * dedup, policy evaluation, audit events, supersession, and wiki-linking.
 *
 * A candidate that policy rejects or flags is left untouched in the inbox (a 422
 * is returned) so the admin can fix the policy and retry — it is NOT marked
 * rejected the way the batch path does.
 */
export class PromotionService {
  constructor(
    private readonly candidateRepo: CandidateRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly policyRepo: PolicyRepository,
    private readonly auditRepo: AuditRepository,
    private readonly linksRepo?: MemoryLinksRepository,
  ) {}

  /**
   * Promote the candidate identified by `candidateId` (scoped to `tenantId`) to
   * a curated memory, returning the new memory.
   *
   * @throws 404 if the candidate does not exist.
   * @throws 400 if the candidate belongs to a different tenant than requested.
   * @throws 422 if the content is already promoted, or policy rejects/flags it.
   */
  promoteCandidate(candidateId: string, tenantId: string): CuratedMemory {
    const candidate = this.candidateRepo.findById(candidateId);
    if (candidate === null) {
      throw notFound(`Candidate ${candidateId} not found`);
    }
    if (candidate.tenantId !== tenantId) {
      throw badRequest('Candidate does not belong to the requested tenant scope');
    }

    const contentHash = computeContentHash(candidate.content);

    // Tenant-scoped governed memories — load once and use for BOTH the dedup
    // check and the policy's existing-hash set. Dedup must NOT cross tenant
    // boundaries: a global hash lookup would let tenant A's candidate be blocked
    // as a "duplicate" of tenant B's memory, leaking cross-tenant state.
    const tenantMemories = this.memoryRepo.findByTenant(tenantId);

    const duplicate = tenantMemories.find((m) => m.contentHash === contentHash);
    if (duplicate !== undefined) {
      throw unprocessable(`Candidate already promoted — content matches memory ${duplicate.id}`);
    }

    // Run the tenant's enabled policy (or auto-approve when none), exactly as the
    // curator batch pipeline does — but with a tenant-scoped existing-hash set.
    const policy = this.policyRepo.findByTenant(tenantId).find((p) => p.enabled);
    let pipelineResult: PipelineResult;
    if (policy === undefined) {
      pipelineResult = { candidateId: candidate.id, outcome: 'approved', evaluations: [] };
    } else {
      const pipeline = new PolicyPipeline(policy);
      pipelineResult = pipeline.evaluate(candidate, {
        existingHashes: new Set(tenantMemories.map((m) => m.contentHash)),
        tenantId,
      });
    }

    if (pipelineResult.outcome === 'rejected') {
      const rule = pipelineResult.rejectedBy;
      throw unprocessable(
        `Candidate rejected by policy${rule ? ` rule '${rule}'` : ''} — left in the inbox for review.`,
      );
    }
    if (pipelineResult.outcome === 'flagged') {
      const flags = pipelineResult.flaggedBy ?? [];
      throw unprocessable(
        `Candidate flagged for manual review${flags.length > 0 ? ` (${flags.join(', ')})` : ''} — left in the inbox.`,
      );
    }

    // Approved → promote atomically: inserts the memory, writes the 'promoted'
    // audit event, and applies supersession + wiki-links when applicable.
    const supersession = detectSupersession(candidate, this.memoryRepo, SUPERSESSION_THRESHOLD);
    return promote(
      { candidate, contentHash, pipelineResult, supersession: supersession ?? undefined },
      this.memoryRepo,
      this.auditRepo,
      false,
      this.linksRepo,
    );
  }
}
