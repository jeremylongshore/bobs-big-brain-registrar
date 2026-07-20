/**
 * Supersession-receipt labeled eval case (GSB Wave-2, Track E2).
 *
 * A labeled, dataset-style case asserting that a SUPERSEDING candidate — one
 * whose title Jaccard-matches an existing active memory in the same category
 * at or above the supersession threshold — yields the full supersession
 * receipt pairing at admission:
 *
 *   - the old memory flips lifecycle active → superseded with a supersession
 *     link naming its superseder;
 *   - a 'superseded' audit receipt lands on the hash-chained audit log for the old
 *     memory, carrying the new memory id + similarity;
 *   - the 'promoted' receipt for the new memory lands in the SAME transaction
 *     (identical `timestamp`), which is the observable trace of the R9
 *     BEGIN IMMEDIATE atomicity the promoter guarantees;
 *   - the audit hash chain still verifies clean afterwards.
 *
 * ## Why this lives here and not in the govern-decision eval dataset
 *
 * The govern-decision eval (packages/eval-surface/src/govern-decision) is a
 * DETECTION-efficacy eval: its `GovernCase` schema labels sensitive material
 * (sensitiveClass / surface / expectCaughtBy) and its metrics are per-check
 * precision/recall over four detection surfaces. A supersession receipt is a
 * PROMOTION outcome, not a detection verdict — forcing it into that schema
 * would pollute the confusion-matrix scoring with a case no detector should
 * fire on. The labeled-case discipline (stable id, description, expected
 * outcome as data) is kept; the home is the curator suite, next to the
 * promotion path that mints the receipt. The eval-surface package also cannot
 * reach `detectSupersession`/`promote` without a backwards package→app
 * dependency edge.
 */

import { describe, it, expect } from 'vitest';
import {
  createTestDatabase,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { Curator } from '../curator.js';
import type { CuratorDependencies } from '../curator.js';
import { makeCandidate, makeCuratedMemory, TENANT } from './fixtures.js';

/**
 * The labeled case, kept as data (dataset-v1 style) so the assertion reads as
 * a ground-truth label, not an incidental test setup.
 */
const SUPERSESSION_RECEIPT_CASE = {
  id: 'supersession-receipt-01',
  description:
    'A candidate whose title Jaccard-matches an existing active memory in the ' +
    'same category above the threshold supersedes it at admission and yields ' +
    'the supersession receipt atomically with the promotion receipt.',
  existingMemory: {
    title: 'Incident response escalation runbook',
    category: 'convention' as const,
    content: 'Escalate production incidents to the on-call lead within 15 minutes.',
  },
  candidate: {
    title: 'Incident response escalation runbook v2',
    category: 'convention' as const,
    content: 'Escalate production incidents to the on-call lead within 10 minutes, then page.',
  },
  /** Jaccard('incident response escalation runbook', '… v2') = 4/5 = 0.8 ≥ 0.6. */
  expectedOutcome: 'promoted' as const,
  expectSupersedes: true,
  expectReceipts: ['superseded', 'promoted'] as const,
};

describe('labeled eval case: supersession receipt at admission (E2)', () => {
  it(`${SUPERSESSION_RECEIPT_CASE.id} — a superseding candidate yields the supersession receipt`, () => {
    const db = createTestDatabase();
    const deps: CuratorDependencies = {
      candidateRepo: new CandidateRepository(db),
      memoryRepo: new MemoryRepository(db),
      policyRepo: new PolicyRepository(db),
      auditRepo: new AuditRepository(db),
    };

    const old = makeCuratedMemory({
      title: SUPERSESSION_RECEIPT_CASE.existingMemory.title,
      category: SUPERSESSION_RECEIPT_CASE.existingMemory.category,
      content: SUPERSESSION_RECEIPT_CASE.existingMemory.content,
    });
    deps.memoryRepo.insert(old);

    const candidate = makeCandidate({
      title: SUPERSESSION_RECEIPT_CASE.candidate.title,
      category: SUPERSESSION_RECEIPT_CASE.candidate.category,
      content: SUPERSESSION_RECEIPT_CASE.candidate.content,
    });

    const curator = new Curator(deps, { tenantId: TENANT });
    const batch = curator.processBatch([candidate]);

    // The labeled outcome: promoted, superseding the existing memory.
    expect(batch.promoted).toBe(1);
    const result = batch.results[0]!;
    expect(result.outcome).toBe(SUPERSESSION_RECEIPT_CASE.expectedOutcome);
    expect(result.supersedes).toBe(SUPERSESSION_RECEIPT_CASE.expectSupersedes ? old.id : undefined);
    const newMemoryId = result.memoryId!;

    // Old memory flipped active → superseded, linked to its superseder.
    const oldAfter = deps.memoryRepo.findById(old.id);
    expect(oldAfter?.lifecycle).toBe('superseded');
    expect(oldAfter?.supersession?.supersededBy).toBe(newMemoryId);

    // The supersession receipt: a 'superseded' event on the OLD memory naming
    // the new memory, plus the 'promoted' receipt on the NEW memory.
    const supersededEvents = deps.auditRepo
      .findByMemory(old.id)
      .filter((e) => e.action === 'superseded');
    expect(supersededEvents).toHaveLength(1);
    expect(supersededEvents[0]!.details?.newMemoryId).toBe(newMemoryId);

    const promotedEvents = deps.auditRepo
      .findByMemory(newMemoryId)
      .filter((e) => e.action === 'promoted');
    expect(promotedEvents).toHaveLength(1);

    // Atomicity trace: both receipts were written in the SAME transaction with
    // the SAME injected `now` — identical timestamps. (The rollback direction —
    // neither half surviving a crash — is proven in promoter.test.ts.)
    expect(supersededEvents[0]!.timestamp).toBe(promotedEvents[0]!.timestamp);

    // The hash-chained audit log still verifies clean after the supersession pair.
    const verify = verifyAuditChain(deps.auditRepo);
    expect(verify.breaks).toHaveLength(0);
  });
});
