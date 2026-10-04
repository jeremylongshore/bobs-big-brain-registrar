import { computeContentHash } from '@qmd-team-intent-kb/common';
import {
  PolicyPipeline,
  evaluateHoldTriggers,
  unresolvedFlagsAfterRelease,
} from '@qmd-team-intent-kb/policy-engine';
import type { HoldDecision, PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import type { Author, GovernancePolicy, MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  MemoryLinksRepository,
} from '@qmd-team-intent-kb/store';
import type {
  CuratorConfig,
  CurationResult,
  CurationBatchResult,
  SupersessionReport,
} from './types.js';
import { checkDuplicate } from './dedup/dedup-checker.js';
import {
  planSupersession,
  DEFAULT_SUPERSESSION_THRESHOLD,
  DEFAULT_MAX_SUPERSEDES_PER_PROMOTION,
} from './supersession/supersession-detector.js';
import type { SupersessionMatch } from './supersession/supersession-detector.js';
import { promote } from './promotion/promoter.js';
import { reject } from './rejection/rejector.js';
import { checkOriginAttestation } from './origin/origin-gate.js';
import { checkImportExclusion } from './import-exclusion/import-exclusion-gate.js';
import { placeHold } from './hold/hold.js';
import type { PlaceHoldResult } from './hold/hold.js';

/** Default per-run budget of subject-key retirements (see CuratorConfig.maxSupersedesPerRun). */
const DEFAULT_MAX_SUPERSEDES_PER_RUN = 200;

/**
 * A human's release of a held candidate (K6), passed to
 * {@link Curator.processSingle} by `resolveHold` only. The candidate goes
 * through the WHOLE deterministic gate again; the release resolves the audience
 * and secret-scan flags the hold covered and nothing else.
 */
export interface HoldRelease {
  /** The releasing human, recorded as the promoter. */
  promotedBy: Author;
  /** The human's reason, folded into the `promoted` receipt. */
  promotionReason: string;
}

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
 *   5. On rejection: record audit and return outcome
 *   6. On a hold trigger (K6 — an audience or secret question the rules can detect
 *      but not decide): put the candidate on a bounded human-escalation hold
 *   7. On any other flag: record audit and return outcome
 *   8. On approval: plan subject-keyed (then title-fallback) supersession, then promote
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

  /**
   * Set once the hold queue is found full in this run (K6). The cap frees up
   * only when a person resolves a hold, which no run does, so later candidates
   * skip the count: a bulk digestion past the cap stays cheap and fails closed.
   */
  private holdCapReached?: { active: number; max: number };

  /** Subject-key retirements applied so far by this instance (the per-run budget meter). */
  private subjectSupersessionsApplied = 0;

  constructor(
    private readonly deps: CuratorDependencies,
    private readonly config: CuratorConfig,
  ) {}

  /**
   * Process a single candidate through the full governance pipeline.
   *
   * @param existingHashes - Pre-loaded set of content hashes (hoisted from batch).
   *                         When provided, avoids N+1 queries against the store.
   * @param release - Set ONLY by `resolveHold`: a human released this candidate
   *                  from a hold. The gate runs in full; hold triggers are not
   *                  re-applied and no per-candidate reject receipt is written.
   * @returns A CurationResult describing the outcome.
   */
  processSingle(
    candidate: MemoryCandidate,
    existingHashes?: Set<string>,
    release?: HoldRelease,
  ): CurationResult {
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

    // Redacted text must not come back (K3). A governed redaction changes the
    // stored hash, so the exact-hash check above no longer matches the ORIGINAL
    // content; the redaction receipt still records its hash.
    const redaction = this.deps.auditRepo.findRedactionByOldContentHash(
      contentHash,
      this.config.tenantId,
    );
    if (redaction !== null) {
      return {
        candidateId: candidate.id,
        outcome: 'duplicate',
        reason: `Content was removed by a governed redaction (receipt ${redaction.eventId}) — re-ingest refused`,
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
      this.config.dryRun === true ||
      this.config.suppressRejectionReceipts === true ||
      release !== undefined;

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

    // Import exclusion gate (bead 5kw.1) — STRUCTURAL, like the origin gate
    // above: import-source candidates matching the brainignore ruleset
    // (vendored paths, lockfiles, boilerplate names, minified/generated/
    // license-boilerplate content) are rejected deterministically at intake,
    // with the matched pattern/heuristic on the receipted rejection. Non-import
    // sources are never checked. Defaults apply when no ruleset is configured,
    // so no govern path can leave the gate dormant.
    const importGate = checkImportExclusion(candidate, this.config.importExclusions);
    if (importGate.verdict === 'rejected') {
      const reason = reject(
        candidate,
        importGate.pipelineResult,
        this.deps.auditRepo,
        suppressReject,
      );
      return {
        candidateId: candidate.id,
        outcome: 'rejected',
        pipelineResult: importGate.pipelineResult,
        reason,
      };
    }

    const policies = this.deps.policyRepo.findByTenant(this.config.tenantId);
    const policy = policies.find((p) => p.enabled);

    const pipelineResult: PipelineResult =
      policy === undefined
        ? { candidateId: candidate.id, outcome: 'approved', evaluations: [] }
        : this.evaluatePolicy(candidate, policy, existingHashes);

    if (pipelineResult.outcome === 'rejected') {
      const reason = reject(candidate, pipelineResult, this.deps.auditRepo, suppressReject);
      return {
        candidateId: candidate.id,
        outcome: 'rejected',
        pipelineResult,
        reason,
      };
    }

    // Human-escalation hold (K6): an audience or secret question the rules can
    // detect but not decide. Checked with or without a policy (the proposer
    // clearance trigger is structural), and never for a human's release.
    if (release === undefined) {
      const decision = evaluateHoldTriggers(candidate, pipelineResult, policy);
      if (decision !== null) {
        return this.holdCandidate(candidate, decision, pipelineResult, suppressReject);
      }
    }

    // A release resolves the flags the hold covered, and only those.
    const releasedFlags =
      release !== undefined && unresolvedFlagsAfterRelease(pipelineResult).length === 0
        ? (pipelineResult.flaggedBy ?? [])
        : undefined;

    if (pipelineResult.outcome === 'flagged' && releasedFlags === undefined) {
      const reason = reject(candidate, pipelineResult, this.deps.auditRepo, suppressReject);
      return {
        candidateId: candidate.id,
        outcome: 'flagged',
        pipelineResult,
        reason,
      };
    }

    return this.promoteCandidate(candidate, contentHash, pipelineResult, release, releasedFlags);
  }

  /** Run the tenant's policy pipeline over one candidate (tenant-scoped context). */
  private evaluatePolicy(
    candidate: MemoryCandidate,
    policy: GovernancePolicy,
    existingHashes?: Set<string>,
  ): PipelineResult {
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
    return pipeline.evaluate(candidate, {
      existingHashes: hashSet,
      tenantId: this.config.tenantId,
      // contradiction_check lookup (E1): tenant-scoped ACTIVE memories filtered
      // to the requested category AT THE STORE QUERY — loading the whole active
      // set and filtering in JS deserialized a 17k-row corpus per candidate to
      // keep ~6%. Queried lazily — the store is only hit when a contradiction
      // rule actually runs.
      getActiveMemoriesInCategory: (category) =>
        this.deps.memoryRepo
          .findByTenantAndLifecycleAndCategory(this.config.tenantId, 'active', category)
          .map((m) => ({ id: m.id, content: m.content })),
    });
  }

  /**
   * Put a candidate on a human-escalation hold (K6), or report why it could not
   * be held. Either way it is NOT promoted: a full queue or an unholdable row
   * fails closed to `flagged`.
   */
  private holdCandidate(
    candidate: MemoryCandidate,
    decision: HoldDecision,
    pipelineResult: PipelineResult,
    suppressReject: boolean,
  ): CurationResult {
    const placed: PlaceHoldResult =
      this.holdCapReached !== undefined
        ? { status: 'cap_reached', ...this.holdCapReached }
        : placeHold(
            candidate,
            decision,
            {
              candidateRepo: this.deps.candidateRepo,
              memoryRepo: this.deps.memoryRepo,
              auditRepo: this.deps.auditRepo,
            },
            {
              limits: this.config.holdLimits,
              dryRun: this.config.dryRun,
              ...(this.config.now !== undefined ? { now: this.config.now() } : {}),
            },
          );
    if (placed.status === 'cap_reached') {
      this.holdCapReached = { active: placed.active, max: placed.max };
    }
    const triggers = decision.triggers;
    const report = { triggers, recommendedAudience: decision.recommendedAudience };

    if (placed.status === 'cap_reached' || placed.status === 'not_holdable') {
      // Keep the existing flagged receipt when the pipeline itself flagged.
      if (pipelineResult.outcome === 'flagged') {
        reject(candidate, pipelineResult, this.deps.auditRepo, suppressReject);
      }
      const why =
        placed.status === 'cap_reached'
          ? `the hold queue is full (${placed.active}/${placed.max}); resolve open holds and re-run`
          : placed.reason;
      return {
        candidateId: candidate.id,
        outcome: 'flagged',
        pipelineResult,
        hold: { status: placed.status, ...report },
        reason: `Needs human review (${triggers.join(', ')}) but was not held: ${why}. Not promoted.`,
      };
    }

    const expiresAt = placed.status === 'would_hold' ? placed.expiresAt : placed.hold.expiresAt;
    return {
      candidateId: candidate.id,
      outcome: 'held',
      pipelineResult,
      hold: { status: placed.status, ...report, expiresAt },
      reason: `Held for human review until ${expiresAt}: ${triggers.join(', ')}`,
    };
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
    let held = 0;
    let holdCapBlocked = 0;

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
          if (result.hold?.status === 'cap_reached') holdCapBlocked++;
          break;
        case 'duplicate':
          duplicates++;
          break;
        case 'held':
          held++;
          break;
      }
    }

    return {
      processed: candidates.length,
      promoted,
      rejected,
      flagged,
      duplicates,
      held,
      holdCapBlocked,
      results,
    };
  }

  private promoteCandidate(
    candidate: MemoryCandidate,
    contentHash: string,
    pipelineResult: PipelineResult,
    release?: HoldRelease,
    releasedFlags?: readonly string[],
  ): CurationResult {
    const plan = planSupersession(candidate, this.deps.memoryRepo, {
      threshold: this.config.supersessionThreshold ?? DEFAULT_SUPERSESSION_THRESHOLD,
      maxSupersedes: this.config.maxSupersedesPerPromotion ?? DEFAULT_MAX_SUPERSEDES_PER_PROMOTION,
    });

    let toApply: SupersessionMatch[] = plan.matches;
    let report: SupersessionReport | undefined;

    const subjectCount = toApply.filter((m) => m.basis === 'subject').length;
    const runBudget = this.config.maxSupersedesPerRun ?? DEFAULT_MAX_SUPERSEDES_PER_RUN;

    if (plan.blocked !== undefined) {
      report = {
        status: 'blocked',
        wouldSupersede: [],
        blockedReason: `subject match exceeds per-promotion cap (${plan.blocked.cap})`,
        blockedCount: plan.blocked.wouldSupersede,
      };
      toApply = [];
    } else if (this.config.supersessionMode === 'report') {
      if (toApply.length > 0) {
        report = { status: 'report', wouldSupersede: toApply };
      }
      toApply = [];
    } else if (subjectCount > 0 && this.subjectSupersessionsApplied + subjectCount > runBudget) {
      report = {
        status: 'blocked',
        wouldSupersede: [],
        blockedReason: `per-run subject-supersession budget exhausted (${runBudget})`,
        blockedCount: subjectCount,
      };
      toApply = [];
    }

    const memory = promote(
      {
        candidate,
        contentHash,
        pipelineResult,
        supersessions: toApply,
        ...(release !== undefined
          ? { promotedBy: release.promotedBy, promotionReason: release.promotionReason }
          : {}),
        ...(releasedFlags !== undefined ? { humanResolvedFlags: releasedFlags } : {}),
      },
      this.deps.memoryRepo,
      this.deps.auditRepo,
      this.config.dryRun,
      this.deps.linksRepo,
    );

    // Spend the run budget only AFTER the atomic promote() succeeded: a thrown
    // (rolled-back) promotion must not consume budget. Dry-run persists nothing,
    // so it spends none either.
    if (this.config.dryRun !== true) {
      this.subjectSupersessionsApplied += toApply.filter((m) => m.basis === 'subject').length;
    }

    return {
      candidateId: candidate.id,
      outcome: 'promoted',
      memoryId: memory.id,
      supersedes: toApply[0]?.supersededMemoryId,
      ...(toApply.length > 0 ? { supersededIds: toApply.map((m) => m.supersededMemoryId) } : {}),
      ...(report !== undefined ? { supersessionReport: report } : {}),
      pipelineResult,
      reason:
        toApply.length > 0
          ? `Promoted (supersedes ${toApply.map((m) => m.supersededMemoryId).join(', ')})`
          : report?.status === 'blocked'
            ? `Promoted (supersession blocked: ${report.blockedReason})`
            : 'Promoted',
    };
  }
}
