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
import { detectSupersession } from './supersession/supersession-detector.js';
import { promote } from './promotion/promoter.js';
import { reject } from './rejection/rejector.js';

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
    // Tenant-scoped existing-hash set (B1) — mirrors the API promotion-service so
    // the policy dedup rule sees only this tenant's memories.
    const hashSet =
      existingHashes ??
      new Set(this.deps.memoryRepo.getContentHashesByTenant(this.config.tenantId));
    const pipelineResult = pipeline.evaluate(candidate, {
      existingHashes: hashSet,
      tenantId: this.config.tenantId,
    });

    // Suppress the per-candidate reject receipt when configured (B1 sweep) — the
    // outcome still returns, only the audit write is skipped (see
    // CuratorConfig.suppressRejectionReceipts). `dryRun` also suppresses it.
    const suppressReject =
      this.config.dryRun === true || this.config.suppressRejectionReceipts === true;

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
      this.config.supersessionThreshold ?? 0.6,
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
