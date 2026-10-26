import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { computeContentHash, deriveAuditEventId } from '@qmd-team-intent-kb/common';
import { AuditEvent, Sha256Hash, Uuid } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
} from '@qmd-team-intent-kb/store';
import { DEFAULT_ALLOWED_ORIGIN_CHANNELS, intakeCandidate } from '../intake/candidate-intake.js';
import { validateRecoveryPlan } from './recovery-plan.js';
import type { RecoveryPlan, RecoveryPlanEntry } from './recovery-plan.js';
import { candidateSnapshotDigest, governSelectedCandidates } from './selected-governance.js';
import type { SelectedGovernanceOptions, SelectedOutcome } from './selected-governance.js';
import {
  archiveRecoveredSource,
  auditEventSnapshotDigest,
  memorySnapshotDigest,
} from './source-archive.js';

const KIND = 'memory-recovery-apply-v1';

export interface RecoveryApplicationOptions extends SelectedGovernanceOptions {
  allowedOriginChannels?: readonly string[];
}

export interface RecoveryEntryStatus {
  sourceId: string;
  candidateId: string;
  historicalOutcome?: SelectedOutcome['outcome'];
  targetId?: string;
  archived: boolean;
  problems: string[];
}

export interface RecoveryStatus {
  runId: string;
  planDigest: string;
  /** not_applied means no apply receipt; it does not certify current apply readiness. */
  state: 'not_applied' | 'complete' | 'partial' | 'drifted';
  auditEventId?: string;
  problems: string[];
  entries: RecoveryEntryStatus[];
}

export interface RecoveryApplicationResult {
  alreadyApplied: boolean;
  status: RecoveryStatus;
}

interface AppliedEntry {
  sourceId: string;
  candidateId: string;
  outcome: SelectedOutcome['outcome'];
  sourceSnapshotDigest: string;
  candidateSnapshotDigest: string;
  memoryId?: string;
  targetSnapshotDigest?: string;
  archiveEventId?: string;
}

interface Witness {
  id: string;
  memoryId: string;
  tenantId: string;
  snapshotDigest: string;
}

interface Settlement {
  entries: AppliedEntry[];
  witnesses: Witness[];
}

function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function repositories(connection: Database.Database) {
  return {
    memories: new MemoryRepository(connection),
    candidates: new CandidateRepository(connection),
    audit: new AuditRepository(connection),
    policies: new PolicyRepository(connection),
  };
}
type Repositories = ReturnType<typeof repositories>;

function applyId(plan: RecoveryPlan): string {
  return deriveAuditEventId(plan.runId, 'governed', KIND);
}

function storeMatches(plan: RecoveryPlan, connection: Database.Database): boolean {
  const databases = connection.pragma('database_list') as { name: string; file: string }[];
  return (databases.find((row) => row.name === 'main')?.file || ':memory:') === plan.storeLocator;
}

function policyMatches(plan: RecoveryPlan, repos: Repositories): boolean {
  return isDeepStrictEqual(json(repos.policies.findByTenant(plan.targetTenantId)), plan.policies);
}

function exclusionProblems(plan: RecoveryPlan, repos: Repositories): string[] {
  return plan.exclusions.flatMap((binding) => {
    const memory = repos.memories.findById(binding.id);
    return memory !== null &&
      memory.tenantId === plan.sourceTenantId &&
      memory.lifecycle === 'active' &&
      memorySnapshotDigest(memory) === binding.snapshotDigest
      ? []
      : [`excluded_source_changed:${binding.id}`];
  });
}

function previousReceipt(plan: RecoveryPlan, repos: Repositories): AuditEvent | undefined {
  return repos.audit
    .findByMemoryAndTenant(plan.runId, plan.targetTenantId)
    .find((event) => event.id === applyId(plan));
}

function requireEvent(
  id: string,
  memoryId: string,
  tenantId: string,
  repos: Repositories,
): AuditEvent {
  const event = repos.audit.findByMemoryAndTenant(memoryId, tenantId).find((row) => row.id === id);
  if (event === undefined) throw new Error('Recovery canonical receipt is missing');
  return event;
}

function parseEntry(value: unknown, expected: RecoveryPlanEntry): AppliedEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid recovery settlement entry');
  }
  const entry = value as AppliedEntry;
  const outcomes: readonly string[] = [
    'promoted',
    'rejected',
    'flagged',
    'held',
    'quarantined',
    'duplicate',
  ];
  if (
    entry.sourceId !== expected.source.id ||
    entry.candidateId !== expected.proposal.id ||
    !outcomes.includes(entry.outcome)
  )
    throw new Error('Recovery settlement identity or outcome differs');
  Sha256Hash.parse(entry.sourceSnapshotDigest);
  Sha256Hash.parse(entry.candidateSnapshotDigest);
  if (entry.outcome === 'promoted') {
    Uuid.parse(entry.memoryId);
    Uuid.parse(entry.archiveEventId);
    Sha256Hash.parse(entry.targetSnapshotDigest);
  } else if (
    entry.memoryId !== undefined ||
    entry.archiveEventId !== undefined ||
    entry.targetSnapshotDigest !== undefined
  )
    throw new Error('Unadmitted recovery entry claims an archived target');
  return entry;
}

function parseSettlement(event: AuditEvent, plan: RecoveryPlan): Settlement {
  const details = event.details;
  if (
    event.action !== 'governed' ||
    details['kind'] !== KIND ||
    details['planDigest'] !== plan.digest ||
    !isDeepStrictEqual(event.actor, plan.actor) ||
    event.reason !== plan.reason ||
    !Array.isArray(details['entries']) ||
    details['entries'].length !== plan.entries.length ||
    !Array.isArray(details['witnesses'])
  )
    throw new Error('Recovery run has a different or malformed apply receipt');
  const entries = details['entries'].map((value: unknown, index: number) =>
    parseEntry(value, plan.entries[index]!),
  );
  const witnesses = details['witnesses'].map((value: unknown): Witness => {
    if (value === null || typeof value !== 'object') throw new Error('Invalid recovery witness');
    const witness = value as Witness;
    Uuid.parse(witness.id);
    Uuid.parse(witness.memoryId);
    Sha256Hash.parse(witness.snapshotDigest);
    if (witness.tenantId !== plan.sourceTenantId && witness.tenantId !== plan.targetTenantId) {
      throw new Error('Recovery witness is outside reviewed tenants');
    }
    return witness;
  });
  // Every admission must retain its proposal, promoted and archive receipts, and
  // every run its canonical selected settlement. Digests alone are not enough if
  // a malformed receipt omits the load-bearing witnesses altogether.
  for (const entry of entries) {
    const required = [deriveAuditEventId(entry.candidateId, 'proposed')];
    if (entry.memoryId !== undefined)
      required.push(deriveAuditEventId(entry.memoryId, 'promoted'), entry.archiveEventId!);
    if (required.some((id) => !witnesses.some((item) => item.id === id))) {
      throw new Error('Recovery settlement omits required canonical receipts');
    }
  }
  if (
    !witnesses.some((item) => item.memoryId === plan.runId && item.tenantId === plan.targetTenantId)
  ) {
    throw new Error('Recovery settlement omits selected-governance receipt');
  }
  return { entries, witnesses };
}

function entryStatus(
  entry: AppliedEntry,
  plan: RecoveryPlan,
  repos: Repositories,
): RecoveryEntryStatus {
  const source = repos.memories.findById(entry.sourceId);
  const candidate = repos.candidates.findById(entry.candidateId);
  const problems: string[] = [];
  if (
    source === null ||
    source.tenantId !== plan.sourceTenantId ||
    memorySnapshotDigest(source) !== entry.sourceSnapshotDigest ||
    source.lifecycle !== (entry.outcome === 'promoted' ? 'archived' : 'active')
  )
    problems.push('source_changed');
  if (
    candidate === null ||
    candidate.tenantId !== plan.targetTenantId ||
    candidateSnapshotDigest(candidate) !== entry.candidateSnapshotDigest
  )
    problems.push('candidate_changed');
  if (entry.outcome !== 'promoted' && candidate?.status === 'promoted') {
    problems.push('later_review_requires_finalization');
  }
  if (entry.memoryId !== undefined) {
    const target = repos.memories.findById(entry.memoryId);
    if (
      target === null ||
      target.tenantId !== plan.targetTenantId ||
      target.lifecycle !== 'active' ||
      target.candidateId !== entry.candidateId ||
      memorySnapshotDigest(target) !== entry.targetSnapshotDigest
    ) {
      problems.push('target_changed');
    }
  }
  return {
    sourceId: entry.sourceId,
    candidateId: entry.candidateId,
    historicalOutcome: entry.outcome,
    ...(entry.memoryId === undefined ? {} : { targetId: entry.memoryId }),
    archived:
      source?.lifecycle === 'archived' &&
      memorySnapshotDigest(source) === entry.sourceSnapshotDigest,
    problems,
  };
}

function statusWithin(
  plan: RecoveryPlan,
  connection: Database.Database,
  repos: Repositories,
): RecoveryStatus {
  const problems = exclusionProblems(plan, repos);
  if (!storeMatches(plan, connection)) problems.push('store_locator_changed');
  if (!policyMatches(plan, repos)) problems.push('policy_changed');
  const receipt = previousReceipt(plan, repos);
  if (receipt === undefined) {
    const entries = plan.entries.map((entry): RecoveryEntryStatus => {
      const source = repos.memories.findById(entry.source.id);
      return {
        sourceId: entry.source.id,
        candidateId: entry.proposal.id,
        archived: false,
        problems:
          source !== null && memorySnapshotDigest(source) === entry.sourceSnapshotDigest
            ? []
            : ['source_changed'],
      };
    });
    return {
      runId: plan.runId,
      planDigest: plan.digest,
      state:
        problems.length > 0 || entries.some((entry) => entry.problems.length > 0)
          ? 'drifted'
          : 'not_applied',
      problems,
      entries,
    };
  }
  const settlement = parseSettlement(receipt, plan);
  const entries = settlement.entries.map((entry) => entryStatus(entry, plan, repos));
  for (const witness of settlement.witnesses) {
    const actual = repos.audit
      .findByMemoryAndTenant(witness.memoryId, witness.tenantId)
      .find((event) => event.id === witness.id);
    if (actual === undefined || auditEventSnapshotDigest(actual) !== witness.snapshotDigest) {
      problems.push(`receipt_changed:${witness.id}`);
    }
  }
  return {
    runId: plan.runId,
    planDigest: plan.digest,
    auditEventId: receipt.id,
    problems,
    entries,
    state:
      problems.length > 0 || entries.some((entry) => entry.problems.length > 0)
        ? 'drifted'
        : entries.every((entry) => entry.archived)
          ? 'complete'
          : 'partial',
  };
}

/** Read-only historical settlement and current drift. No later review is reinterpreted. */
export function readRecoveryStatus(
  data: unknown,
  expectedDigest: string,
  connection: Database.Database,
): RecoveryStatus {
  const plan = validateRecoveryPlan(data, expectedDigest);
  return connection
    .transaction(() => statusWithin(plan, connection, repositories(connection)))
    .deferred();
}

function requireFreshSources(plan: RecoveryPlan, repos: Repositories): void {
  if (!policyMatches(plan, repos) || exclusionProblems(plan, repos).length > 0) {
    throw new Error('Recovery policy or exclusion snapshot changed');
  }
  for (const entry of plan.entries) {
    const source = repos.memories.findById(entry.source.id);
    if (
      source === null ||
      source.tenantId !== plan.sourceTenantId ||
      source.lifecycle !== 'active' ||
      memorySnapshotDigest(source) !== entry.sourceSnapshotDigest
    )
      throw new Error('Recovery source snapshot changed');
    if (
      repos.memories.findByContentHashAndTenant(entry.source.contentHash, plan.targetTenantId) !==
      null
    ) {
      throw new Error('Recovery target content already exists without this apply receipt');
    }
  }
}

function requireProposalReceipt(
  entry: RecoveryPlanEntry,
  plan: RecoveryPlan,
  repos: Repositories,
): void {
  const event = requireEvent(
    deriveAuditEventId(entry.proposal.id, 'proposed'),
    entry.proposal.id,
    plan.targetTenantId,
    repos,
  );
  if (
    event.action !== 'proposed' ||
    event.actor.type !== 'human' ||
    event.actor.id !== plan.actor.id ||
    event.details['candidateId'] !== entry.proposal.id ||
    event.details['tenantId'] !== plan.targetTenantId ||
    event.details['contentHash'] !== computeContentHash(entry.proposal.content) ||
    event.details['proposedByRole'] !== 'admin' ||
    event.details['at'] !== event.timestamp
  ) {
    throw new Error('Recovery proposal lacks matching canonical intake provenance');
  }
}

function capture(
  plan: RecoveryPlan,
  connection: Database.Database,
  repos: Repositories,
  channels: readonly string[],
  witnesses: Map<string, Witness>,
): void {
  for (const entry of plan.entries) {
    const actual = intakeCandidate(
      entry.proposal,
      connection,
      { actor: plan.actor.id, role: 'admin', tenants: [plan.targetTenantId] },
      channels,
    );
    if (
      candidateSnapshotDigest(actual.candidate) !== entry.candidateSnapshotDigest ||
      actual.candidate.id !== entry.proposal.id
    )
      throw new Error('Recovery intake replay returned a different candidate snapshot');
    requireProposalReceipt(entry, plan, repos);
    collectWitnesses(
      plan,
      [{ sourceId: entry.source.id, candidateId: entry.proposal.id }],
      repos,
      witnesses,
    );
  }
}

function archiveOutcome(
  outcome: SelectedOutcome,
  entry: RecoveryPlanEntry,
  plan: RecoveryPlan,
  settlementId: string,
  expectedTargetDigest: string | undefined,
  connection: Database.Database,
  repos: Repositories,
): AppliedEntry {
  let archiveEventId: string | undefined;
  let targetSnapshotDigest: string | undefined;
  const candidate = repos.candidates.findById(entry.proposal.id);
  const status =
    outcome.outcome === 'held' || outcome.outcome === 'quarantined'
      ? 'quarantined'
      : outcome.outcome === 'flagged'
        ? 'inbox'
        : outcome.outcome;
  if (
    candidate === null ||
    candidateSnapshotDigest(candidate) !== candidateSnapshotDigest({ ...entry.proposal, status })
  ) {
    throw new Error('Recovery settled candidate differs from frozen proposal');
  }
  if (outcome.outcome === 'promoted') {
    const target =
      outcome.memoryId === undefined ? null : repos.memories.findById(outcome.memoryId);
    if (target === null || memorySnapshotDigest(target) !== expectedTargetDigest)
      throw new Error('Recovery promoted target changed before archival');
    const promotion = requireEvent(
      deriveAuditEventId(target.id, 'promoted'),
      target.id,
      plan.targetTenantId,
      repos,
    );
    const settlement = requireEvent(settlementId, plan.runId, plan.targetTenantId, repos);
    targetSnapshotDigest = memorySnapshotDigest(target);
    const result = archiveRecoveredSource(
      {
        runId: plan.runId,
        sourceTenantId: plan.sourceTenantId,
        targetTenantId: plan.targetTenantId,
        actor: plan.actor,
        role: plan.role,
        reason: plan.reason,
        source: { id: entry.source.id, snapshotDigest: entry.sourceSnapshotDigest },
        target: { id: target.id, snapshotDigest: targetSnapshotDigest },
        candidate: { id: candidate.id, snapshotDigest: candidateSnapshotDigest(candidate) },
        promotionReceipt: { id: promotion.id, snapshotDigest: auditEventSnapshotDigest(promotion) },
        settlementReceipt: {
          id: settlement.id,
          snapshotDigest: auditEventSnapshotDigest(settlement),
        },
      },
      connection,
    );
    archiveEventId = result.auditEventId;
  }
  const source = repos.memories.findById(entry.source.id);
  if (
    source === null ||
    (outcome.outcome !== 'promoted' && memorySnapshotDigest(source) !== entry.sourceSnapshotDigest)
  )
    throw new Error('Recovery unarchived source changed during settlement');
  return {
    sourceId: source.id,
    candidateId: candidate.id,
    outcome: outcome.outcome,
    sourceSnapshotDigest: memorySnapshotDigest(source),
    candidateSnapshotDigest: candidateSnapshotDigest(candidate),
    ...(outcome.outcome === 'promoted'
      ? { memoryId: outcome.memoryId, targetSnapshotDigest, archiveEventId }
      : {}),
  };
}

function collectWitnesses(
  plan: RecoveryPlan,
  entries: readonly Pick<AppliedEntry, 'sourceId' | 'candidateId' | 'memoryId'>[],
  repos: Repositories,
  witnesses: Map<string, Witness>,
): void {
  const scopes = [{ id: plan.runId, tenant: plan.targetTenantId }];
  for (const entry of entries) {
    scopes.push(
      { id: entry.sourceId, tenant: plan.sourceTenantId },
      { id: entry.candidateId, tenant: plan.targetTenantId },
    );
    if (entry.memoryId !== undefined)
      scopes.push({ id: entry.memoryId, tenant: plan.targetTenantId });
  }
  for (const scope of scopes) {
    for (const event of repos.audit.findByMemoryAndTenant(scope.id, scope.tenant)) {
      const witness = {
        id: event.id,
        memoryId: event.memoryId,
        tenantId: event.tenantId,
        snapshotDigest: auditEventSnapshotDigest(event),
      };
      const previous = witnesses.get(event.id);
      if (previous !== undefined && !isDeepStrictEqual(previous, witness)) {
        throw new Error('Recovery earlier-stage receipt changed');
      }
      witnesses.set(event.id, witness);
    }
  }
}

/**
 * Atomic same-store core. Caller authenticates authority in both tenants, holds
 * the real brain filesystem lock and handles postcommit anchoring/derived work.
 * Partial means unresolved canonical policy outcomes, not a partial transaction.
 */
export function applyRecoveryPlan(
  data: unknown,
  expectedDigest: string,
  connection: Database.Database,
  options: RecoveryApplicationOptions = {},
): RecoveryApplicationResult {
  const plan = validateRecoveryPlan(data, expectedDigest);
  const channels = options.allowedOriginChannels ?? DEFAULT_ALLOWED_ORIGIN_CHANNELS;
  if (!isDeepStrictEqual([...channels], plan.allowedOriginChannels))
    throw new Error('Recovery intake channel configuration changed');
  return connection
    .transaction((): RecoveryApplicationResult => {
      const repos = repositories(connection);
      if (!storeMatches(plan, connection)) throw new Error('Recovery store locator changed');
      const previous = previousReceipt(plan, repos);
      if (previous !== undefined) {
        const status = statusWithin(plan, connection, repos);
        if (status.state === 'drifted')
          throw new Error('Recovery replay has current source, target, policy or receipt drift');
        return { alreadyApplied: true, status };
      }
      if (repos.audit.findByMemoryAndTenant(plan.runId, plan.targetTenantId).length > 0) {
        throw new Error('Recovery run identity already has unrelated historical settlement');
      }
      requireFreshSources(plan, repos);
      const witnesses = new Map<string, Witness>();
      const scopes = plan.entries.map((entry) => ({
        sourceId: entry.source.id,
        candidateId: entry.proposal.id,
      }));
      collectWitnesses(plan, scopes, repos, witnesses);
      capture(plan, connection, repos, channels, witnesses);
      const settlement = governSelectedCandidates(
        {
          runId: plan.runId,
          tenantId: plan.targetTenantId,
          actor: plan.actor,
          role: plan.role,
          reason: plan.reason,
          selections: plan.entries.map((entry) => ({
            candidateId: entry.proposal.id,
            snapshotDigest: entry.candidateSnapshotDigest,
            minimumSensitivity: entry.minimumSensitivity,
          })),
        },
        connection,
        {
          ...(options.originSecret === undefined ? {} : { originSecret: options.originSecret }),
          ...(options.importExclusions === undefined
            ? {}
            : { importExclusions: options.importExclusions }),
          ...(options.holdLimits === undefined ? {} : { holdLimits: options.holdLimits }),
        },
      );
      if (settlement.alreadySettled)
        throw new Error('Recovery cannot adopt a historical selected run');
      const settledScopes = settlement.outcomes.map((outcome, index) => ({
        ...scopes[index]!,
        ...(outcome.memoryId === undefined ? {} : { memoryId: outcome.memoryId }),
      }));
      collectWitnesses(plan, settledScopes, repos, witnesses);
      const targets = settlement.outcomes.map((outcome) => {
        if (outcome.memoryId === undefined) return undefined;
        const target = repos.memories.findById(outcome.memoryId);
        if (target === null) throw new Error('Recovery settled target is missing');
        return memorySnapshotDigest(target);
      });
      const entries = settlement.outcomes.map((outcome, index) => {
        const entry = archiveOutcome(
          outcome,
          plan.entries[index]!,
          plan,
          settlement.auditEventId,
          targets[index],
          connection,
          repos,
        );
        collectWitnesses(plan, settledScopes, repos, witnesses);
        return entry;
      });
      const event = AuditEvent.parse({
        id: applyId(plan),
        action: 'governed',
        memoryId: plan.runId,
        tenantId: plan.targetTenantId,
        actor: plan.actor,
        reason: plan.reason,
        timestamp: new Date().toISOString(),
        details: {
          kind: KIND,
          planDigest: plan.digest,
          entries,
          witnesses: [...witnesses.values()],
        },
      });
      repos.audit.insert(event);
      const stored = requireEvent(event.id, plan.runId, plan.targetTenantId, repos);
      if (!isDeepStrictEqual(stored, event))
        throw new Error('Recovery apply receipt was not retained');
      const status = statusWithin(plan, connection, repos);
      if (status.state === 'drifted')
        throw new Error('Recovery state or evidence changed before commit');
      return { alreadyApplied: false, status };
    })
    .immediate();
}
