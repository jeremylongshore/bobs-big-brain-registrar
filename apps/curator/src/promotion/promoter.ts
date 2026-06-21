import {
  deriveMemoryId,
  deriveAuditEventId,
  derivePolicyEvaluationId,
  deriveLinkId,
} from '@qmd-team-intent-kb/common';
import {
  CuratedMemory as CuratedMemorySchema,
  AuditEvent as AuditEventSchema,
} from '@qmd-team-intent-kb/schema';
import type { MemoryCandidate, CuratedMemory, PolicyEvaluation } from '@qmd-team-intent-kb/schema';
import type {
  MemoryRepository,
  AuditRepository,
  MemoryLinksRepository,
} from '@qmd-team-intent-kb/store';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import type { SupersessionMatch } from '../supersession/supersession-detector.js';
import { extractWikiLinks } from '../import/wikilink-parser.js';

/** Input bundle for a single promotion operation */
export interface PromotionInput {
  candidate: MemoryCandidate;
  contentHash: string;
  pipelineResult: PipelineResult;
  supersession?: SupersessionMatch;
}

/**
 * Verdict shape an {@link EvalCallback} may return — a structurally-minimal
 * mirror of the eval-surface EvaluatorResult, kept local so the promoter does
 * not take a hard dependency on the eval-surface package (the callback is
 * supplied by the caller, who owns that dependency). Each returned result is
 * written to the append-only audit chain as an `eval-result` event.
 */
export interface EvalResultRecord {
  readonly name: string;
  readonly passed: boolean;
  readonly score: number;
  readonly threshold: number;
  readonly details: Record<string, number | string | boolean>;
}

/**
 * Optional hook invoked after a memory is inserted (non-dry-run only). Returns
 * eval verdicts that are emitted into the audit chain as `eval-result` events —
 * the QMD side of the unification thesis (DR-010 Q3). Emission only: the audit
 * chain SHA-256-chains each row; signing the resulting bundle is a downstream
 * step. A throwing callback is contained — it is logged via a best-effort path
 * and never aborts the promotion (the memory is already safely persisted).
 */
export type EvalCallback = (
  memory: CuratedMemory,
  pipelineResult: PipelineResult,
) => EvalResultRecord[];

/**
 * Promotes a candidate to a CuratedMemory and persists everything to the store.
 *
 * Steps:
 *   1. Convert pipeline evaluations to PolicyEvaluation records
 *   2. Build and validate the CuratedMemory via Zod schema
 *   3. If supersession: update old memory lifecycle to 'superseded' with link,
 *      then emit a 'superseded' audit event for the old memory
 *   4. Insert the new curated memory
 *   5. Emit a 'promoted' audit event for the new memory
 *
 * When dryRun=true all logic runs (including schema validation) but nothing is
 * written to the database.
 *
 * `now` defaults to the current wall-clock instant. Callers that need a
 * cross-clone-reproducible promoted row (the govern-at-merge gate) inject a
 * deterministic, content-derived timestamp here so that the same logical memory
 * yields a byte-identical `promotedAt` / `updatedAt` on every clone. The audit
 * chain's v2 `entry_hash` already excludes the timestamp (bead 8da.6), so the
 * audit outcome is reproducible regardless; injecting `now` extends that
 * reproducibility to the durable `curated_memories` row itself.
 *
 * @returns The fully-formed CuratedMemory (always, even in dry-run mode).
 */
export function promote(
  input: PromotionInput,
  memoryRepo: MemoryRepository,
  auditRepo: AuditRepository,
  dryRun: boolean = false,
  linksRepo?: MemoryLinksRepository,
  evalCallback?: EvalCallback,
  now: string = new Date().toISOString(),
): CuratedMemory {
  // The promoted-memory id is content-derived (UUID v5) from the candidate
  // lineage, not random, so the same logical candidate promotes to the same
  // CuratedMemory.id on every clone. It is intentionally distinct from
  // candidate.id (a "memory"-tagged derivation) but a pure function of the
  // candidate's already content-addressed id plus its content hash, both stable
  // across clones for the same logical event.
  //
  // The audit-event ids and graph-edge (link) ids below are ALSO content-derived
  // (bead 8da.5) from their logical identities, load-bearing for the audit chain,
  // whose v2 entry_hash folds the event id into its canonical body, so a random id
  // would make the entry_hash per-clone even with timestamp excluded (8da.6).
  const memoryId = deriveMemoryId(input.candidate.id, input.contentHash);

  // The pipeline does not carry a per-evaluation policyId, so one is derived per
  // record. It is content-derived (bead 8da.5/8da.9) from (memoryId, ruleId,
  // index), not random: the durable curated_memories row embeds these ids in its
  // policy_evaluations_json column, so a random id made the row per-clone for the
  // same logical promotion, which the govern-at-merge gate's byte-identical
  // commutativity guarantee cannot tolerate. The policyId is never hashed into the
  // audit chain, so deriving it deterministically is a pure improvement.
  const policyEvaluations: PolicyEvaluation[] = input.pipelineResult.evaluations.map(
    (ev, index) => ({
      policyId: derivePolicyEvaluationId(memoryId, ev.ruleId, String(index)),
      ruleId: ev.ruleId,
      result: ev.outcome,
      reason: ev.reason,
      evaluatedAt: now,
    }),
  );

  const memory = CuratedMemorySchema.parse({
    id: memoryId,
    candidateId: input.candidate.id,
    source: input.candidate.source,
    content: input.candidate.content,
    title: input.candidate.title,
    category: input.candidate.category,
    trustLevel: input.candidate.trustLevel,
    sensitivity: 'internal',
    author: input.candidate.author,
    tenantId: input.candidate.tenantId,
    metadata: input.candidate.metadata,
    lifecycle: 'active',
    contentHash: input.contentHash,
    policyEvaluations,
    promotedAt: now,
    promotedBy: { type: 'system', id: 'curator' },
    updatedAt: now,
    version: 1,
  });

  if (!dryRun) {
    if (input.supersession !== undefined) {
      const oldMemory = memoryRepo.findById(input.supersession.supersededMemoryId);
      if (oldMemory !== null) {
        const updatedOld = CuratedMemorySchema.parse({
          ...oldMemory,
          lifecycle: 'superseded',
          supersession: {
            supersededBy: memoryId,
            reason: `Title similarity: ${input.supersession.similarity.toFixed(2)}`,
            linkedAt: now,
          },
          updatedAt: now,
        });
        memoryRepo.update(updatedOld);
      }

      auditRepo.insert(
        AuditEventSchema.parse({
          // Content-derived (bead 8da.5): identity is the superseded memory +
          // the 'superseded' action + the superseding memory id as discriminator,
          // so two clones supersede-by-the-same-memory mint the same audit id and
          // hence the same v2 entry_hash at the same chain position.
          id: deriveAuditEventId(input.supersession.supersededMemoryId, 'superseded', memoryId),
          action: 'superseded',
          memoryId: input.supersession.supersededMemoryId,
          tenantId: input.candidate.tenantId,
          actor: { type: 'system', id: 'curator' },
          reason: `Superseded by ${memoryId}`,
          details: {
            newMemoryId: memoryId,
            similarity: input.supersession.similarity,
          },
          timestamp: now,
        }),
      );
    }

    memoryRepo.insert(memory);

    if (input.supersession !== undefined && linksRepo) {
      linksRepo.insert({
        // Content-derived (bead 8da.5): a graph edge's identity is its
        // (source, target, type) triple, stable across clones for the same
        // logical promotion. Not part of the audit chain, but kept deterministic
        // so the whole promotion is byte-reproducible across clones.
        id: deriveLinkId(memoryId, input.supersession.supersededMemoryId, 'supersedes'),
        sourceMemoryId: memoryId,
        targetMemoryId: input.supersession.supersededMemoryId,
        linkType: 'supersedes',
        weight: input.supersession.similarity,
        createdBy: 'curator',
        source: 'curator',
        importBatchId: null,
        createdAt: now,
      });
    }

    // Extract wiki-links from content and create relates_to edges
    if (linksRepo) {
      const wikiLinks = extractWikiLinks(input.candidate.content);
      for (const wl of wikiLinks) {
        const targets = memoryRepo.searchByText(wl.slug);
        const match = targets.find(
          (m) => m.title.toLowerCase() === wl.slug.toLowerCase() && m.id !== memoryId,
        );
        if (match) {
          try {
            linksRepo.insert({
              // Content-derived (bead 8da.5): (source, target, type) edge identity,
              // stable across clones. See the supersedes edge above.
              id: deriveLinkId(memoryId, match.id, 'relates_to'),
              sourceMemoryId: memoryId,
              targetMemoryId: match.id,
              linkType: 'relates_to',
              weight: 1.0,
              createdBy: 'curator',
              source: 'curator',
              importBatchId: null,
              createdAt: now,
            });
          } catch {
            // Unique constraint violation — link already exists, skip
          }
        }
      }
    }

    auditRepo.insert(
      AuditEventSchema.parse({
        // Content-derived (bead 8da.5): one 'promoted' event per memory, so the
        // (memoryId, action) pair is already unique, so no discriminator needed.
        id: deriveAuditEventId(memoryId, 'promoted'),
        action: 'promoted',
        memoryId,
        tenantId: input.candidate.tenantId,
        actor: { type: 'system', id: 'curator' },
        reason: 'Passed all governance rules',
        details: { candidateId: input.candidate.id },
        timestamp: now,
      }),
    );

    // Evidence emission (DR-010 Q3 unification thesis): if an eval callback is
    // supplied, run it and write each verdict as an `eval-result` audit event.
    // The audit chain SHA-256-chains these rows, making them tamper-evident and
    // signable downstream. Contained by design — a throwing/faulty callback must
    // NOT abort a promotion whose memory is already persisted; failures are
    // swallowed here (the memory + 'promoted' event stand regardless).
    if (evalCallback !== undefined) {
      try {
        for (const verdict of evalCallback(memory, input.pipelineResult)) {
          auditRepo.insert(
            AuditEventSchema.parse({
              // Content-derived (bead 8da.5): several eval-result rows can be
              // emitted per promotion, so the evaluator name discriminates them.
              // Identical evaluator verdicts on two clones mint the same id.
              id: deriveAuditEventId(memoryId, 'eval-result', verdict.name),
              action: 'eval-result',
              memoryId,
              tenantId: input.candidate.tenantId,
              actor: { type: 'system', id: 'curator' },
              reason: `eval ${verdict.name}: ${verdict.passed ? 'pass' : 'fail'}`,
              details: {
                evaluator: verdict.name,
                passed: verdict.passed,
                score: verdict.score,
                threshold: verdict.threshold,
                ...verdict.details,
              },
              timestamp: now,
            }),
          );
        }
      } catch {
        // Eval emission is best-effort; the promotion itself has already
        // succeeded. Do not let an eval-surface fault corrupt the curation path.
      }
    }
  }

  return memory;
}
