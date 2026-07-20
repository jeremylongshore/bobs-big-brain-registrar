import { computeContentHash } from '@qmd-team-intent-kb/common';
import { PolicyPipeline } from '@qmd-team-intent-kb/policy-engine';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  MemoryLinksRepository,
} from '@qmd-team-intent-kb/store';
import type { CuratorConfig, CurationResult, CurationBatchResult } from './types.js';
import { checkDuplicate } from './dedup/dedup-checker.js';
import {
  detectSupersession,
  DEFAULT_SUPERSESSION_THRESHOLD,
} from './supersession/supersession-detector.js';
import { promote } from './promotion/promoter.js';
import { reject } from './rejection/rejector.js';
import { checkOriginAttestation } from './origin/origin-gate.js';

/** Repository dependencies required by the Curator */
export interface CuratorDependencies {
  candidateRepo: CandidateRepository;
  memoryRepo: MemoryRepository;
  policyRepo: PolicyRepository;
  auditRepo: AuditRepository;
  linksRepo?: MemoryLinksRepository;
}

/**
 * Orchestrates the full curation pipeline for memory candidates.
 *
 * Pipeline steps (per candidate):
 *   1. Compute SHA-256 content hash
 *   2. Exact-hash duplicate check against curated memories
 *   3. Load the first enabled governance policy for the tenant
 *   4. Run policy pipeline (secret detection, length, trust, relevance, dedup, tenant match)
 *   5. On rejection/flagging: record audit and return outcome
 *   6. On approval: detect title-similarity supersession, then promote
 *
 * All operations are synchronous. Only `ingestFromSpool` (file I/O) is async.
 */
export class Curator {
  /**
   * Policy ids already warned about for dormant rules (5bm.2), so the runtime
   * completeness check fires ONCE per policy rather than per candidate — a
   * digestion batch must not emit 17k identical warnings.
   */
  private readonly warnedDormantPolicies = new Set<string>();

  constructor(
    private readonly deps: CuratorDependencies,
    private readonly config: CuratorConfig,
  ) {}

  /**
   * Process a single candidate through the full governance pipeline.
   *
   * @param existingHashes - Pre-loaded set of content hashes (hoisted from batch).
   *                         When provided, avoids N+1 queries against the store.
   * @returns A CurationResult describing the outcome.
   */
  processSingle(candidate: MemoryCandidate, existingHashes?: Set<string>): CurationResult {
    const contentHash = computeContentHash(candidate.content);

    // Tenant-scoped dedup (B1): never treat another tenant's memory as a duplicate.
    const dedup = checkDuplicate(candidate, this.deps.memoryRepo, this.config.tenantId);
    if (dedup.isDuplicate) {
      return {
        candidateId: candidate.id,
        outcome: 'duplicate',
        reason: `Exact duplicate of memory ${dedup.matchedMemoryId}`,
      };
    }

    if (existingHashes?.has(contentHash)) {
      return {
        candidateId: candidate.id,
        outcome: 'duplicate',
        reason: 'Intra-batch duplicate (same content already promoted in this batch)',
      };
    }

    // Suppress the per-candidate reject receipt when configured (B1 sweep) — the
    // outcome still returns, only the audit write is skipped (see
    // CuratorConfig.suppressRejectionReceipts). `dryRun` also suppresses it.
    const suppressReject =
      this.config.dryRun === true || this.config.suppressRejectionReceipts === true;

    // Write-time provenance gate (GSB Wave-2 H1) — STRUCTURAL, before the
    // configurable policy pipeline, so a candidate claiming an origin that does
    // not verify against this installation's secret can never reach promotion
    // regardless of tenant policy. Unattested candidates (no `origin`) pass
    // through for backward compatibility; their promotion receipt records
    // channel `unattested` (H2). Rejections reuse the receipted rejection path.
    const originGate = checkOriginAttestation(candidate, this.config.originSecret);
    if (originGate.verdict === 'rejected') {
      const reason = reject(
        candidate,
        originGate.pipelineResult,
        this.deps.auditRepo,
        suppressReject,
      );
      return {
        candidateId: candidate.id,
        outcome: 'rejected',
        pipelineResult: originGate.pipelineResult,
        reason,
      };
    }

    const policies = this.deps.policyRepo.findByTenant(this.config.tenantId);
    const policy = policies.find((p) => p.enabled);

    if (policy === undefined) {
      return this.promoteCandidate(candidate, contentHash, {
        candidateId: candidate.id,
        outcome: 'approved',
        evaluations: [],
      });
    }

    const pipeline = new PolicyPipeline(policy);
    // Runtime completeness check (5bm.2): fire the anti-dormancy gate against the
    // LIVE policy, not only in CI. Warn (never throw — a throw here would refuse
    // to govern on a dormant policy and stall the whole brain) once per policy so
    // an operator sees which registered rules gate nothing on the running store.
    if (pipeline.dormantRuleTypes.length > 0 && !this.warnedDormantPolicies.has(policy.id)) {
      this.warnedDormantPolicies.add(policy.id);
      console.warn(
        `[curator] governance policy "${policy.name}" (${policy.id}) leaves ` +
          `${pipeline.dormantRuleTypes.length} registered rule(s) dormant: ` +
          `${pipeline.dormantRuleTypes.join(', ')}. They gate nothing on this store. ` +
          `See buildRecommendedPolicy / bead qmd-team-intent-kb-5bm.10.`,
      );
    }
    // Tenant-scoped existing-hash set (B1) — mirrors the API promotion-service so
    // the policy dedup rule sees only this tenant's memories.
    const hashSet =
      existingHashes ??
      new Set(this.deps.memoryRepo.getContentHashesByTenant(this.config.tenantId));
    const pipelineResult = pipeline.evaluate(candidate, {
      existingHashes: hashSet,
      tenantId: this.config.tenantId,
      // contradiction_check lookup (E1): tenant-scoped ACTIVE memories filtered
      // to the requested category. Queried lazily — the store is only hit when
      // a contradiction rule actually runs.
      getActiveMemoriesInCategory: (category) =>
        this.deps.memoryRepo
          .findByTenantAndLifecycle(this.config.tenantId, 'active')
          .filter((m) => m.category === category)
          .map((m) => ({ id: m.id, content: m.content })),
    });

    if (pipelineResult.outcome === 'rejected') {
      const reason = reject(candidate, pipelineResult, this.deps.auditRepo, suppressReject);
      return {
        candidateId: candidate.id,
        outcome: 'rejected',
        pipelineResult,
        reason,
      };
    }

    if (pipelineResult.outcome === 'flagged') {
      const reason = reject(candidate, pipelineResult, this.deps.auditRepo, suppressReject);
      return {
        candidateId: candidate.id,
        outcome: 'flagged',
        pipelineResult,
        reason,
      };
    }

    return this.promoteCandidate(candidate, contentHash, pipelineResult);
  }

  /**
   * Process a batch of candidates through the pipeline.
   *
   * Content hashes are loaded once before the loop (not per-candidate) to avoid
   * N+1 queries. The hash set is updated after each promotion to catch intra-batch
   * duplicates.
   */
  processBatch(candidates: MemoryCandidate[]): CurationBatchResult {
    const results: CurationResult[] = [];
    let promoted = 0;
    let rejected = 0;
    let flagged = 0;
    let duplicates = 0;

    // Tenant-scoped (B1): the batch's pre-existing-hash set is this tenant's only.
    const existingHashes = new Set(
      this.deps.memoryRepo.getContentHashesByTenant(this.config.tenantId),
    );

    for (const candidate of candidates) {
      const result = this.processSingle(candidate, existingHashes);
      results.push(result);

      switch (result.outcome) {
        case 'promoted':
          promoted++;
          existingHashes.add(computeContentHash(candidate.content));
          break;
        case 'rejected':
          rejected++;
          break;
        case 'flagged':
          flagged++;
          break;
        case 'duplicate':
          duplicates++;
          break;
      }
    }

    return {
      processed: candidates.length,
      promoted,
      rejected,
      flagged,
      duplicates,
      results,
    };
  }

  private promoteCandidate(
    candidate: MemoryCandidate,
    contentHash: string,
    pipelineResult: PipelineResult,
  ): CurationResult {
    const supersession = detectSupersession(
      candidate,
      this.deps.memoryRepo,
      this.config.supersessionThreshold ?? DEFAULT_SUPERSESSION_THRESHOLD,
    );

    const memory = promote(
      {
        candidate,
        contentHash,
        pipelineResult,
        supersession: supersession ?? undefined,
      },
      this.deps.memoryRepo,
      this.deps.auditRepo,
      this.config.dryRun,
      this.deps.linksRepo,
    );

    return {
      candidateId: candidate.id,
      outcome: 'promoted',
      memoryId: memory.id,
      supersedes: supersession?.supersededMemoryId,
      pipelineResult,
      reason:
        supersession !== null
          ? `Promoted (supersedes ${supersession.supersededMemoryId})`
          : 'Promoted',
    };
  }
}
