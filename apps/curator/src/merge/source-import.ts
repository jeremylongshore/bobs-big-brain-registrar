import { isDeepStrictEqual } from 'node:util';
import { deriveAuditEventId, deriveMemoryId } from '@qmd-team-intent-kb/common';
import {
  classifyContent,
  effectiveSensitivity,
  PolicyPipeline,
} from '@qmd-team-intent-kb/policy-engine';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import { AuditEvent } from '@qmd-team-intent-kb/schema';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import { verifyAuditChain } from '@qmd-team-intent-kb/store';
import { resolveCandidateMinimumSensitivity } from '../recovery/sensitivity-constraint.js';
import { promote } from '../promotion/promoter.js';
import {
  recordImportedMinimumSensitivity,
  SOURCE_IMPORT_ACTOR,
} from '../recovery/imported-sensitivity-constraint.js';
import { SourceSnapshotError } from './source-snapshot-schema.js';
import { SourceImportError, SourceImportPlan } from './source-import-schema.js';
import type {
  SourceImportContext,
  SourceImportDependencies,
  SourceImportOutcome,
  SourceImportResult,
} from './source-import-schema.js';
import {
  boundImportInputs,
  prepareSourceImportState,
  groupsForImport,
  recheckImportAuthority,
} from './source-import-prepare.js';
import type { SourceImportGroup } from './source-import-groups.js';
import {
  readImportSettlement,
  recordImportSettlement,
  recordSourceProgress,
  requireRetainedEvent,
} from './source-import-state.js';

type Prepared = ReturnType<typeof prepareSourceImportState>;
interface AssessedGroup {
  group: SourceImportGroup;
  result: PipelineResult;
  sensitivity: CuratedMemory['sensitivity'];
  targetId: string;
}

function assessGroups(state: Prepared, groups: SourceImportGroup[]): AssessedGroup[] {
  const pipeline = state.policy === undefined ? undefined : new PolicyPipeline(state.policy);
  const active = state.rows
    .filter((row) => row.lifecycle === 'active')
    .map((row) => ({ id: row.id, content: row.content, category: row.category }));
  const assessments: AssessedGroup[] = [];
  for (const group of groups) {
    const candidate = group.incoming[0]!;
    // Grouping handles content duplicates after combining constraints. Evaluate
    // every other policy rule even when this content already exists locally.
    const result = pipeline?.evaluate(candidate, {
      minimumSensitivity: group.minimumSensitivity,
      tenantId: state.plan.tenantId,
      existingHashes: new Set(),
      getActiveMemoriesInCategory: (category) => active.filter((row) => row.category === category),
    }) ?? { candidateId: candidate.id, outcome: 'approved', evaluations: [] };
    const targetId = group.existing[0]?.id ?? deriveMemoryId(candidate.id, group.contentHash);
    const sensitivity = effectiveSensitivity(
      classifyContent(candidate.content).sensitivityLevel,
      group.minimumSensitivity,
    );
    assessments.push({ group, result, sensitivity, targetId });
    if (group.existing.length === 0 && result.outcome === 'approved') {
      active.push({ id: targetId, content: candidate.content, category: candidate.category });
    }
  }
  return assessments;
}

function importOutcomes(assessments: AssessedGroup[]): SourceImportOutcome[] {
  return assessments.flatMap(({ group, result, sensitivity, targetId }) =>
    group.incoming.map((candidate, index) => ({
      candidateId: candidate.id,
      memoryId: targetId,
      contentHash: group.contentHash,
      minimumSensitivity: group.minimumSensitivity,
      sensitivity,
      status:
        result.outcome !== 'approved'
          ? ('rejected' as const)
          : group.existing.length > 0
            ? ('existing' as const)
            : index === 0
              ? ('promoted' as const)
              : ('deduplicated' as const),
      ...(result.outcome === 'approved' ? {} : { reason: `policy-${result.outcome}` }),
    })),
  );
}

function protectImport<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SourceImportError || error instanceof SourceSnapshotError) throw error;
    throw new SourceImportError('invalid-destination');
  }
}

function requireSharedConnection(deps: SourceImportDependencies): void {
  if (
    deps.memoryRepo.connection !== deps.auditRepo.connection ||
    deps.memoryRepo.connection.inTransaction
  )
    throw new SourceImportError('invalid-input');
}

/** Read-only preview. Plan digests detect changes; they are not human approval or source enrollment. */
export function previewSourceImport(
  artifacts: readonly string[],
  deps: SourceImportDependencies,
  context: SourceImportContext,
): { plan: SourceImportPlan; outcomes: SourceImportOutcome[]; alreadyApplied: boolean } {
  return protectImport(() => {
    requireSharedConnection(deps);
    const inputs = boundImportInputs(artifacts);
    return deps.memoryRepo.connection
      .transaction(() => {
        const state = prepareSourceImportState(inputs, deps, context);
        const previous = readImportSettlement(state.plan, deps.auditRepo);
        const outcomes =
          previous?.outcomes ?? importOutcomes(assessGroups(state, groupsForImport(state, deps)));
        recheckImportAuthority(inputs, context, state.plan);
        return { plan: state.plan, outcomes, alreadyApplied: previous !== undefined };
      })
      .deferred();
  });
}

function tightenExisting(
  assessment: AssessedGroup,
  plan: SourceImportPlan,
  timestamp: string,
  deps: SourceImportDependencies,
  events: AuditEvent[],
  memories: CuratedMemory[],
): void {
  for (const current of assessment.group.existing) {
    if (current.sensitivity === assessment.sensitivity) {
      memories.push(current);
      continue;
    }
    const updated = {
      ...current,
      sensitivity: assessment.sensitivity,
      updatedAt: timestamp,
      version: current.version + 1,
    };
    if (!deps.memoryRepo.update(updated)) throw new SourceImportError('retention-failed');
    const kind = 'source-import-tightening-v1';
    const event = AuditEvent.parse({
      id: deriveAuditEventId(current.id, 'governed', `${kind}:${plan.importDigest}`),
      memoryId: current.id,
      tenantId: plan.tenantId,
      action: 'governed',
      actor: SOURCE_IMPORT_ACTOR,
      timestamp,
      reason: 'Tighten existing memory to the verified effective sensitivity',
      details: {
        kind,
        importDigest: plan.importDigest,
        contentHash: current.contentHash,
        previousSensitivity: current.sensitivity,
        sensitivity: updated.sensitivity,
      },
    });
    deps.auditRepo.insert(event);
    events.push(event);
    memories.push(updated);
  }
}

function applyAssessments(
  assessments: AssessedGroup[],
  state: Prepared,
  timestamp: string,
  deps: SourceImportDependencies,
) {
  const events: AuditEvent[] = [];
  const memories: CuratedMemory[] = [];
  for (const assessment of assessments) {
    const { group, result } = assessment;
    // Retain restrictions even when optional admission policy refuses the source.
    // A later review of an alias must not rediscover it with a weaker floor.
    for (const candidate of group.candidates) {
      events.push(
        recordImportedMinimumSensitivity(
          candidate,
          group.minimumSensitivity,
          state.plan.importDigest,
          group.sourceSnapshotDigests,
          timestamp,
          deps.auditRepo,
        ),
      );
    }
    tightenExisting(assessment, state.plan, timestamp, deps, events, memories);
    if (group.existing.length === 0 && result.outcome === 'approved') {
      const memory = promote(
        {
          candidate: group.incoming[0]!,
          contentHash: group.contentHash,
          pipelineResult: result,
          minimumSensitivity: group.minimumSensitivity,
          promotedBy: SOURCE_IMPORT_ACTOR,
        },
        deps.memoryRepo,
        deps.auditRepo,
        false,
        undefined,
        undefined,
        timestamp,
      );
      memories.push(memory);
      const receipt = deps.auditRepo
        .findByMemoryAndTenant(memory.id, memory.tenantId)
        .find((event) => event.id === deriveAuditEventId(memory.id, 'promoted'));
      if (receipt === undefined) throw new SourceImportError('retention-failed');
      events.push(receipt);
    }
  }
  return { events, memories };
}

function verifyFinalConstraints(
  assessments: AssessedGroup[],
  deps: SourceImportDependencies,
): void {
  for (const { group } of assessments) {
    for (const candidate of group.candidates) {
      if (
        resolveCandidateMinimumSensitivity(candidate, deps.auditRepo) !== group.minimumSensitivity
      )
        throw new SourceImportError('retention-failed');
    }
  }
  const chain = verifyAuditChain(deps.auditRepo);
  if (
    chain.breaks.length ||
    chain.unverifiedRows ||
    deps.auditRepo
      .findAllChronological()
      .some((event) => event.hash_version !== 1 && event.hash_version !== 2)
  )
    throw new SourceImportError('retention-failed');
}

function verifyRetainedWrites(
  events: AuditEvent[],
  memories: CuratedMemory[],
  deps: SourceImportDependencies,
): void {
  for (const event of events) requireRetainedEvent(event, deps.auditRepo);
  for (const memory of memories) {
    // Repository projections can contain optional undefined fields. Compare their
    // JSON domain while preserving every stored field, not just the floor.
    if (
      !isDeepStrictEqual(
        JSON.parse(JSON.stringify(memory)),
        JSON.parse(JSON.stringify(deps.memoryRepo.findById(memory.id))),
      )
    ) {
      throw new SourceImportError('retention-failed');
    }
  }
}

/** Immediate transaction owns verification, policy, durable floors, memory writes
 * and receipts. Caller owns local access authorization and any external store lock.
 * Historical replay returns its receipt and never reactivates/repromotes a row.
 */
export function applySourceImport(
  planInput: SourceImportPlan,
  artifacts: readonly string[],
  deps: SourceImportDependencies,
  context: SourceImportContext,
): SourceImportResult {
  return protectImport(() => {
    requireSharedConnection(deps);
    const expected = SourceImportPlan.parse(planInput);
    const inputs = boundImportInputs(artifacts);
    return deps.memoryRepo.connection
      .transaction(() => {
        const state = prepareSourceImportState(inputs, deps, context);
        if (
          expected.importDigest !== state.plan.importDigest ||
          expected.authorityDigest !== state.plan.authorityDigest ||
          expected.tenantId !== state.plan.tenantId ||
          expected.policyDigest !== state.plan.policyDigest ||
          !isDeepStrictEqual(expected.sourceSnapshotDigests, state.plan.sourceSnapshotDigests)
        )
          throw new SourceImportError('stale-plan');
        const previous = readImportSettlement(state.plan, deps.auditRepo);
        if (previous !== undefined) {
          recheckImportAuthority(inputs, context, state.plan);
          return previous;
        }
        if (expected.destinationDigest !== state.plan.destinationDigest)
          throw new SourceImportError('stale-plan');
        const assessments = assessGroups(state, groupsForImport(state, deps));
        const timestamp = new Date(context.now()).toISOString();
        const { events, memories } = applyAssessments(assessments, state, timestamp, deps);
        for (const snapshot of state.snapshots)
          events.push(recordSourceProgress(snapshot, state.plan, timestamp, deps.auditRepo));
        const outcomes = importOutcomes(assessments);
        events.push(recordImportSettlement(state.plan, outcomes, timestamp, deps.auditRepo));
        recheckImportAuthority(inputs, context, state.plan);
        verifyRetainedWrites(events, memories, deps);
        verifyFinalConstraints(assessments, deps);
        return { importDigest: state.plan.importDigest, alreadyApplied: false, outcomes };
      })
      .immediate();
  });
}
