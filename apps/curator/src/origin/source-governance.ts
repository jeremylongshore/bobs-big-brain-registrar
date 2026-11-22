import { readSourceControlInput } from './source-control-read.js';
import { readStoredSourceRegistry } from './source-enrollment.js';
import { withVerifiedSourceAdmission } from './source-admission.js';
import type Database from 'better-sqlite3';
import { AuditEvent } from '@qmd-team-intent-kb/schema';
import { curateSourceCandidate } from './source-governance-curation.js';
import { PROVENANCE_FLOOR_ACTOR } from '../recovery/provenance-sensitivity-constraint.js';
import { resolveCandidateMinimumSensitivity } from '../recovery/sensitivity-constraint.js';
import {
  classificationHash,
  MAX_SOURCE_CLASSIFICATION_BYTES,
} from './source-classification-codec.js';
import { SourceClassificationReceiver } from './source-classification-schema.js';
import { verifySourceClassification } from './source-classification.js';
import { recordProvenanceFloorInTransaction } from './source-floor-writer.js';
import {
  prepareSourceGovernance,
  requireSourceGovernanceChain,
  sourceGovernanceDigest,
  sourceGovernanceRepositories,
} from './source-governance-prepare.js';
import {
  SourceGovernancePlan,
  SourceGovernanceSettlement,
  type SourceGovernanceContext,
} from './source-governance-schema.js';
import {
  readSourceSettlement,
  requireSourceEvent,
  requireSourceRows,
  sourceSettlementId,
  tightenSourceAliases,
} from './source-governance-state.js';

function requireScope(
  plan: SourceGovernancePlan,
  receiver: ReturnType<typeof SourceClassificationReceiver.parse>,
) {
  if (
    plan.tenantId !== receiver.tenantId ||
    plan.receiverId !== receiver.receiverId ||
    plan.ingressId !== receiver.ingressId
  )
    throw new Error('Source governance receiver mismatch');
}
/** Read-only restriction/policy preview. Other structural/hold/dedup gates still
 * run at apply; policyOutcome is not a promise that promotion will occur.
 */
export function previewSourceGovernance(
  candidateId: string,
  serialized: string,
  db: Database.Database,
  context: SourceGovernanceContext,
): SourceGovernancePlan {
  if (db.inTransaction) throw new Error('Source governance requires its own transaction');
  return db
    .transaction(() => prepareSourceGovernance(candidateId, serialized, db, context).plan)
    .deferred();
}
/** New admission requires current authority. An exact historical replay returns
 * its original outcome only; it cannot reactivate or promote a memory again.
 * Caller owns access authorization, capture custody and ingress enrollment.
 */
export function applySourceGovernance(
  planInput: SourceGovernancePlan,
  serialized: string,
  db: Database.Database,
  context: SourceGovernanceContext,
): { alreadySettled: boolean; settlement: SourceGovernanceSettlement } {
  if (db.inTransaction) throw new Error('Source governance requires its own transaction');
  if (typeof serialized !== 'string' || serialized.length > MAX_SOURCE_CLASSIFICATION_BYTES)
    throw new Error('Invalid source assertion envelope');
  const expected = SourceGovernancePlan.parse(planInput);
  if (classificationHash(serialized) !== expected.envelopeDigest)
    throw new Error('Source assertion changed since preview');
  return db
    .transaction(() => {
      const deps = sourceGovernanceRepositories(db);
      requireSourceGovernanceChain(deps.auditRepo);
      requireScope(
        expected,
        SourceClassificationReceiver.parse(
          readSourceControlInput(db, () => context.readReceiver()),
        ),
      );
      const previous = readSourceSettlement(expected, deps);
      if (previous) {
        requireSourceGovernanceChain(deps.auditRepo);
        return { alreadySettled: true, settlement: previous };
      }
      const state = prepareSourceGovernance(expected.candidateId, serialized, db, context);
      if (sourceGovernanceDigest(state.plan) !== sourceGovernanceDigest(expected))
        throw new Error('Stale source governance plan');
      const floorEvent = recordProvenanceFloorInTransaction(
        state.candidate,
        serialized,
        state.authority.registry,
        state.receiver,
        deps.auditRepo,
      );
      const tightened = tightenSourceAliases(state.aliases, expected, state.receiver.now, deps);
      const outcome = withVerifiedSourceAdmission(
        state.candidate,
        serialized,
        db,
        () => context.readReceiver(),
        () => curateSourceCandidate(state.candidate, deps, context, state.receiver.now),
      );
      const candidateAfter = deps.candidateRepo.findById(expected.candidateId);
      const promotedAfter =
        outcome.memoryId === null ? null : deps.memoryRepo.findById(outcome.memoryId);
      const settlement = SourceGovernanceSettlement.parse({
        kind: 'source-governance-settlement-v1',
        plan: expected,
        outcome: outcome.outcome,
        memoryId: outcome.memoryId ?? null,
      });
      const event = AuditEvent.parse({
        id: sourceSettlementId(expected),
        action: 'governed',
        memoryId: expected.candidateId,
        tenantId: expected.tenantId,
        actor: PROVENANCE_FLOOR_ACTOR,
        timestamp: state.receiver.now,
        reason: 'Settle source-authenticated candidate governance',
        details: settlement,
      });
      deps.auditRepo.insert(event);
      // This fresh read is inside the same write transaction. Authority expiry or
      // revocation during work rolls back every row and receipt above.
      const receiver = SourceClassificationReceiver.parse(
        readSourceControlInput(db, () => context.readReceiver()),
      );
      const latest = { registry: readStoredSourceRegistry(db), receiver };
      requireScope(expected, receiver);
      const verified = verifySourceClassification({
        ...latest,
        receiver,
        candidate: state.candidate,
        serialized,
      });
      if (
        verified.status !== 'verified' ||
        sourceGovernanceDigest(verified) !== expected.authorityDigest
      )
        throw new Error('Source authority changed before commit');
      if (
        sourceGovernanceDigest(deps.candidateRepo.findById(expected.candidateId)) !==
          sourceGovernanceDigest(candidateAfter) ||
        sourceGovernanceDigest(deps.policyRepo.findByTenant(expected.tenantId)) !==
          expected.policyDigest
      )
        throw new Error('Source candidate or policy changed before commit');
      const configDigest = sourceGovernanceDigest({
        originSecretDigest:
          context.originSecret === undefined ? null : classificationHash(context.originSecret),
      });
      if (configDigest !== expected.configDigest)
        throw new Error('Source configuration changed before commit');
      requireSourceEvent(floorEvent, deps);
      requireSourceEvent(event, deps);
      for (const receipt of tightened.events) requireSourceEvent(receipt, deps);
      requireSourceRows(tightened.changed, deps);
      if (promotedAfter !== null) requireSourceRows([promotedAfter], deps);
      if (
        resolveCandidateMinimumSensitivity(state.candidate, deps.auditRepo) !==
        expected.minimumSensitivity
      )
        throw new Error('Source floor changed before commit');
      requireSourceGovernanceChain(deps.auditRepo);
      return { alreadySettled: false, settlement };
    })
    .immediate();
}
