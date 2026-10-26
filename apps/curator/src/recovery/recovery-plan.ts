import { isAbsolute, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import {
  computeContentHash,
  deriveCandidateId,
  isAudienceVisibleToRole,
  mintOriginToken,
} from '@qmd-team-intent-kb/common';
import {
  Author,
  CuratedMemory,
  GovernancePolicy,
  IsoDatetime,
  MemoryCandidate,
  Sha256Hash,
  TenantId,
  Uuid,
} from '@qmd-team-intent-kb/schema';
import { CandidateRepository, MemoryRepository, PolicyRepository } from '@qmd-team-intent-kb/store';
import { planSupersession } from '@qmd-team-intent-kb/policy-engine';
import {
  DEFAULT_ALLOWED_ORIGIN_CHANNELS,
  prepareIntakeCandidate,
} from '../intake/candidate-intake.js';
import { DEFAULT_BRAINIGNORE_RULESET } from '../import-exclusion/brainignore.js';
import { checkImportExclusion } from '../import-exclusion/import-exclusion-gate.js';
import { candidateSnapshotDigest } from './selected-governance.js';
import { memorySnapshotDigest } from './source-archive.js';
import type { RecoverySnapshotBinding } from './source-archive.js';

export interface RecoveryPlanInput {
  runId: string;
  /** Proposal creation time, supplied explicitly; never an old capture timestamp. */
  createdAt: string;
  /** Reviewed SQLite locator. A path alone is not live execution authority. */
  storeLocator: string;
  sourceTenantId: string;
  targetTenantId: string;
  selections: readonly RecoverySnapshotBinding[];
  exclusions: readonly RecoverySnapshotBinding[];
  /** Caller establishes actual identity and standing in BOTH tenants. */
  actor: Author;
  role: 'admin' | 'owner';
  reason: string;
}

export interface RecoveryPlanOptions {
  allowedOriginChannels?: readonly string[];
  /** Explicit in-memory key only; no environment/key-file reads or writes. */
  origin?: { secret: string; channel: string };
}

export interface RecoveryPlanEntry {
  source: CuratedMemory;
  sourceSnapshotDigest: string;
  proposal: MemoryCandidate;
  candidateSnapshotDigest: string;
  minimumSensitivity: CuratedMemory['sensitivity'];
}

/** Private review artifact: contains original source text and optional origin tokens. */
export interface RecoveryPlan extends Omit<RecoveryPlanInput, 'selections' | 'exclusions'> {
  schemaVersion: 1;
  exclusions: RecoverySnapshotBinding[];
  entries: RecoveryPlanEntry[];
  policies: GovernancePolicy[];
  policySnapshotDigest: string;
  allowedOriginChannels: string[];
  originMode: 'unattested' | 'fresh';
  /** Only committed defaults are preflighted here; apply must check its actual rules. */
  defaultImportRulesDigest: string;
  digest: string;
}

function digest(value: unknown): string {
  return computeContentHash(
    JSON.stringify(value, (_key: string, item: unknown): unknown => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        return Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      }
      return item;
    }),
  );
}

function importRulesDigest(): string {
  return digest(
    DEFAULT_BRAINIGNORE_RULESET.patterns.map(({ regex, ...pattern }) => ({
      ...pattern,
      regexSource: regex.source,
      regexFlags: regex.flags,
    })),
  );
}

function requireAuthority(input: Omit<RecoveryPlanInput, 'selections' | 'exclusions'>): void {
  Uuid.parse(input.runId);
  IsoDatetime.parse(input.createdAt);
  TenantId.parse(input.sourceTenantId);
  TenantId.parse(input.targetTenantId);
  Author.parse(input.actor);
  if (
    input.actor.type !== 'human' ||
    input.actor.id.trim() === '' ||
    !['admin', 'owner'].includes(input.role) ||
    typeof input.reason !== 'string' ||
    input.reason.trim() === '' ||
    input.sourceTenantId === input.targetTenantId
  ) {
    throw new Error(
      'Recovery plan requires distinct tenants and declared human admin/owner authority and reason',
    );
  }
  if (
    typeof input.storeLocator !== 'string' ||
    (input.storeLocator !== ':memory:' &&
      (!isAbsolute(input.storeLocator) || normalize(input.storeLocator) !== input.storeLocator))
  ) {
    throw new Error('Recovery plan requires an explicit normalized absolute store locator');
  }
}

function requireBindings(
  selections: readonly RecoverySnapshotBinding[],
  exclusions: readonly RecoverySnapshotBinding[],
): void {
  if (
    !Array.isArray(selections) ||
    selections.length < 1 ||
    selections.length > 100 ||
    !Array.isArray(exclusions) ||
    exclusions.length > 100
  ) {
    throw new Error(
      'Recovery plan requires one to one hundred selections and at most one hundred exclusions',
    );
  }
  const ids = new Set<string>();
  for (const binding of [...selections, ...exclusions]) {
    Uuid.parse(binding.id);
    Sha256Hash.parse(binding.snapshotDigest);
    if (ids.has(binding.id)) throw new Error('Duplicate or overlapping recovery binding');
    ids.add(binding.id);
  }
}

function requireSource(
  source: CuratedMemory,
  binding: RecoverySnapshotBinding,
  input: Pick<RecoveryPlanInput, 'sourceTenantId' | 'role'>,
): void {
  if (
    source.id !== binding.id ||
    source.tenantId !== input.sourceTenantId ||
    source.lifecycle !== 'active' ||
    source.contentHash !== computeContentHash(source.content) ||
    memorySnapshotDigest(source) !== binding.snapshotDigest ||
    !isAudienceVisibleToRole(source.metadata.audience, input.role)
  ) {
    throw new Error('Recovery source or exclusion is foreign, nonactive, inaccessible or changed');
  }
}

function proposalFor(
  source: CuratedMemory,
  input: Omit<RecoveryPlanInput, 'selections' | 'exclusions'>,
  allowedChannels: readonly string[],
  origin?: MemoryCandidate['origin'],
): MemoryCandidate {
  const levels = ['untrusted', 'low', 'medium', 'high'] as const;
  const ceiling = source.source === 'bulk_import' ? 1 : 2;
  const trustLevel = levels[Math.min(levels.indexOf(source.trustLevel), ceiling)]!;
  const id = deriveCandidateId(
    `recovery-${input.runId}`,
    JSON.stringify({
      sourceId: source.id,
      sourceTenantId: input.sourceTenantId,
      targetTenantId: input.targetTenantId,
    }),
    source.contentHash,
  );
  return prepareIntakeCandidate(
    {
      schemaVersion: '1',
      id,
      status: 'inbox',
      source: source.source,
      content: source.content,
      title: source.title,
      category: source.category,
      trustLevel,
      author: input.actor,
      tenantId: input.targetTenantId,
      metadata: source.metadata,
      prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
      capturedAt: input.createdAt,
      ...(origin === undefined ? {} : { origin }),
    },
    { actor: input.actor.id, role: 'admin', tenants: [input.targetTenantId] },
    allowedChannels,
  );
}

function requireNoSupersession(
  proposal: MemoryCandidate,
  active: ReturnType<MemoryRepository['findByTenantAndLifecycle']>,
  earlier: MemoryCandidate[],
): void {
  const plan = planSupersession(proposal, {
    findByTenantAndLifecycle: () => [
      ...active,
      ...earlier.map((item) => ({ ...item, promotedAt: item.capturedAt })),
    ],
  });
  if (plan.blocked !== undefined || plan.matches.length > 0) {
    throw new Error('Recovery plan refuses canonical supersession conflicts');
  }
}

/**
 * Read-only finite planning on one consistent SQLite snapshot. No secret loaders,
 * intake writes, governance, whole-inbox/spool sweep, archival or filesystem lock.
 * A successful plan is not admission. Apply must recheck its frozen bindings under
 * the actual brain lock, run canonical gates, and verify current targets separately.
 */
export function planMemoryRecovery(
  input: RecoveryPlanInput,
  connection: Database.Database,
  options: RecoveryPlanOptions = {},
): RecoveryPlan {
  requireAuthority(input);
  requireBindings(input.selections, input.exclusions);
  const allowedOriginChannels = [
    ...(options.allowedOriginChannels ?? DEFAULT_ALLOWED_ORIGIN_CHANNELS),
  ];
  if (allowedOriginChannels.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error('Invalid recovery origin allowlist');
  }
  if (
    options.origin !== undefined &&
    (typeof options.origin.secret !== 'string' || options.origin.secret.trim() === '')
  ) {
    throw new Error('Recovery origin requires an explicitly supplied nonempty secret');
  }
  return connection
    .transaction((): RecoveryPlan => {
      const main = connection.pragma('database_list') as { name: string; file: string }[];
      const actualLocator = main.find((item) => item.name === 'main')?.file || ':memory:';
      if (actualLocator !== input.storeLocator)
        throw new Error('Recovery store locator does not match connection');
      const memories = new MemoryRepository(connection);
      const candidates = new CandidateRepository(connection);
      const policies = new PolicyRepository(connection).findByTenant(input.targetTenantId);
      if (!policies.some((policy) => policy.enabled))
        throw new Error('Recovery requires existing enabled target policy');
      for (const binding of input.exclusions) {
        const source = memories.findById(binding.id);
        if (source === null) throw new Error('Recovery exclusion is missing');
        requireSource(source, binding, input);
      }
      const active = memories.findByTenantAndLifecycle(input.targetTenantId, 'active');
      const earlier: MemoryCandidate[] = [];
      const hashes = new Set<string>();
      const entries = input.selections.map((binding): RecoveryPlanEntry => {
        const source = memories.findById(binding.id);
        if (source === null) throw new Error('Recovery source is missing');
        requireSource(source, binding, input);
        let proposal = proposalFor(source, input, allowedOriginChannels);
        if (options.origin !== undefined) {
          proposal = proposalFor(source, input, allowedOriginChannels, {
            channel: options.origin.channel,
            mintedAt: input.createdAt,
            tokenHmac: mintOriginToken(options.origin.secret, {
              candidateId: proposal.id,
              tenantId: proposal.tenantId,
              capturedAt: proposal.capturedAt,
            }),
          });
        }
        if (
          hashes.has(source.contentHash) ||
          candidates.findById(proposal.id) !== null ||
          candidates.findByContentHashAndTenant(source.contentHash, input.targetTenantId) !==
            null ||
          memories.findByContentHashAndTenant(source.contentHash, input.targetTenantId) !== null
        ) {
          throw new Error(
            'Recovery candidate identity or target content conflicts; reuse an existing frozen plan for retry',
          );
        }
        if (candidates.isRedactedContent(proposal.content, proposal.tenantId)) {
          throw new Error('Recovery refuses redacted target content');
        }
        if (checkImportExclusion(proposal).verdict === 'rejected') {
          throw new Error('Recovery refuses default import exclusion');
        }
        requireNoSupersession(proposal, active, earlier);
        hashes.add(source.contentHash);
        earlier.push(proposal);
        return {
          source,
          sourceSnapshotDigest: binding.snapshotDigest,
          proposal,
          candidateSnapshotDigest: candidateSnapshotDigest(proposal),
          minimumSensitivity: source.sensitivity,
        };
      });
      const plan = {
        schemaVersion: 1 as const,
        runId: input.runId,
        createdAt: input.createdAt,
        storeLocator: input.storeLocator,
        sourceTenantId: input.sourceTenantId,
        targetTenantId: input.targetTenantId,
        actor: Author.parse(input.actor),
        role: input.role,
        reason: input.reason,
        exclusions: input.exclusions.map((binding) => ({
          id: binding.id,
          snapshotDigest: binding.snapshotDigest,
        })),
        entries,
        policies,
        policySnapshotDigest: digest(policies),
        allowedOriginChannels,
        originMode: options.origin === undefined ? ('unattested' as const) : ('fresh' as const),
        defaultImportRulesDigest: importRulesDigest(),
      };
      // Plans are JSON artifacts: remove optional undefined repository fields so
      // in-memory and serialized validation have exactly the same representation.
      return JSON.parse(JSON.stringify({ ...plan, digest: digest(plan) })) as RecoveryPlan;
    })
    .deferred();
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  ) {
    throw new Error('Invalid recovery plan object fields');
  }
  return value as Record<string, unknown>;
}

/**
 * Parse a private plan against a separately reviewed expected digest. A self-
 * supplied digest alone is not authority; neither is this a signature. This does
 * not recheck current database state, validate a HMAC key or authorize live apply.
 */
export function validateRecoveryPlan(data: unknown, expectedDigest: string): RecoveryPlan {
  Sha256Hash.parse(expectedDigest);
  const raw = record(data, [
    'schemaVersion',
    'runId',
    'createdAt',
    'storeLocator',
    'sourceTenantId',
    'targetTenantId',
    'actor',
    'role',
    'reason',
    'exclusions',
    'entries',
    'policies',
    'policySnapshotDigest',
    'allowedOriginChannels',
    'originMode',
    'defaultImportRulesDigest',
    'digest',
  ]);
  const { digest: suppliedDigest, ...payload } = raw;
  if (
    suppliedDigest !== expectedDigest ||
    digest(payload) !== expectedDigest ||
    raw['schemaVersion'] !== 1
  ) {
    throw new Error('Recovery plan differs from externally reviewed digest or version');
  }
  // Primitive authority fields are validated below; nested domain records use
  // the same schema normalization as the repositories and intake boundary.
  const plan = JSON.parse(JSON.stringify(raw)) as RecoveryPlan;
  requireAuthority(plan);
  if (
    !Array.isArray(plan.entries) ||
    !Array.isArray(plan.policies) ||
    !Array.isArray(plan.allowedOriginChannels) ||
    plan.allowedOriginChannels.some((item) => typeof item !== 'string' || item.trim() === '') ||
    !['fresh', 'unattested'].includes(plan.originMode)
  )
    throw new Error('Invalid recovery plan arrays or origin mode');
  plan.exclusions = plan.exclusions.map((binding) => {
    record(binding, ['id', 'snapshotDigest']);
    return { id: Uuid.parse(binding.id), snapshotDigest: Sha256Hash.parse(binding.snapshotDigest) };
  });
  const bindings: RecoverySnapshotBinding[] = [];
  const hashes = new Set<string>();
  plan.entries = plan.entries.map((entry) => {
    record(entry, [
      'source',
      'sourceSnapshotDigest',
      'proposal',
      'candidateSnapshotDigest',
      'minimumSensitivity',
    ]);
    const source = CuratedMemory.parse(entry.source);
    const proposal = MemoryCandidate.parse(entry.proposal);
    const binding = { id: source.id, snapshotDigest: Sha256Hash.parse(entry.sourceSnapshotDigest) };
    requireSource(source, binding, plan);
    bindings.push(binding);
    const origin = proposal.origin;
    if (
      (plan.originMode === 'fresh') !== (origin !== undefined) ||
      (origin !== undefined && origin.mintedAt !== plan.createdAt) ||
      entry.minimumSensitivity !== source.sensitivity ||
      hashes.has(source.contentHash) ||
      candidateSnapshotDigest(proposal) !== Sha256Hash.parse(entry.candidateSnapshotDigest) ||
      !isDeepStrictEqual(proposal, proposalFor(source, plan, plan.allowedOriginChannels, origin))
    ) {
      throw new Error(
        'Recovery proposal does not match reviewed source, authority, origin or sensitivity',
      );
    }
    hashes.add(source.contentHash);
    return { ...entry, source, proposal };
  });
  requireBindings(bindings, plan.exclusions);
  plan.policies = plan.policies.map((policy) => GovernancePolicy.parse(policy));
  if (
    !plan.policies.some((policy) => policy.enabled) ||
    plan.policies.some((policy) => policy.tenantId !== plan.targetTenantId) ||
    plan.policySnapshotDigest !== digest(plan.policies) ||
    plan.defaultImportRulesDigest !== importRulesDigest()
  )
    throw new Error('Recovery policy or default import rules snapshot differs');
  // Reject normalization drift rather than returning a differently hashed plan.
  if (!isDeepStrictEqual(plan, raw)) throw new Error('Recovery plan is not schema-normalized');
  return plan;
}
