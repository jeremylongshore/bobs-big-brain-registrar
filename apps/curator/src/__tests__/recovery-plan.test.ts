import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeContentHash, verifyOriginToken } from '@qmd-team-intent-kb/common';
import {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createDatabase,
} from '@qmd-team-intent-kb/store';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import { makeCandidate, makeMemory, makePolicy, TENANT } from './fixtures.js';
import { planMemoryRecovery, validateRecoveryPlan } from '../recovery/recovery-plan.js';
import type { RecoveryPlanInput } from '../recovery/recovery-plan.js';
import { memorySnapshotDigest } from '../recovery/source-archive.js';
import { prepareIntakeCandidate, intakeCandidate } from '../intake/candidate-intake.js';

let root: string;
let db: ReturnType<typeof createDatabase>;
let memories: MemoryRepository;
let candidates: CandidateRepository;
let input: RecoveryPlanInput;
let source: CuratedMemory;
let excluded: CuratedMemory;
function snapshot(): unknown {
  return Object.fromEntries(
    ['candidates', 'curated_memories', 'audit_events', 'memory_links', 'governance_policies'].map(
      (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  );
}
function bind(memory: CuratedMemory): { id: string; snapshotDigest: string } {
  return { id: memory.id, snapshotDigest: memorySnapshotDigest(memory) };
}
function replaceSource(overrides: Partial<CuratedMemory>): void {
  const next = makeMemory({
    ...source,
    id: randomUUID(),
    ...overrides,
    contentHash: overrides.contentHash ?? computeContentHash(overrides.content ?? source.content),
  });
  memories.insert(next);
  source = next;
  input.selections = [bind(source)];
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recovery-plan-'));
  db = createDatabase({ path: join(root, 'teamkb.db') });
  memories = new MemoryRepository(db);
  candidates = new CandidateRepository(db);
  new PolicyRepository(db).insert(makePolicy());
  source = makeMemory({
    tenantId: 'local',
    source: 'import',
    sensitivity: 'internal',
    trustLevel: 'high',
    title: 'Recovered orchard maintenance',
    content: 'Prune the orchard annually.',
    metadata: {
      filePaths: ['orchard.md'],
      tags: ['orchard'],
      subjects: ['orchard.maintenance'],
      audience: 'owner',
      proposedByRole: 'member',
    },
  });
  excluded = makeMemory({
    tenantId: 'local',
    title: 'Excluded tide calculation',
    content: 'Keep the tide note unchanged.',
  });
  memories.insert(source);
  memories.insert(excluded);
  const queued = makeCandidate({ content: 'Unrelated candidate for another review.' });
  candidates.insert(queued, computeContentHash(queued.content));
  input = {
    runId: randomUUID(),
    createdAt: '2026-10-26T03:50:00.000Z',
    storeLocator: join(root, 'teamkb.db'),
    sourceTenantId: 'local',
    targetTenantId: TENANT,
    selections: [bind(source)],
    exclusions: [bind(excluded)],
    actor: { type: 'human', id: 'fixture-operator' },
    role: 'owner',
    reason: 'Review a finite recovery.',
  };
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('finite read-only recovery planning', () => {
  it('binds complete source and fresh canonical proposal without any database writes', () => {
    const before = snapshot();
    const plan = planMemoryRecovery(input, db);
    expect(snapshot()).toEqual(before);
    expect(plan.entries[0]!.source).toEqual(source);
    expect(plan.exclusions).toEqual([bind(excluded)]);
    expect(plan.entries[0]).toMatchObject({
      minimumSensitivity: 'internal',
      proposal: {
        source: 'import',
        trustLevel: 'medium',
        author: input.actor,
        tenantId: TENANT,
        capturedAt: input.createdAt,
        metadata: { ...source.metadata, proposedByRole: 'admin' },
      },
    });
    expect(plan.entries[0]!.proposal.id).not.toBe(source.id);
    expect(plan.entries[0]!.proposal.id).not.toBe(source.candidateId);
    expect(plan.originMode).toBe('unattested');
    expect(plan.entries[0]!.proposal.origin).toBeUndefined();
    expect(planMemoryRecovery(input, db)).toEqual(plan);
    expect(validateRecoveryPlan(JSON.parse(JSON.stringify(plan)), plan.digest)).toEqual(plan);
    expect(validateRecoveryPlan(plan, plan.digest)).toEqual(plan);
  });
  it('also plans on a SQLite connection with writes explicitly disabled', () => {
    db.pragma('query_only = ON');
    expect(planMemoryRecovery(input, db).entries).toHaveLength(1);
    expect(db.pragma('query_only', { simple: true })).toBe(1);
  });
  it('prepares exactly the candidate that canonical intake stores, without writing during preparation', () => {
    const plan = planMemoryRecovery(input, db);
    const proposal = plan.entries[0]!.proposal;
    const ctx = { actor: input.actor.id, role: 'admin' as const, tenants: [TENANT] };
    const before = snapshot();
    expect(prepareIntakeCandidate(proposal, ctx)).toEqual(proposal);
    expect(snapshot()).toEqual(before);
    const result = intakeCandidate(proposal, db, ctx);
    expect(result.intake).toBe('created');
    expect(result.candidate).toEqual(proposal);
  });
  it('mints only a fresh identity-bound optional origin and serializes no secret', () => {
    const secret = 'fixture-origin-key';
    const before = snapshot();
    const plan = planMemoryRecovery(input, db, { origin: { secret, channel: 'local-mcp' } });
    const proposal = plan.entries[0]!.proposal;
    expect(
      verifyOriginToken(
        secret,
        { candidateId: proposal.id, tenantId: TENANT, capturedAt: input.createdAt },
        proposal.origin!.tokenHmac,
      ),
    ).toBe(true);
    expect(
      verifyOriginToken(
        secret,
        { candidateId: source.candidateId, tenantId: 'local', capturedAt: source.promotedAt },
        proposal.origin!.tokenHmac,
      ),
    ).toBe(false);
    expect(proposal.origin!.mintedAt).toBe(input.createdAt);
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(snapshot()).toEqual(before);
    expect(validateRecoveryPlan(plan, plan.digest)).toEqual(plan);
  });
  it.each(['untrusted', 'low', 'medium', 'high'] as const)(
    'never elevates %s source trust',
    (trustLevel) => {
      replaceSource({ trustLevel });
      const plan = planMemoryRecovery(input, db);
      expect(plan.entries[0]!.proposal.trustLevel).toBe(
        trustLevel === 'high' ? 'medium' : trustLevel,
      );
    },
  );
  it('retains bulk risk stamp and caps a legacy high-trust bulk row to low', () => {
    replaceSource({ source: 'bulk_import', trustLevel: 'high' });
    expect(planMemoryRecovery(input, db).entries[0]!.proposal).toMatchObject({
      source: 'bulk_import',
      trustLevel: 'low',
    });
  });
  it.each(['public', 'internal', 'confidential', 'restricted'] as const)(
    'binds %s source sensitivity without lowering it',
    (sensitivity) => {
      replaceSource({ sensitivity });
      expect(planMemoryRecovery(input, db).entries[0]!.minimumSensitivity).toBe(sensitivity);
    },
  );
  it('binds source, run and body to fresh proposal identities', () => {
    const first = planMemoryRecovery(input, db);
    expect(
      planMemoryRecovery({ ...input, runId: randomUUID() }, db).entries[0]!.proposal.id,
    ).not.toBe(first.entries[0]!.proposal.id);
    replaceSource({ content: 'The orchard requires a new pruning method.' });
    expect(planMemoryRecovery(input, db).entries[0]!.proposal.id).not.toBe(
      first.entries[0]!.proposal.id,
    );
  });
  it.each(['missing', 'foreign', 'nonactive', 'drift', 'hash'] as const)(
    'refuses %s sources with no writes',
    (kind) => {
      if (kind === 'missing') input.selections = [{ ...bind(source), id: randomUUID() }];
      if (kind === 'foreign') input.sourceTenantId = 'foreign';
      if (kind === 'nonactive') replaceSource({ lifecycle: 'archived' });
      if (kind === 'drift')
        input.selections = [{ ...bind(source), snapshotDigest: '0'.repeat(64) }];
      if (kind === 'hash') replaceSource({ contentHash: '0'.repeat(64) });
      const before = snapshot();
      expect(() => planMemoryRecovery(input, db)).toThrow();
      expect(snapshot()).toEqual(before);
    },
  );
  it.each(['missing', 'foreign', 'nonactive', 'drift'] as const)(
    'refuses %s exclusions',
    (kind) => {
      if (kind === 'missing') input.exclusions = [{ ...bind(excluded), id: randomUUID() }];
      if (kind === 'foreign') {
        const foreign = makeMemory({ tenantId: 'foreign' });
        memories.insert(foreign);
        input.exclusions = [bind(foreign)];
      }
      if (kind === 'nonactive') {
        const archived = makeMemory({ tenantId: 'local', lifecycle: 'archived' });
        memories.insert(archived);
        input.exclusions = [bind(archived)];
      }
      if (kind === 'drift')
        input.exclusions = [{ ...bind(excluded), snapshotDigest: '0'.repeat(64) }];
      const before = snapshot();
      expect(() => planMemoryRecovery(input, db)).toThrow();
      expect(snapshot()).toEqual(before);
    },
  );
  it.each(['empty', 'oversize', 'duplicate', 'overlap'] as const)(
    'refuses %s finite bindings',
    (kind) => {
      if (kind === 'empty') input.selections = [];
      if (kind === 'oversize') input.selections = Array.from({ length: 101 }, () => bind(source));
      if (kind === 'duplicate') input.selections = [bind(source), bind(source)];
      if (kind === 'overlap') input.exclusions = [bind(source)];
      expect(() => planMemoryRecovery(input, db)).toThrow();
    },
  );
  it.each(['machine', 'member', 'reason', 'same-tenant', 'locator', 'timestamp'] as const)(
    'refuses invalid %s authority or context',
    (kind) => {
      if (kind === 'machine') input.actor = { type: 'system', id: 'fixture' };
      if (kind === 'member') (input as unknown as { role: string }).role = 'member';
      if (kind === 'reason') input.reason = '  ';
      if (kind === 'same-tenant') input.targetTenantId = input.sourceTenantId;
      if (kind === 'locator') input.storeLocator = '/tmp/another-brain.db';
      if (kind === 'timestamp') input.createdAt = 'yesterday';
      expect(() => planMemoryRecovery(input, db)).toThrow();
    },
  );
  it('refuses a different real source audience without reclassifying the proposal', () => {
    input.role = 'admin';
    expect(() => planMemoryRecovery(input, db)).toThrow(/inaccessible/);
  });
  it.each(['id', 'hash', 'active-memory', 'archived-memory'] as const)(
    'refuses target %s conflicts without writes',
    (kind) => {
      const proposal = planMemoryRecovery(input, db).entries[0]!.proposal;
      if (kind === 'id') {
        const other = makeCandidate({ id: proposal.id });
        candidates.insert(other, computeContentHash(other.content));
      }
      if (kind === 'hash') {
        const other = makeCandidate({ content: source.content });
        candidates.insert(other, source.contentHash);
      }
      if (kind === 'active-memory' || kind === 'archived-memory')
        memories.insert(
          makeMemory({
            content: source.content,
            lifecycle: kind === 'archived-memory' ? 'archived' : 'active',
          }),
        );
      const before = snapshot();
      expect(() => planMemoryRecovery(input, db)).toThrow(/conflicts/);
      expect(snapshot()).toEqual(before);
    },
  );
  it('refuses duplicate selected content even when identities differ', () => {
    const duplicate = makeMemory({ ...source, id: randomUUID() });
    memories.insert(duplicate);
    input.selections = [bind(source), bind(duplicate)];
    expect(() => planMemoryRecovery(input, db)).toThrow(/conflicts/);
  });
  it.each(['title', 'subject'] as const)('refuses canonical target %s supersession', (kind) => {
    memories.insert(
      makeMemory({
        title: kind === 'title' ? source.title : 'Unrelated geometry lesson',
        metadata: {
          filePaths: [],
          tags: [],
          ...(kind === 'subject' ? { subjects: ['orchard.maintenance'] } : {}),
        },
      }),
    );
    expect(() => planMemoryRecovery(input, db)).toThrow(/supersession/);
  });
  it('refuses supersession between two selected proposals before either is captured', () => {
    const other = makeMemory({
      ...source,
      id: randomUUID(),
      content: 'Different orchard maintenance text.',
      contentHash: computeContentHash('Different orchard maintenance text.'),
    });
    memories.insert(other);
    input.selections = [bind(source), bind(other)];
    const before = snapshot();
    expect(() => planMemoryRecovery(input, db)).toThrow(/supersession/);
    expect(snapshot()).toEqual(before);
  });
  it('keeps import exclusions active instead of laundering old imports into manual captures', () => {
    replaceSource({ metadata: { filePaths: ['node_modules/orchard/index.js'], tags: [] } });
    expect(() => planMemoryRecovery(input, db)).toThrow(/import exclusion/);
  });
  it('reuses canonical structural disclosure checks on metadata', () => {
    // The repository refuses this field as well; test the pure boundary directly.
    const proposal = planMemoryRecovery(input, db).entries[0]!.proposal;
    expect(() =>
      prepareIntakeCandidate({
        ...proposal,
        metadata: { filePaths: [], tags: [], projectContext: 'Employee SSN is stored elsewhere' },
      }),
    ).toThrow(/disallowed/);
  });
  it('refuses unauthorized origin channels and empty supplied keys', () => {
    expect(() =>
      planMemoryRecovery(input, db, { origin: { secret: 'fixture', channel: 'invented' } }),
    ).toThrow(/channel/);
    expect(() =>
      planMemoryRecovery(input, db, { origin: { secret: '  ', channel: 'local-mcp' } }),
    ).toThrow(/secret/);
  });
  it('requires enabled target policy and binds changes to the plan digest', () => {
    const first = planMemoryRecovery(input, db);
    db.prepare('UPDATE governance_policies SET version = version + 1').run();
    expect(planMemoryRecovery(input, db).policySnapshotDigest).not.toBe(first.policySnapshotDigest);
    db.prepare('UPDATE governance_policies SET enabled = 0').run();
    expect(() => planMemoryRecovery(input, db)).toThrow(/policy/);
  });
  it.each([
    'source',
    'proposal',
    'floor',
    'exclusion',
    'policy',
    'actor',
    'locator',
    'digest',
    'unknown',
  ] as const)('rejects %s tampering against external review digest', (field) => {
    const plan = planMemoryRecovery(input, db);
    const changed = structuredClone(plan);
    if (field === 'source') changed.entries[0]!.source.metadata.tags.push('drift');
    if (field === 'proposal') changed.entries[0]!.proposal.source = 'manual';
    if (field === 'floor') changed.entries[0]!.minimumSensitivity = 'public';
    if (field === 'exclusion') changed.exclusions = [];
    if (field === 'policy') changed.policies[0]!.version++;
    if (field === 'actor') changed.actor.id = 'another-operator';
    if (field === 'locator') changed.storeLocator = '/tmp/another-brain.db';
    if (field === 'digest') changed.digest = '0'.repeat(64);
    if (field === 'unknown') Object.assign(changed, { secret: 'must-not-serialize' });
    expect(() => validateRecoveryPlan(changed, plan.digest)).toThrow();
  });
});
