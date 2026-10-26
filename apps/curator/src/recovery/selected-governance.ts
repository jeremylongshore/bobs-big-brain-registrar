import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { classifyContent, effectiveSensitivity } from '@qmd-team-intent-kb/policy-engine';
import { resolveCandidateMinimumSensitivity } from './sensitivity-constraint.js';
import { computeContentHash, isAudienceVisibleToRole } from '@qmd-team-intent-kb/common';
import {
  AuditEvent,
  MemoryCandidate,
  Sha256Hash,
  Sensitivity,
  TenantId,
  Uuid,
} from '@qmd-team-intent-kb/schema';
import type { Author, CandidateStatus } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryLinksRepository,
  MemoryRepository,
  PolicyRepository,
} from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';

import { Curator } from '../curator.js';
import { recordCandidateMinimumSensitivity } from './sensitivity-constraint.js';
import type { CuratorDependencies } from '../curator.js';
import { findActiveHold } from '../hold/hold.js';
import type { CurationResult, CuratorConfig } from '../types.js';

export interface SelectedCandidateBinding {
  candidateId: string;
  /** Digest of the complete schema-normalized candidate, including metadata and status. */
  snapshotDigest: string;
  /** Reviewed source floor; persisted for later review in this same store. */
  minimumSensitivity?: Sensitivity;
}

export interface SelectedGovernanceInput {
  /** Caller-generated run identity; reuse only for the same ordered manifest. */
  runId: string;
  tenantId: string;
  selections: readonly SelectedCandidateBinding[];
  /** Caller establishes identity, tenant authority and standing outside this core function. */
  actor: Author;
  role: 'admin' | 'owner';
  reason: string;
}

export interface SelectedOutcome {
  candidateId: string;
  outcome: CurationResult['outcome'] | 'quarantined';
  memoryId?: string;
}

export interface SelectedGovernanceResult {
  runId: string;
  auditEventId: string;
  /** True returns historical settlement evidence, not a fresh admission/lifecycle check. */
  alreadySettled: boolean;
  outcomes: SelectedOutcome[];
}

export type SelectedGovernanceOptions = Pick<
  CuratorConfig,
  'originSecret' | 'importExclusions' | 'holdLimits' | 'onDormantPolicy'
>;

/** Stable JSON object-key ordering; arrays retain their order. Inputs come from schemas. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown): unknown => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return item;
  });
}

export function candidateSnapshotDigest(candidate: MemoryCandidate): string {
  return computeContentHash(stableJson(MemoryCandidate.parse(candidate)));
}

function requireInput(input: SelectedGovernanceInput): void {
  Uuid.parse(input.runId);
  TenantId.parse(input.tenantId);
  if (
    input.actor?.type !== 'human' ||
    typeof input.actor.id !== 'string' ||
    input.actor.id.trim() === '' ||
    (input.role !== 'admin' && input.role !== 'owner') ||
    typeof input.reason !== 'string' ||
    input.reason.trim() === ''
  ) {
    throw new Error('Selected governance requires declared human admin/owner authority and reason');
  }
  if (
    !Array.isArray(input.selections) ||
    input.selections.length < 1 ||
    input.selections.length > 100
  ) {
    throw new Error('Selected governance requires between one and one hundred bindings');
  }
  const ids = new Set<string>();
  for (const binding of input.selections) {
    Uuid.parse(binding.candidateId);
    Sha256Hash.parse(binding.snapshotDigest);
    if (binding.minimumSensitivity !== undefined) Sensitivity.parse(binding.minimumSensitivity);
    if (ids.has(binding.candidateId)) throw new Error('Duplicate selected candidate binding');
    ids.add(binding.candidateId);
  }
}

/**
 * Govern only a reviewed finite manifest. The caller takes the brain's filesystem
 * write lock before this synchronous core operation and anchors/refreshes after it.
 * All repositories and locked reads/writes use the supplied connection. No spool,
 * policy seeding, inbox enumeration, global expiry, source archival or network I/O.
 * No supersession is authorized: even canonical title/subject matches refuse the
 * whole transaction. Policy flags/holds remain unresolved. A repeat returns the
 * historical run receipt and writes nothing; callers must independently verify a
 * current admitted target before any source archival.
 */
export function governSelectedCandidates(
  input: SelectedGovernanceInput,
  connection: Database.Database,
  options: SelectedGovernanceOptions = {},
): SelectedGovernanceResult {
  requireInput(input);
  const manifestDigest = createHash('sha256')
    .update(
      stableJson({
        tenantId: input.tenantId,
        selections: input.selections,
        // Version the constrained manifest: older code accepted unknown binding
        // keys without applying them. Such a historical run cannot claim a floor.
        ...(input.selections.some((binding) => binding.minimumSensitivity !== undefined)
          ? { sensitivityConstraintVersion: 1 }
          : {}),
      }),
    )
    .digest('hex');
  const candidateRepo = new CandidateRepository(connection);
  const memoryRepo = new MemoryRepository(connection);
  const policyRepo = new PolicyRepository(connection);
  const auditRepo = new AuditRepository(connection);
  const linksRepo = new MemoryLinksRepository(connection);
  const deps = { candidateRepo, memoryRepo, policyRepo, auditRepo, linksRepo };

  return connection
    .transaction((): SelectedGovernanceResult => {
      const previous = auditRepo
        .findByMemoryAndTenant(input.runId, input.tenantId)
        .find(
          (event) => event.action === 'governed' && event.details['kind'] === 'selected-govern-v1',
        );
      if (previous !== undefined) {
        if (previous.details['manifestDigest'] !== manifestDigest) {
          throw new Error('Selected governance run identity has a different manifest');
        }
        const outcomes = parseReceiptOutcomes(previous.details['outcomes'], input.selections);
        return {
          runId: input.runId,
          auditEventId: previous.id,
          alreadySettled: true,
          outcomes,
        };
      }
      if (!policyRepo.findByTenant(input.tenantId).some((policy) => policy.enabled)) {
        throw new Error('Selected governance requires an existing enabled tenant policy');
      }
      // Validate EVERY selected row before the first disposition. A changed or
      // missing binding refuses the entire run, including otherwise valid entries.
      const candidates = input.selections.map((binding) => validateSelection(binding, input, deps));
      // Copy only the supported options: callers from JavaScript cannot smuggle
      // tenant, dry-run or receipt-suppression overrides through an object spread.
      const config: CuratorConfig = {
        tenantId: input.tenantId,
        ...(options.onDormantPolicy === undefined
          ? {}
          : { onDormantPolicy: options.onDormantPolicy }),
        ...(options.originSecret !== undefined ? { originSecret: options.originSecret } : {}),
        ...(options.importExclusions !== undefined
          ? { importExclusions: options.importExclusions }
          : {}),
        ...(options.holdLimits !== undefined ? { holdLimits: options.holdLimits } : {}),
      };
      const curator = new Curator(deps, config);
      const hashes = new Set(memoryRepo.getContentHashesByTenant(input.tenantId));
      const outcomes: SelectedOutcome[] = [];
      const receiptWitnesses = new Map<string, AuditEvent>();
      for (const binding of input.selections) {
        const candidate = validateSelection(binding, input, deps);
        if (binding.minimumSensitivity !== undefined) {
          recordCandidateMinimumSensitivity(
            candidate,
            binding.minimumSensitivity,
            {
              runId: input.runId,
              manifestDigest,
              candidateSnapshotDigest: binding.snapshotDigest,
              actor: input.actor,
              role: input.role,
              reason: input.reason,
            },
            auditRepo,
          );
        }
        const outcome = settleCandidate(candidate, deps, config, curator, hashes);
        outcomes.push(outcome);
        for (const memoryId of [candidate.id, outcome.memoryId]) {
          if (memoryId === undefined) continue;
          for (const event of auditRepo.findByMemoryAndTenant(memoryId, input.tenantId)) {
            receiptWitnesses.set(event.id, event);
          }
        }
      }
      const auditEventId = randomUUID();
      const batchReceipt = AuditEvent.parse({
        id: auditEventId,
        action: 'governed',
        memoryId: input.runId,
        tenantId: input.tenantId,
        actor: input.actor,
        reason: input.reason,
        timestamp: new Date().toISOString(),
        details: { kind: 'selected-govern-v1', manifestDigest, outcomes },
      });
      auditRepo.insert(batchReceipt);
      receiptWitnesses.set(batchReceipt.id, batchReceipt);
      verifyReceiptWitnesses(receiptWitnesses, auditRepo, input.tenantId);
      // Detect same-connection trigger drift, including changes made after an
      // earlier candidate settled or by the final batch-receipt insertion.
      for (const [index, candidate] of candidates.entries()) {
        const outcome = outcomes[index]!;
        verifySelectedRow(candidate, expectedStatus(outcome.outcome), deps.candidateRepo);
        if (outcome.outcome === 'promoted') {
          verifyPromotion(candidate, outcome.memoryId, deps, input.tenantId);
        }
      }
      return { runId: input.runId, auditEventId, alreadySettled: false, outcomes };
    })
    .immediate();
}

function verifyReceiptWitnesses(
  events: ReadonlyMap<string, AuditEvent>,
  auditRepo: AuditRepository,
  tenantId: string,
): void {
  for (const expected of events.values()) {
    const current = auditRepo
      .findByMemoryAndTenant(expected.memoryId, tenantId)
      .find((event) => event.id === expected.id);
    if (!isDeepStrictEqual(current, expected)) {
      throw new Error('Selected governance receipt changed or was not persisted');
    }
  }
}

function validateSelection(
  binding: SelectedCandidateBinding,
  input: SelectedGovernanceInput,
  deps: CuratorDependencies,
): MemoryCandidate {
  const candidate = deps.candidateRepo.findById(binding.candidateId);
  if (
    candidate === null ||
    candidate.tenantId !== input.tenantId ||
    candidateSnapshotDigest(candidate) !== binding.snapshotDigest ||
    candidate.status !== 'inbox' ||
    deps.memoryRepo.existsForCandidate(candidate.id, input.tenantId) ||
    !isAudienceVisibleToRole(candidate.metadata.audience, input.role) ||
    findActiveHold(candidate.id, input.tenantId, deps) !== null
  ) {
    throw new Error('Selected candidate is missing, changed, held, admitted or outside authority');
  }
  return candidate;
}

function setSelectedStatus(
  candidateRepo: CandidateRepository,
  tenantId: string,
  candidate: MemoryCandidate,
  status: CandidateStatus,
): void {
  if (candidateRepo.updateStatus(candidate.id, status, tenantId) !== 1) {
    throw new Error('Selected candidate status was not persisted');
  }
  verifySelectedRow(candidate, status, candidateRepo);
}

function verifySelectedRow(
  candidate: MemoryCandidate,
  status: CandidateStatus,
  candidateRepo: CandidateRepository,
): void {
  if (!isDeepStrictEqual(candidateRepo.findById(candidate.id), { ...candidate, status })) {
    throw new Error('Selected candidate changed during settlement');
  }
}

function expectedStatus(outcome: SelectedOutcome['outcome']): CandidateStatus {
  if (outcome === 'held' || outcome === 'quarantined') return 'quarantined';
  if (outcome === 'flagged') return 'inbox';
  return outcome;
}

function verifyPromotion(
  candidate: MemoryCandidate,
  memoryId: string | undefined,
  deps: CuratorDependencies,
  tenantId: string,
): void {
  const memory = memoryId === undefined ? null : deps.memoryRepo.findById(memoryId);
  const minimum = resolveCandidateMinimumSensitivity(candidate, deps.auditRepo);
  if (
    minimum !== undefined &&
    memory !== null &&
    memory.sensitivity !==
      effectiveSensitivity(classifyContent(candidate.content).sensitivityLevel, minimum)
  ) {
    throw new Error('Selected promotion lost its reviewed sensitivity floor');
  }
  if (
    memory === null ||
    memory.candidateId !== candidate.id ||
    memory.tenantId !== tenantId ||
    memory.lifecycle !== 'active' ||
    memory.content !== candidate.content ||
    memory.contentHash !== computeContentHash(candidate.content) ||
    memory.title !== candidate.title ||
    memory.category !== candidate.category ||
    memory.trustLevel !== candidate.trustLevel ||
    memory.source !== candidate.source ||
    !isDeepStrictEqual(memory.author, candidate.author) ||
    !isDeepStrictEqual(memory.metadata, candidate.metadata) ||
    !deps.auditRepo
      .findByMemoryAndTenant(memory.id, tenantId)
      .some((event) => event.action === 'promoted' && event.details['candidateId'] === candidate.id)
  )
    throw new Error('Selected promotion or its canonical receipt was not persisted');
}

function settleCandidate(
  candidate: MemoryCandidate,
  deps: CuratorDependencies,
  config: CuratorConfig,
  curator: Curator,
  hashes: Set<string>,
): SelectedOutcome {
  if (candidate.metadata.proposedByRole === 'member') {
    setSelectedStatus(deps.candidateRepo, config.tenantId, candidate, 'quarantined');
    return { candidateId: candidate.id, outcome: 'quarantined' };
  }
  // A read-only canonical preview occurs under the same immediate lock and
  // includes memories admitted earlier in this finite run.
  const preview = new Curator(deps, {
    ...config,
    dryRun: true,
    supersessionMode: 'report',
  }).processSingle(candidate, hashes);
  if (preview.supersessionReport !== undefined) {
    throw new Error('Selected governance refuses unapproved supersession');
  }
  const priorIds = new Set(
    deps.auditRepo.findByMemoryAndTenant(candidate.id, config.tenantId).map((event) => event.id),
  );
  const result = curator.processSingle(candidate, hashes);
  if (result.supersededIds?.length || result.supersessionReport !== undefined) {
    throw new Error('Selected governance refuses unapproved supersession');
  }
  verifySelectedRow(
    candidate,
    result.outcome === 'held' ? 'quarantined' : 'inbox',
    deps.candidateRepo,
  );
  if (result.outcome === 'promoted') {
    verifyPromotion(candidate, result.memoryId, deps, config.tenantId);
    setSelectedStatus(deps.candidateRepo, config.tenantId, candidate, 'promoted');
    hashes.add(computeContentHash(candidate.content));
  } else if (result.outcome === 'rejected' || result.outcome === 'duplicate') {
    setSelectedStatus(deps.candidateRepo, config.tenantId, candidate, result.outcome);
  }
  if (result.outcome === 'held' && findActiveHold(candidate.id, config.tenantId, deps) === null) {
    throw new Error('Selected hold or its canonical receipt was not persisted');
  }
  if (
    result.outcome === 'rejected' ||
    (result.outcome === 'flagged' && result.pipelineResult?.outcome === 'flagged')
  ) {
    if (
      !deps.auditRepo
        .findByMemoryAndTenant(candidate.id, config.tenantId)
        .some(
          (event) =>
            !priorIds.has(event.id) &&
            event.action === 'deleted' &&
            event.details['outcome'] === result.pipelineResult?.outcome,
        )
    ) {
      throw new Error('Selected rejection or flag receipt was not persisted');
    }
  }
  return {
    candidateId: candidate.id,
    outcome: result.outcome,
    ...(result.memoryId !== undefined ? { memoryId: result.memoryId } : {}),
  };
}

function parseReceiptOutcomes(
  value: unknown,
  bindings: readonly SelectedCandidateBinding[],
): SelectedOutcome[] {
  const malformed = (): never => {
    throw new Error('Selected governance receipt is malformed');
  };
  if (!Array.isArray(value) || value.length !== bindings.length) return malformed();
  const allowed = new Set(['promoted', 'rejected', 'flagged', 'duplicate', 'held', 'quarantined']);
  return value.map((item: unknown, index): SelectedOutcome => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return malformed();
    const row = item as Record<string, unknown>;
    if (
      row['candidateId'] !== bindings[index]?.candidateId ||
      typeof row['outcome'] !== 'string' ||
      !allowed.has(row['outcome'])
    )
      return malformed();
    if (row['outcome'] === 'promoted') {
      const parsed = Uuid.safeParse(row['memoryId']);
      if (!parsed.success) return malformed();
      return {
        candidateId: row['candidateId'] as string,
        outcome: 'promoted',
        memoryId: parsed.data,
      };
    }
    if (row['memoryId'] !== undefined) return malformed();
    return {
      candidateId: row['candidateId'] as string,
      outcome: row['outcome'] as SelectedOutcome['outcome'],
    };
  });
}
