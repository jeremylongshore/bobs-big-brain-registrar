import {
  assertDisclosureClean,
  computeContentHash,
  DisclosureRejectedError,
} from '@qmd-team-intent-kb/common';
import { PolicyPipeline } from '@qmd-team-intent-kb/policy-engine';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import { MemoryCandidate as MemoryCandidateSchema } from '@qmd-team-intent-kb/schema';
import type { CuratedMemory, GovernancePolicy, MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type {
  AuditRepository,
  MemoryLinksRepository,
  MemoryRepository,
} from '@qmd-team-intent-kb/store';
import { promote } from '../promotion/promoter.js';

/**
 * Govern-at-merge gate (EPIC 1, bead compile-then-govern-8da.9).
 *
 * ## What this closes
 *
 * Two clones of the governed brain can each promote rows independently. If their
 * branches are reconciled by a content-level merge (e.g. Dolt's native row
 * union), a row that one clone *rejected* at its governance gate can re-enter the
 * merged DB through the *other* clone's branch without being re-governed. The
 * EPIC 1 spike demonstrated exactly this: a secret-bearing row admitted by a
 * native union because the union operator does not re-run policy.
 *
 * The fix is **re-derivation over the union**: take the UNION of two clones'
 * promoted rows and re-govern EVERY row as if it had never been trusted, by
 * re-running the *existing* governance gate - the disclosure / secret choke
 * point, then the full policy pipeline (dedupe, secret-detection, sensitivity,
 * length, source-trust, tenant-match, ...). Anything that fails is QUARANTINED,
 * never admitted. Survivors are promoted through the canonical {@link promote}
 * path, so the merged state is indistinguishable from one assembled by feeding
 * every row through the front door.
 *
 * ## Why it reuses, and does not reinvent
 *
 * The gate writes NO new governance primitive. It reuses, in sequence:
 *
 *   - {@link assertDisclosureClean} - the fail-closed PII / secret / comp choke
 *     point already enforced at `CandidateRepository.insert()`.
 *   - {@link PolicyPipeline} - the full ordered rule set, including the
 *     content-hash `dedup_check` rule, fed an accreting `existingHashes` set.
 *   - {@link promote} - the canonical promotion path (content-derived ids,
 *     deterministic audit-chain append).
 *
 * The ONLY new discipline is the **sort-by-id traversal** of the union: ids are
 * content-derived UUID v5s, so identical content sorts to an identical position,
 * which makes the accreting `existingHashes` set accumulate in the same order on
 * every clone - the keystone of the commutativity guarantee below.
 *
 * ## Commutativity guarantee
 *
 * `mergeGovern(A, B, ...)` and `mergeGovern(B, A, ...)` produce BYTE-IDENTICAL
 * governed state and an identical audit outcome, because every step is symmetric
 * in its inputs:
 *
 *   - id-dedup of the union is a set operation (order-independent);
 *   - the union is sorted by content-derived id before processing, so the
 *     traversal order - and therefore the order in which `existingHashes`
 *     accretes - is identical regardless of which clone's rows arrived first;
 *   - {@link assertDisclosureClean} is a pure function of content;
 *   - {@link PolicyPipeline.evaluate} is deterministic given the same
 *     `existingHashes`;
 *   - {@link promote} derives the memory id, audit-event id, and (via injected
 *     `now`) the promoted-row timestamps from content-stable inputs only.
 *
 * @module merge/merge-gate
 */

/** Why a row was turned away at the merge gate. Mirrors the governance gate's
 *  two failure surfaces: the disclosure choke point and the policy pipeline. */
export type QuarantineCategory = 'disclosure' | 'policy';

/**
 * A row refused at the merge gate. Carries the row's content-derived id, the
 * category that turned it away, and a human-readable reason - but NEVER the
 * matched secret/PII value (the disclosure error itself carries only a category,
 * never the value, so re-leaking is structurally impossible here).
 */
export interface QuarantinedRow {
  /** The quarantined source memory's id (content-derived, stable across clones). */
  readonly memoryId: string;
  /** Which gate refused it. */
  readonly category: QuarantineCategory;
  /** Human-readable reason - the disclosure category, or the rejecting rule id. */
  readonly reason: string;
}

/** Outcome of a govern-at-merge pass. */
export interface MergeGovernResult {
  /** The promoted survivors, in the deterministic order they were written. */
  readonly promoted: CuratedMemory[];
  /** Rows refused at the disclosure choke point or the policy pipeline. */
  readonly quarantined: QuarantinedRow[];
  /**
   * The number of logical memories in the union after content-id de-dup. Equals
   * `promoted.length + quarantined.length + dedupedAcrossClones`, where the last
   * term is the count of rows dropped because an identical-id twin was already
   * processed (the same logical memory present in both clones).
   */
  readonly unionSize: number;
}

/** Dependencies the merge gate needs - the same repositories the curator uses. */
export interface MergeGovernDependencies {
  readonly memoryRepo: MemoryRepository;
  readonly auditRepo: AuditRepository;
  readonly linksRepo?: MemoryLinksRepository;
}

/** Options for a merge-gate pass. */
export interface MergeGovernOptions {
  /**
   * The governance policy to re-run every union row against. When omitted, only
   * the disclosure choke point + content-id de-dup apply (matching the curator's
   * "no enabled policy" branch, which still promotes through {@link promote}).
   */
  readonly policy?: GovernancePolicy;
  /** Tenant scope for the pipeline's `tenant_match` rule and audit events. */
  readonly tenantId: string;
  /**
   * When true, run the full gate (validation, dedupe, audit-event construction)
   * but write nothing. Used to preview a merge before committing it.
   */
  readonly dryRun?: boolean;
}

/**
 * Re-project a promoted {@link CuratedMemory} back to a {@link MemoryCandidate}
 * and downgrade it to `untrusted`, so the merge gate re-governs it from a
 * clean slate. The governance metadata that promotion *adds* (`lifecycle`,
 * `policyEvaluations`, `promotedAt`, `promotedBy`, `supersession`, `version`,
 * `sensitivity`, the derived `id`) is stripped - only the source content and
 * provenance survive into the re-derivation.
 *
 * `trustLevel` is forced to `untrusted` so the `source_trust` rule evaluates the
 * row as if it had no prior standing - the merge gate trusts NOTHING that came
 * across a clone boundary.
 *
 * The candidate id is preserved as the source memory's `candidateId` so the
 * re-promotion derives the SAME memory id (`deriveMemoryId(candidateId,
 * contentHash)`) - the merge is idempotent: re-governing an already-clean row
 * reproduces its original id.
 */
function projectToUntrustedCandidate(memory: CuratedMemory): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    id: memory.candidateId,
    status: 'inbox',
    source: memory.source,
    content: memory.content,
    title: memory.title,
    category: memory.category,
    trustLevel: 'untrusted',
    author: memory.author,
    tenantId: memory.tenantId,
    metadata: memory.metadata,
    prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
    capturedAt: memory.promotedAt,
  });
}

/**
 * Base instant for the deterministic merge clock. Promotion writes `promotedAt` /
 * `updatedAt` into the durable `curated_memories` row and `timestamp` onto each
 * audit event; sourcing them from `new Date()` would make the merged DB differ
 * run-to-run and clone-to-clone, breaking byte-identical commutativity. Instead
 * the merge clock is a pure function of the row's position in the deterministic
 * union traversal.
 */
const MERGE_EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Deterministic, strictly-monotonic merge timestamp for the row at `index` in the
 * id-sorted union traversal. Two properties are load-bearing:
 *
 *   1. **Cross-clone identical** - the union is sorted by content-derived id, so a
 *      given logical memory lands at the same `index` on every clone, hence gets
 *      the same timestamp. This is what makes the promoted `curated_memories` row
 *      byte-identical between A∪B and B∪A.
 *   2. **Monotonic with insertion order** - the audit chain's `prev_entry_hash`
 *      links rows in insertion order, and `verifyAuditChain` re-walks them ordered
 *      by `(timestamp ASC, id ASC)`. A single constant timestamp would force the
 *      verifier onto its `id` tiebreaker (the audit-event id, which is NOT the
 *      traversal order), so the re-walked chain would not match the insertion
 *      links and the verifier would (correctly) report a break. A per-row
 *      increasing timestamp keeps the chronological walk aligned with insertion
 *      order, so the chain verifies clean.
 *
 * The audit chain's v2 `entry_hash` excludes `timestamp` from its body (bead
 * 8da.6), so this deterministic clock does not perturb the entry_hash itself -
 * the same logical event still hashes identically across clones.
 */
function mergeClock(index: number): string {
  return new Date(MERGE_EPOCH_MS + index).toISOString();
}

/**
 * Run the govern-at-merge gate over the UNION of two clones' promoted rows.
 *
 * Every row is re-governed as UNTRUSTED: the disclosure / secret choke point runs
 * first, then the full policy pipeline with an accreting content-hash dedupe set.
 * Survivors are promoted through the canonical path; failures are quarantined.
 *
 * Commutative by construction: `mergeGovern(cloneA, cloneB, ...)` and
 * `mergeGovern(cloneB, cloneA, ...)` produce byte-identical governed state and an
 * identical audit outcome (see the module doc-comment for the proof sketch).
 *
 * @param cloneA  Promoted (active) rows exported from clone A.
 * @param cloneB  Promoted (active) rows exported from clone B.
 * @param deps    The store repositories to write survivors + audit events into.
 * @param options Policy, tenant scope, and dry-run flag.
 */
export function mergeGovern(
  cloneA: readonly CuratedMemory[],
  cloneB: readonly CuratedMemory[],
  deps: MergeGovernDependencies,
  options: MergeGovernOptions,
): MergeGovernResult {
  const dryRun = options.dryRun ?? false;

  // 1. UNION + id-dedup. Content-derived ids are stable across clones, so two
  //    rows sharing an id are the same logical memory - keep the first seen.
  //    This is a pure set operation: symmetric in (cloneA, cloneB).
  const unionById = new Map<string, CuratedMemory>();
  for (const memory of [...cloneA, ...cloneB]) {
    if (!unionById.has(memory.id)) {
      unionById.set(memory.id, memory);
    }
  }

  // 2. DETERMINISTIC TRAVERSAL. Sort the unique union by content-derived id so
  //    the accreting `existingHashes` set accumulates in the SAME order on every
  //    clone, regardless of which clone's rows arrived first. This sort is the
  //    one element that makes A∪B and B∪A byte-identical.
  const union = [...unionById.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 3. SEED the dedupe set from the merged DB's existing content hashes (the same
  //    call the eval harness uses), then accrete each newly-promoted row's hash.
  const existingHashes = new Set<string>(deps.memoryRepo.getAllContentHashes());

  const pipeline = options.policy !== undefined ? new PolicyPipeline(options.policy) : undefined;

  const promoted: CuratedMemory[] = [];
  const quarantined: QuarantinedRow[] = [];

  for (let index = 0; index < union.length; index++) {
    const memory = union[index]!;
    const candidate = projectToUntrustedCandidate(memory);
    const contentHash = computeContentHash(candidate.content);

    // 3a. DISCLOSURE / SECRET CHOKE POINT - fail-closed, runs before the pipeline.
    //     A secret- or PII-bearing row that slipped into one clone is turned away
    //     here, never admitted to the merged DB.
    try {
      assertDisclosureClean(candidate);
    } catch (err) {
      if (err instanceof DisclosureRejectedError) {
        quarantined.push({
          memoryId: memory.id,
          category: 'disclosure',
          reason: err.category,
        });
        continue;
      }
      throw err;
    }

    // 3b. FULL POLICY PIPELINE with the accreting dedupe set. A duplicate (same
    //     content hash already present, or already promoted earlier in this pass)
    //     is rejected by the dedup_check rule; a secret/policy violation by its
    //     rule. Either way: quarantine, never write.
    let pipelineResult: PipelineResult | undefined;
    if (pipeline !== undefined) {
      pipelineResult = pipeline.evaluate(candidate, {
        existingHashes,
        tenantId: options.tenantId,
      });
      if (pipelineResult.outcome !== 'approved') {
        quarantined.push({
          memoryId: memory.id,
          category: 'policy',
          reason: pipelineResult.rejectedBy ?? pipelineResult.flaggedBy?.join(', ') ?? 'flagged',
        });
        continue;
      }
    } else {
      // No policy: still run a bare dedupe so the no-policy merge path does not
      // admit two identical-content rows. Mirrors the curator's intra-batch guard.
      if (existingHashes.has(contentHash)) {
        quarantined.push({
          memoryId: memory.id,
          category: 'policy',
          reason: 'duplicate-content',
        });
        continue;
      }
      pipelineResult = { candidateId: candidate.id, outcome: 'approved', evaluations: [] };
    }

    // 4. WRITE SURVIVOR through the canonical promotion path, with a deterministic
    //    clock so the durable row is byte-identical across clones. No supersession
    //    detection or wiki-link edges in the merge path - the union is a re-govern,
    //    not a fresh authoring event, so linksRepo is intentionally NOT passed.
    const memoryRow = promote(
      { candidate, contentHash, pipelineResult },
      deps.memoryRepo,
      deps.auditRepo,
      dryRun,
      undefined,
      undefined,
      mergeClock(index),
    );
    promoted.push(memoryRow);

    // 5. ACCRETE the dedupe set so a later identical-content row in this same pass
    //    is caught. Done after the write so the order is deterministic.
    existingHashes.add(contentHash);
  }

  return { promoted, quarantined, unionSize: union.length };
}
