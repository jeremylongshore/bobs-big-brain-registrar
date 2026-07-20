import { randomUUID } from 'node:crypto';
import {
  computeContentHash,
  assertDisclosureClean,
  DisclosureRejectedError,
} from '@qmd-team-intent-kb/common';
import { PolicyPipeline, type PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import {
  promote,
  detectSupersession,
  DEFAULT_SUPERSESSION_THRESHOLD,
} from '@qmd-team-intent-kb/curator';
import { AuditEvent as AuditEventSchema } from '@qmd-team-intent-kb/schema';
import type { CuratedMemory, Author } from '@qmd-team-intent-kb/schema';
import type {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  MemoryLinksRepository,
} from '@qmd-team-intent-kb/store';
import { badRequest, notFound, unprocessable } from '../errors.js';

/**
 * Title-similarity threshold for supersession — the production default,
 * consumed from the single source in policy-engine's supersession module (the
 * same constant the curator and the govern-decision eval use).
 */
const SUPERSESSION_THRESHOLD = DEFAULT_SUPERSESSION_THRESHOLD;

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
   * `promotedBy` / `promotionReason` name the acting reviewer on the 'promoted'
   * receipt (the agent-review path passes `teamkb-review-agent` + its verdict, so
   * the chain is filterable by the reviewing actor — 014-AT-DECR). Omitted → the
   * batch curator identity, so existing callers are unchanged.
   *
   * @throws 404 if the candidate does not exist.
   * @throws 400 if the candidate belongs to a different tenant than requested.
   * @throws 422 if the content carries a secret/PII (disclosure hard floor), is
   *   already promoted, or policy rejects/flags it.
   */
  promoteCandidate(
    candidateId: string,
    tenantId: string,
    promotedBy?: Author,
    promotionReason?: string,
  ): CuratedMemory {
    const candidate = this.candidateRepo.findById(candidateId);
    if (candidate === null) {
      throw notFound(`Candidate ${candidateId} not found`);
    }
    if (candidate.tenantId !== tenantId) {
      throw badRequest('Candidate does not belong to the requested tenant scope');
    }

    // Deterministic hard floor (014-AT-DECR constraint #1): re-scan for
    // secrets/PII at promotion, independent of whether the tenant has an enabled
    // policy. The intake gate already blocks disclosures at capture, but this
    // makes the promote path unlaunderable on its own — an agent's "promote"
    // verdict can NEVER move a secret into durable memory, policy config or not.
    try {
      assertDisclosureClean(candidate);
    } catch (err) {
      if (err instanceof DisclosureRejectedError) {
        throw unprocessable(
          `Candidate rejected at the promotion disclosure gate — content contains disallowed material. Nothing was promoted.`,
        );
      }
      throw err;
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
        // contradiction_check lookup (E1): reuse the tenant-scoped memory load
        // above — ACTIVE lifecycle only, filtered to the requested category.
        getActiveMemoriesInCategory: (category) =>
          tenantMemories
            .filter((m) => m.lifecycle === 'active' && m.category === category)
            .map((m) => ({ id: m.id, content: m.content })),
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
    // audit event (actor = promotedBy), and applies supersession + wiki-links.
    const supersession = detectSupersession(candidate, this.memoryRepo, SUPERSESSION_THRESHOLD);
    const memory = promote(
      {
        candidate,
        contentHash,
        pipelineResult,
        supersession: supersession ?? undefined,
        promotedBy,
        promotionReason,
      },
      this.memoryRepo,
      this.auditRepo,
      false,
      this.linksRepo,
    );

    // Retire the candidate from the inbox/quarantine queue (jfv.8 status-flip fix).
    // Before this, promote() only inserted the curated memory and never touched
    // the candidates table, so an approved candidate kept its `inbox`/`quarantined`
    // status and re-appeared in `brain_inbox` forever (re-promotion then 422'd on
    // the dedup check). The flip is tenant-scoped; a 0-row result (already retired
    // by a racing sweep) is benign — the memory exists, which is the durable truth.
    this.candidateRepo.updateStatus(candidateId, 'promoted', tenantId);

    return memory;
  }

  /**
   * Retire a reviewed candidate as `rejected` WITHOUT promoting it — the
   * agent-review path's "this is noise, don't keep proposing it" marker (jfv.8 /
   * 014-AT-DECR). A non-destructive status flip (the row survives — `candidates`
   * is Tier-A source of truth, never deleted) plus an on-chain receipt naming the
   * acting reviewer + reason, so every agent decision (promote AND reject) is
   * auditable. Uses the 'deleted' audit action (the curator's rejection semantics:
   * no curated memory was created).
   *
   * @throws 404 if the candidate does not exist.
   * @throws 400 if the candidate belongs to a different tenant than requested.
   */
  rejectCandidate(candidateId: string, tenantId: string, actor: Author, reason: string): void {
    const candidate = this.candidateRepo.findById(candidateId);
    if (candidate === null) {
      throw notFound(`Candidate ${candidateId} not found`);
    }
    if (candidate.tenantId !== tenantId) {
      throw badRequest('Candidate does not belong to the requested tenant scope');
    }

    this.candidateRepo.updateStatus(candidateId, 'rejected', tenantId);
    this.auditRepo.insert(
      AuditEventSchema.parse({
        id: randomUUID(),
        action: 'deleted',
        memoryId: candidate.id,
        tenantId,
        actor,
        reason,
        details: { candidateId: candidate.id, disposition: 'rejected' },
        timestamp: new Date().toISOString(),
      }),
    );
  }
}
