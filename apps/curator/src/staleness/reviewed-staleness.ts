import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { deriveAuditEventId, isAudienceVisibleToRole } from '@qmd-team-intent-kb/common';
import { AuditEvent, CuratedMemory, IsoDatetime, Sha256Hash } from '@qmd-team-intent-kb/schema';
import { AuditRepository, MemoryRepository, verifyAuditChain } from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';

import { auditEventSnapshotDigest, memorySnapshotDigest } from '../recovery/source-archive.js';
import { detectStaleness } from './staleness-detector.js';
import { ESTATE_STALENESS_RULES } from './staleness-rules.js';
import type { StalenessRule, StalenessSource } from './staleness-rules.js';
import {
  parseReviewedStalenessManifest,
  readStoredMemory,
  reviewedStalenessDigest,
  stalenessDigest,
} from './reviewed-staleness-manifest.js';
import type {
  ReviewedStalenessManifest,
  ReviewedStalenessSelection,
  StoredMemoryRow,
} from './reviewed-staleness-manifest.js';

const RUN_KIND = 'reviewed-staleness-run-v1';
const TRANSITION_KIND = 'reviewed-staleness-transition-v1';

/** Trusted installation dependencies, never populated directly from a request. */
export interface ReviewedStalenessDependencies {
  /** Supplies already captured bytes, not arbitrary URL fetching. Missing bytes refuse. */
  sourceBytes: (source: StalenessSource) => Uint8Array | undefined;
  rules?: readonly StalenessRule[];
  now?: () => string;
}
export interface ReviewedStalenessResult {
  runReceiptId: string;
  transitionReceiptIds: string[];
  replay: boolean;
}
interface Context {
  manifest: ReviewedStalenessManifest;
  digest: string;
  connection: Database.Database;
  memories: MemoryRepository;
  audit: AuditRepository;
}
interface Witness {
  memory: CuratedMemory;
  raw: StoredMemoryRow;
  receipt: AuditEvent;
}

function strictChain(audit: AuditRepository): void {
  const result = verifyAuditChain(audit);
  if (result.breaks.length !== 0 || result.unverifiedRows !== 0) {
    throw new Error('Reviewed staleness requires a strictly verified audit chain');
  }
}

function receiptById(context: Context, memoryId: string, id: string): AuditEvent {
  const event = context.audit
    .findByMemoryAndTenant(memoryId, context.manifest.tenantId)
    .find((item) => item.id === id);
  if (event === undefined) throw new Error('Required staleness receipt is missing');
  return event;
}

function requireRule(
  selection: ReviewedStalenessSelection,
  deps: ReviewedStalenessDependencies,
): StalenessRule {
  const matches = (deps.rules ?? ESTATE_STALENESS_RULES).filter(
    (rule) => rule.id === selection.ruleId,
  );
  const rule = matches[0] === undefined ? undefined : structuredClone(matches[0]);
  if (
    matches.length !== 1 ||
    !rule ||
    stalenessDigest(rule) !== selection.ruleDigest ||
    rule.remedy !== 'retirement-review' ||
    !rule.exemptIfHistorical ||
    !rule.authority ||
    rule.authority.sources.length === 0
  ) {
    throw new Error('Missing, changed or ineligible staleness rule');
  }
  for (const source of rule.authority.sources) {
    if (
      !/^[a-f0-9]{40}$/.test(source.revision) ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !source.repository.trim() ||
      !source.path.trim() ||
      !source.locator.trim()
    ) {
      throw new Error('Malformed staleness source reference');
    }
    const bytes = deps.sourceBytes(structuredClone(source));
    if (
      !(bytes instanceof Uint8Array) ||
      createHash('sha256').update(bytes).digest('hex') !== source.sha256
    ) {
      throw new Error('Required staleness source bytes are unavailable or changed');
    }
  }
  return rule;
}

function currentMemory(context: Context, id: string): CuratedMemory {
  const memory = context.memories.findById(id);
  if (
    memory === null ||
    memory.tenantId !== context.manifest.tenantId ||
    !isAudienceVisibleToRole(memory.metadata.audience, context.manifest.role)
  ) {
    throw new Error('Selected memory is unavailable within reviewed authority');
  }
  return memory;
}

function priorDeprecation(context: Context, selection: ReviewedStalenessSelection): void {
  const binding = selection.deprecationReceipt;
  if (!binding) throw new Error('Reactivation requires its reviewed deprecation receipt');
  const event = receiptById(context, selection.memoryId, binding.id);
  if (
    auditEventSnapshotDigest(event) !== binding.snapshotDigest ||
    event.action !== 'demoted' ||
    event.details['kind'] !== TRANSITION_KIND ||
    event.details['operation'] !== 'deprecate' ||
    event.details['ruleId'] !== selection.ruleId ||
    event.details['ruleDigest'] !== selection.ruleDigest
  ) {
    throw new Error('Reactivation deprecation evidence differs from its review');
  }
  const runId = event.details['runId'];
  if (typeof runId !== 'string') throw new Error('Deprecation run identity is missing');
  const runs = context.audit
    .findByMemoryAndTenant(runId, context.manifest.tenantId)
    .filter((item) => item.details['kind'] === RUN_KIND);
  const outcomes = runs[0]?.details['outcomes'];
  if (
    runs.length !== 1 ||
    runs[0]?.action !== 'governed' ||
    runs[0].details['manifestDigest'] !== event.details['manifestDigest'] ||
    !Array.isArray(outcomes) ||
    !outcomes.some((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const value = item as Record<string, unknown>;
      return (
        value['memoryId'] === selection.memoryId &&
        value['receiptId'] === event.id &&
        value['receiptDigest'] === binding.snapshotDigest
      );
    })
  )
    throw new Error('Deprecation run settlement is missing or changed');
}

function reviewSelection(
  context: Context,
  selection: ReviewedStalenessSelection,
  rule: StalenessRule,
) {
  const memory = currentMemory(context, selection.memoryId);
  const raw = readStoredMemory(context.connection, memory.id);
  const from = context.manifest.operation === 'deprecate' ? 'active' : 'deprecated';
  if (
    memory.lifecycle !== from ||
    memorySnapshotDigest(memory) !== selection.snapshotDigest ||
    stalenessDigest(raw) !== selection.storedRowDigest
  ) {
    throw new Error('Selected memory is no longer its complete reviewed snapshot');
  }
  if (context.manifest.operation === 'reactivate') priorDeprecation(context, selection);
  else {
    const findings = detectStaleness(
      memory,
      [rule],
      [
        {
          memoryId: memory.id,
          ruleId: rule.id,
          scope: selection.scope,
          evidenceRef: selection.scopeEvidenceRef,
        },
      ],
    );
    if (findings.length !== 1 || findings[0]?.disposition !== 'retirement-candidate') {
      throw new Error('Reviewed selection is not a staleness retirement candidate');
    }
  }
  return { memory, raw };
}

function eventId(context: Context, memoryId: string, action: string): string {
  return deriveAuditEventId(
    memoryId,
    action,
    stalenessDigest({
      kind: TRANSITION_KIND,
      tenantId: context.manifest.tenantId,
      runId: context.manifest.runId,
      manifestDigest: context.digest,
    }),
  );
}

function buildTransition(
  context: Context,
  selection: ReviewedStalenessSelection,
  rule: StalenessRule,
  at: string,
  before: { memory: CuratedMemory; raw: StoredMemoryRow },
): Witness {
  const to = context.manifest.operation === 'deprecate' ? 'deprecated' : 'active';
  const action = to === 'deprecated' ? 'demoted' : 'promoted';
  const memory = CuratedMemory.parse({ ...before.memory, lifecycle: to, updatedAt: at });
  const raw = { ...before.raw, lifecycle: to, updated_at: at };
  const receipt = AuditEvent.parse({
    id: eventId(context, memory.id, action),
    action,
    memoryId: memory.id,
    tenantId: context.manifest.tenantId,
    actor: context.manifest.actor,
    reason: 'Reviewed staleness lifecycle change',
    timestamp: at,
    details: {
      kind: TRANSITION_KIND,
      operation: context.manifest.operation,
      runId: context.manifest.runId,
      manifestDigest: context.digest,
      ruleId: rule.id,
      ruleDigest: selection.ruleDigest,
      sourceDigests: rule.authority!.sources.map((source) => stalenessDigest(source)),
      scopeDigest: stalenessDigest({
        scope: selection.scope,
        evidenceRef: selection.scopeEvidenceRef,
      }),
      reviewReasonDigest: stalenessDigest(context.manifest.reason),
      beforeUpdatedAt: before.memory.updatedAt,
      from: before.memory.lifecycle,
      to,
      beforeDigest: selection.snapshotDigest,
      storedBeforeDigest: selection.storedRowDigest,
      afterDigest: memorySnapshotDigest(memory),
      storedAfterDigest: stalenessDigest(raw),
      ...(selection.deprecationReceipt ? { deprecationReceipt: selection.deprecationReceipt } : {}),
    },
  });
  return { memory, raw, receipt };
}

function transition(
  context: Context,
  selection: ReviewedStalenessSelection,
  rule: StalenessRule,
  at: string,
): Witness {
  const witness = buildTransition(
    context,
    selection,
    rule,
    at,
    reviewSelection(context, selection, rule),
  );
  if (!context.memories.updateLifecycle(witness.memory.id, witness.memory.lifecycle, at)) {
    throw new Error('Lifecycle write was not persisted');
  }
  context.audit.insert(witness.receipt);
  return witness;
}

function verifyWitness(context: Context, witness: Witness): void {
  if (
    !isDeepStrictEqual(currentMemory(context, witness.memory.id), witness.memory) ||
    !isDeepStrictEqual(readStoredMemory(context.connection, witness.memory.id), witness.raw) ||
    !isDeepStrictEqual(receiptById(context, witness.memory.id, witness.receipt.id), witness.receipt)
  ) {
    throw new Error('Staleness state or receipt changed during settlement');
  }
}

function runReceipt(context: Context, at: string, witnesses: readonly Witness[]): AuditEvent {
  return AuditEvent.parse({
    id: eventId(context, context.manifest.runId, 'governed'),
    action: 'governed',
    memoryId: context.manifest.runId,
    tenantId: context.manifest.tenantId,
    actor: context.manifest.actor,
    reason: 'Reviewed finite staleness settlement',
    timestamp: at,
    details: {
      kind: RUN_KIND,
      manifestDigest: context.digest,
      operation: context.manifest.operation,
      reviewedAt: context.manifest.reviewedAt,
      role: context.manifest.role,
      reviewReasonDigest: stalenessDigest(context.manifest.reason),
      outcomes: witnesses.map((item) => ({
        memoryId: item.memory.id,
        receiptId: item.receipt.id,
        receiptDigest: auditEventSnapshotDigest(item.receipt),
      })),
    },
  });
}

function replayWitness(
  context: Context,
  selection: ReviewedStalenessSelection,
  rule: StalenessRule,
  at: string,
): Witness {
  const memory = currentMemory(context, selection.memoryId);
  const raw = readStoredMemory(context.connection, memory.id);
  const deprecating = context.manifest.operation === 'deprecate';
  const receipt = receiptById(
    context,
    memory.id,
    eventId(context, memory.id, deprecating ? 'demoted' : 'promoted'),
  );
  const beforeUpdatedAt = receipt.details['beforeUpdatedAt'];
  if (
    typeof beforeUpdatedAt !== 'string' ||
    memory.lifecycle !== (deprecating ? 'deprecated' : 'active')
  ) {
    throw new Error('Staleness replay has changed lifecycle or receipt');
  }
  const before = {
    memory: CuratedMemory.parse({
      ...memory,
      lifecycle: deprecating ? 'active' : 'deprecated',
      updatedAt: beforeUpdatedAt,
    }),
    raw: { ...raw, lifecycle: deprecating ? 'active' : 'deprecated', updated_at: beforeUpdatedAt },
  };
  if (
    memorySnapshotDigest(before.memory) !== selection.snapshotDigest ||
    stalenessDigest(before.raw) !== selection.storedRowDigest
  ) {
    throw new Error('Staleness replay has changed reviewed content or metadata');
  }
  if (!deprecating) priorDeprecation(context, selection);
  const witness = buildTransition(context, selection, rule, at, before);
  verifyWitness(context, witness);
  return witness;
}

function previousRun(
  context: Context,
  rules: readonly StalenessRule[],
): ReviewedStalenessResult | undefined {
  const runs = context.audit
    .findByMemoryAndTenant(context.manifest.runId, context.manifest.tenantId)
    .filter((event) => event.details['kind'] === RUN_KIND);
  if (runs.length === 0) return undefined;
  if (runs.length !== 1 || runs[0]?.details['manifestDigest'] !== context.digest) {
    throw new Error('Staleness run has a different reviewed manifest');
  }
  const previous = runs[0];
  const witnesses = context.manifest.selections.map((selection, index) =>
    replayWitness(context, selection, rules[index]!, previous.timestamp),
  );
  if (!isDeepStrictEqual(runReceipt(context, previous.timestamp, witnesses), previous)) {
    throw new Error('Staleness replay run receipt differs');
  }
  return {
    runReceiptId: previous.id,
    transitionReceiptIds: witnesses.map((item) => item.receipt.id),
    replay: true,
  };
}

/**
 * Trusted synchronous source core, not a public endpoint or an authorization service.
 * Caller authenticates the reviewer, authorizes current policy/exact selection,
 * supplies the independent digest, takes the physical brain write lock, and owns
 * subsequent anchoring/export/index refresh. No source content is persisted.
 * Strict audit preflight accepts no fork exceptions or historical rehashing.
 */
export function settleReviewedStaleness(
  value: unknown,
  expectedDigest: string,
  connection: Database.Database,
  deps: ReviewedStalenessDependencies,
): ReviewedStalenessResult {
  if (connection.inTransaction) {
    throw new Error('Reviewed staleness cannot settle inside an existing transaction');
  }
  const manifest = parseReviewedStalenessManifest(value);
  Sha256Hash.parse(expectedDigest);
  const digest = reviewedStalenessDigest(manifest);
  if (digest !== expectedDigest)
    throw new Error('Staleness manifest differs from independent review digest');
  const context: Context = {
    manifest,
    digest,
    connection,
    memories: new MemoryRepository(connection),
    audit: new AuditRepository(connection),
  };
  return connection
    .transaction(() => {
      strictChain(context.audit);
      const rules = manifest.selections.map((item) => requireRule(item, deps));
      const replay = previousRun(context, rules);
      if (replay) return replay;
      // Validate the complete selection before any state change.
      manifest.selections.forEach((item, index) => reviewSelection(context, item, rules[index]!));
      const at = IsoDatetime.parse((deps.now ?? (() => new Date().toISOString()))());
      if (Date.parse(at) < Date.parse(manifest.reviewedAt))
        throw new Error('Review timestamp is later than execution');
      const witnesses = manifest.selections.map((item, index) =>
        transition(context, item, rules[index]!, at),
      );
      const receipt = runReceipt(context, at, witnesses);
      context.audit.insert(receipt);
      witnesses.forEach((item) => verifyWitness(context, item));
      if (!isDeepStrictEqual(receiptById(context, manifest.runId, receipt.id), receipt)) {
        throw new Error('Staleness run receipt was not persisted');
      }
      strictChain(context.audit);
      return {
        runReceiptId: receipt.id,
        transitionReceiptIds: witnesses.map((item) => item.receipt.id),
        replay: false,
      };
    })
    .immediate();
}
