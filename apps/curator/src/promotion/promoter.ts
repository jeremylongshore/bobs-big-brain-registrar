import { randomUUID } from 'node:crypto';
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
 * @returns The fully-formed CuratedMemory (always, even in dry-run mode).
 */
export function promote(
  input: PromotionInput,
  memoryRepo: MemoryRepository,
  auditRepo: AuditRepository,
  dryRun: boolean = false,
  linksRepo?: MemoryLinksRepository,
  evalCallback?: EvalCallback,
): CuratedMemory {
  const now = new Date().toISOString();
  const memoryId = randomUUID();

  // The pipeline does not carry a per-evaluation policyId, so one is generated per record.
  const policyEvaluations: PolicyEvaluation[] = input.pipelineResult.evaluations.map((ev) => ({
    policyId: randomUUID(),
    ruleId: ev.ruleId,
    result: ev.outcome,
    reason: ev.reason,
    evaluatedAt: now,
  }));

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
          id: randomUUID(),
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
        id: randomUUID(),
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
              id: randomUUID(),
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
        id: randomUUID(),
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
              id: randomUUID(),
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
