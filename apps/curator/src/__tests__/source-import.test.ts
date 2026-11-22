import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeContentHash, deriveMemoryId } from '@qmd-team-intent-kb/common';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createTestDatabase,
  generateActorKeypair,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { makeMemory, makePolicy, TENANT } from './fixtures.js';
import { exportSourceSnapshot } from '../merge/source-snapshot.js';
import { SignedSourceSnapshot } from '../merge/source-snapshot-schema.js';
import type { TrustedSourceCheckpoint } from '../merge/source-snapshot-schema.js';
import { previewSourceImport, applySourceImport } from '../merge/source-import.js';
import type { SourceImportContext } from '../merge/source-import-schema.js';
import { importCandidate } from '../merge/source-import-groups.js';
import {
  recordCandidateMinimumSensitivity,
  resolveCandidateMinimumSensitivity,
} from '../recovery/sensitivity-constraint.js';
import { resolveHold } from '../hold/resolve-hold.js';
import {
  candidateSnapshotDigest,
  governSelectedCandidates,
} from '../recovery/selected-governance.js';
import { promote } from '../promotion/promoter.js';

const now = Date.parse('2026-11-22T12:00:00.000Z');
const issuedAt = '2026-11-22T00:00:00.000Z';
const expiresAt = '2026-11-23T00:00:00.000Z';
const destination = 'destination';
function row(extra: Parameters<typeof makeMemory>[0] = {}) {
  const candidateId = randomUUID();
  const content = 'A synthetic convention about formatting documentation.';
  const contentHash = computeContentHash(content);
  return makeMemory({
    candidateId,
    content,
    contentHash,
    id: deriveMemoryId(candidateId, contentHash),
    sensitivity: 'public',
    ...extra,
  });
}
function source(memories = [row()], sourceId = 'source', sequence = 1) {
  const db = createTestDatabase();
  const keys = generateActorKeypair();
  try {
    const repo = new MemoryRepository(db);
    for (const memory of memories) repo.insert(memory);
    const raw = exportSourceSnapshot(
      db,
      {
        sourceId,
        sourceTenantId: TENANT,
        destinationTenantId: destination,
        sequence,
        issuedAt,
        expiresAt,
      },
      keys.privateKeyHex,
    );
    const snapshot = SignedSourceSnapshot.parse(JSON.parse(raw));
    const checkpoint: TrustedSourceCheckpoint = {
      sourceId,
      sourceTenantId: TENANT,
      destinationTenantId: destination,
      sequence,
      keyId: snapshot.payload.keyId,
      publicKeyHex: keys.publicKeyHex,
      snapshotDigest: snapshot.digest,
      validFrom: issuedAt,
      validUntil: expiresAt,
      revoked: false,
    };
    return { raw, checkpoint, snapshot };
  } finally {
    db.close();
  }
}
let db: ReturnType<typeof createTestDatabase>;
let deps: { memoryRepo: MemoryRepository; auditRepo: AuditRepository };
let pins: TrustedSourceCheckpoint[];
let context: SourceImportContext;
const fingerprint = () => createHash('sha256').update(db.serialize()).digest('hex');
beforeEach(() => {
  db = createTestDatabase();
  deps = { memoryRepo: new MemoryRepository(db), auditRepo: new AuditRepository(db) };
  pins = [];
  context = { tenantId: destination, loadCheckpoints: () => pins, now: () => now };
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});
function prepare(...sources: ReturnType<typeof source>[]) {
  pins = sources.map((s) => s.checkpoint);
  const artifacts = sources.map((s) => s.raw);
  return { artifacts, ...previewSourceImport(artifacts, deps, context) };
}
function apply(preview: ReturnType<typeof prepare>) {
  return applySourceImport(preview.plan, preview.artifacts, deps, context);
}
function strongerFloor(candidate: ReturnType<typeof importCandidate>) {
  recordCandidateMinimumSensitivity(
    candidate,
    'restricted',
    {
      runId: randomUUID(),
      manifestDigest: 'a'.repeat(64),
      candidateSnapshotDigest: 'b'.repeat(64),
      actor: { type: 'human', id: 'synthetic-owner' },
      role: 'owner',
      reason: 'Synthetic review',
    },
    deps.auditRepo,
  );
}

describe('transactional verified source import', () => {
  it('previews without writes and stores the effective floor, audience and canonical receipt without optional policy', () => {
    const memory = row({
      sensitivity: 'confidential',
      metadata: { filePaths: [], tags: [], audience: 'owner' },
    });
    const before = fingerprint();
    const preview = prepare(source([memory]));
    expect(fingerprint()).toBe(before);
    const result = apply(preview);
    expect(result.outcomes[0]).toMatchObject({ status: 'promoted', sensitivity: 'confidential' });
    const stored = deps.memoryRepo.findById(result.outcomes[0]!.memoryId)!;
    expect(stored.sensitivity).toBe('confidential');
    expect(stored.metadata.audience).toBe('owner');
    expect(
      resolveCandidateMinimumSensitivity(importCandidate(memory, destination), deps.auditRepo),
    ).toBe('confidential');
    expect(
      deps.auditRepo
        .findByMemoryAndTenant(stored.id, destination)
        .find((e) => e.action === 'promoted')?.details['sensitivityConstraint'],
    ).toEqual({ classified: 'public', minimum: 'confidential', effective: 'confidential' });
    expect(verifyAuditChain(deps.auditRepo)).toMatchObject({ breaks: [], unverifiedRows: 0 });
  });
  it('is independent of source order and retains the strongest floor for every duplicate alias', () => {
    const first = row();
    const second = row({ sensitivity: 'restricted' });
    const a = source([first], 'a');
    const b = source([second], 'b');
    const preview = prepare(a, b);
    const reversed = previewSourceImport([b.raw, a.raw], deps, context);
    expect(reversed).toEqual({
      plan: preview.plan,
      outcomes: preview.outcomes,
      alreadyApplied: false,
    });
    const result = apply(preview);
    expect(result.outcomes.map((o) => o.status).sort()).toEqual(['deduplicated', 'promoted']);
    const reversedDb = createTestDatabase();
    try {
      const reversedDeps = {
        memoryRepo: new MemoryRepository(reversedDb),
        auditRepo: new AuditRepository(reversedDb),
      };
      expect(applySourceImport(reversed.plan, [b.raw, a.raw], reversedDeps, context)).toEqual(
        result,
      );
      expect(reversedDeps.memoryRepo.findByTenant(destination)).toEqual(
        deps.memoryRepo.findByTenant(destination),
      );
      expect(reversedDeps.auditRepo.findAllChronological()).toEqual(
        deps.auditRepo.findAllChronological(),
      );
    } finally {
      reversedDb.close();
    }

    expect(deps.memoryRepo.findByTenant(destination)).toHaveLength(1);
    for (const memory of [first, second])
      expect(
        resolveCandidateMinimumSensitivity(importCandidate(memory, destination), deps.auditRepo),
      ).toBe('restricted');
  });
  it('tightens existing aliases while preserving archived lifecycle and owner audience', () => {
    const incoming = row({
      sensitivity: 'confidential',
      metadata: { filePaths: [], tags: [], audience: 'owner' },
    });
    const existing = row({
      tenantId: destination,
      lifecycle: 'archived',
      metadata: incoming.metadata,
    });
    deps.memoryRepo.insert(existing);
    const result = apply(prepare(source([incoming])));
    expect(result.outcomes[0]!.status).toBe('existing');
    expect(deps.memoryRepo.findById(existing.id)).toMatchObject({
      sensitivity: 'confidential',
      lifecycle: 'archived',
      metadata: incoming.metadata,
      version: existing.version + 1,
    });
    expect(
      resolveCandidateMinimumSensitivity(importCandidate(existing, destination), deps.auditRepo),
    ).toBe('confidential');
  });
  it('retains the stronger destination restriction', () => {
    const existing = row({ tenantId: destination, sensitivity: 'restricted' });
    deps.memoryRepo.insert(existing);
    const result = apply(prepare(source()));
    expect(result.outcomes[0]!.sensitivity).toBe('restricted');
    expect(deps.memoryRepo.findById(existing.id)!.sensitivity).toBe('restricted');
  });
  it.each(['title', 'metadata'] as const)(
    'refuses conflicting %s instead of deduplicating away provenance',
    (field) => {
      const incoming = row();
      const existing = row({
        tenantId: destination,
        ...(field === 'title'
          ? { title: 'Different provenance' }
          : { metadata: { filePaths: [], tags: [], audience: 'owner' } }),
      });
      deps.memoryRepo.insert(existing);
      const before = fingerprint();
      expect(() => prepare(source([incoming]))).toThrow();
      expect(fingerprint()).toBe(before);
    },
  );
  it.each(['foreign-tenant', 'different-content'])(
    'refuses an inbox identity collision: %s',
    (kind) => {
      const incoming = row();
      const candidate = importCandidate(
        incoming,
        kind === 'foreign-tenant' ? 'foreign' : destination,
      );
      if (kind === 'different-content') candidate.content = 'Different synthetic content';
      new CandidateRepository(db).insert(candidate, computeContentHash(candidate.content));
      const before = fingerprint();
      expect(() => prepare(source([incoming]))).toThrow();
      expect(fingerprint()).toBe(before);
    },
  );
  it('refuses a stale destination plan', () => {
    const preview = prepare(source());
    deps.memoryRepo.insert(row({ tenantId: destination }));
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('refuses an outer transaction rather than reporting uncommitted success', () => {
    const preview = prepare(source());
    const before = fingerprint();
    db.transaction(() => {
      expect(() => apply(preview)).toThrow();
    }).deferred();
    expect(fingerprint()).toBe(before);
  });
  it.each(['before', 'during'])(
    'refuses revoked authority %s apply and rolls back all writes',
    (when) => {
      const preview = prepare(source());
      let loads = 0;
      context.loadCheckpoints = () => {
        loads++;
        return pins.map((p) => ({ ...p, revoked: when === 'before' || loads > 1 }));
      };
      const before = fingerprint();
      expect(() => apply(preview)).toThrow();
      expect(fingerprint()).toBe(before);
    },
  );
  it('rolls back if authority expires before settlement', () => {
    const preview = prepare(source());
    let calls = 0;
    context.now = () => (++calls < 3 ? now : Date.parse(expiresAt) + 1);
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('returns a historical idempotent receipt without reactivating a later archived memory', () => {
    const preview = prepare(source());
    const first = apply(preview);
    const memory = deps.memoryRepo.findById(first.outcomes[0]!.memoryId)!;
    deps.memoryRepo.update({ ...memory, lifecycle: 'archived' });
    const before = fingerprint();
    expect(apply(preview)).toEqual({ ...first, alreadyApplied: true });
    expect(fingerprint()).toBe(before);
  });
  it('accepts forward sequence and refuses older replay even with an old trusted pin', () => {
    const memory = row({ sensitivity: 'confidential' });
    const old = source([memory]);
    const newer = source([{ ...memory, sensitivity: 'public' }], 'source', 2);
    apply(prepare(old));
    apply(prepare(newer));
    expect(deps.memoryRepo.findByTenant(destination)[0]!.sensitivity).toBe('confidential');
    const before = fingerprint();
    expect(() => prepare(old)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('refuses same-sequence different digest and key rotation sequence reset', () => {
    apply(prepare(source()));
    const before = fingerprint();
    expect(() => prepare(source())).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it.each(['public', 'confidential'])(
    'preserves policy blocking the original or effective %s classification',
    (blocked) => {
      context.policy = makePolicy({
        tenantId: destination,
        rules: [
          {
            id: 'gate',
            type: 'sensitivity_gate',
            action: 'reject',
            priority: 0,
            enabled: true,
            parameters: { blockedLevels: [blocked] },
          },
        ],
      });
      const memory = row({ sensitivity: 'confidential' });
      const result = apply(prepare(source([memory])));
      expect(result.outcomes[0]!.status).toBe('rejected');
      expect(deps.memoryRepo.findByTenant(destination)).toEqual([]);
      const candidate = importCandidate(memory, destination);
      expect(resolveCandidateMinimumSensitivity(candidate, deps.auditRepo)).toBe('confidential');
      // A later canonical human promotion must resolve the durable imported floor.
      const promoted = promote(
        {
          candidate,
          contentHash: memory.contentHash,
          minimumSensitivity: resolveCandidateMinimumSensitivity(candidate, deps.auditRepo),
          pipelineResult: { candidateId: candidate.id, outcome: 'approved', evaluations: [] },
          promotedBy: { type: 'human', id: 'synthetic-owner' },
        },
        deps.memoryRepo,
        deps.auditRepo,
      );
      expect(promoted.sensitivity).toBe('confidential');
    },
  );
  it.each([
    'imported-sensitivity-floor-v1',
    'source-snapshot-accepted-v1',
    'source-import-settled-v1',
    'promoted',
  ])('rolls back if the %s receipt is omitted', (kind) => {
    const preview = prepare(source());
    const insert = deps.auditRepo.insert.bind(deps.auditRepo);
    vi.spyOn(deps.auditRepo, 'insert').mockImplementation((event) => {
      if (event.details['kind'] === kind || event.action === kind) return;
      insert(event);
    });
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('detects removal of a promotion receipt after the promoter returns', () => {
    const preview = prepare(source());
    const insert = deps.auditRepo.insert.bind(deps.auditRepo);
    vi.spyOn(deps.auditRepo, 'insert').mockImplementation((event) => {
      insert(event);
      if (event.details['kind'] === 'source-import-settled-v1')
        db.prepare("DELETE FROM audit_events WHERE action = 'promoted'").run();
    });
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('detects a stronger valid floor appended after promotion and rolls back', () => {
    const memory = row();
    const preview = prepare(source([memory]));
    const insert = deps.auditRepo.insert.bind(deps.auditRepo);
    vi.spyOn(deps.auditRepo, 'insert').mockImplementation((event) => {
      insert(event);
      if (event.details['kind'] === 'source-import-settled-v1')
        strongerFloor(importCandidate(memory, destination));
    });
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('detects an update that claims success without retaining stronger sensitivity', () => {
    deps.memoryRepo.insert(row({ tenantId: destination }));
    const preview = prepare(source([row({ sensitivity: 'confidential' })]));
    vi.spyOn(deps.memoryRepo, 'update').mockReturnValue(true);
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('reexports imported restrictions for the next authorized destination', () => {
    apply(prepare(source([row({ sensitivity: 'restricted' })])));
    const keys = generateActorKeypair();
    const raw = exportSourceSnapshot(
      db,
      {
        sourceId: 'second',
        sourceTenantId: destination,
        destinationTenantId: 'third',
        sequence: 1,
        issuedAt,
        expiresAt,
      },
      keys.privateKeyHex,
    );
    expect(SignedSourceSnapshot.parse(JSON.parse(raw)).payload.items[0]!.minimumSensitivity).toBe(
      'restricted',
    );
  });
  it('preserves imported restrictions through actual governed hold placement and human release', () => {
    const memory = row({ sensitivity: 'confidential' });
    const policy = makePolicy({
      tenantId: destination,
      rules: [
        {
          id: 'sensitivity',
          type: 'sensitivity_gate',
          action: 'flag',
          enabled: true,
          priority: 0,
          parameters: { blockedLevels: ['confidential'] },
        },
      ],
    });
    context.policy = policy;
    expect(apply(prepare(source([memory]))).outcomes[0]!.status).toBe('rejected');
    const candidate = importCandidate(memory, destination);
    const candidates = new CandidateRepository(db);
    candidates.insert(candidate, memory.contentHash);
    const policies = new PolicyRepository(db);
    policies.insert(policy);
    const actor = { type: 'human' as const, id: 'synthetic-owner' };
    const result = governSelectedCandidates(
      {
        runId: randomUUID(),
        tenantId: destination,
        selections: [
          {
            candidateId: candidate.id,
            snapshotDigest: candidateSnapshotDigest(candidate),
            minimumSensitivity: 'public',
          },
        ],
        actor,
        role: 'owner',
        reason: 'Synthetic later review',
      },
      db,
    );
    expect(result.outcomes[0]!.outcome).toBe('held');
    const released = resolveHold(
      {
        candidateId: candidate.id,
        tenantId: destination,
        resolution: 'release',
        audience: 'tenant',
        actor,
        role: 'owner',
        reason: 'Resolve synthetic hold',
      },
      { candidateRepo: candidates, policyRepo: policies, ...deps },
    );
    expect(released.ok).toBe(true);
    if (!released.ok) throw new Error('Expected synthetic release');
    expect(deps.memoryRepo.findById(released.memoryId!)!.sensitivity).toBe('confidential');
  });
  it('refuses an import that would bypass an existing local human hold', () => {
    const memory = row();
    const candidate = importCandidate(memory, destination);
    const candidates = new CandidateRepository(db);
    candidates.insert(candidate, memory.contentHash);
    new PolicyRepository(db).insert(
      makePolicy({
        tenantId: destination,
        rules: [
          {
            id: 'sensitivity',
            type: 'sensitivity_gate',
            action: 'flag',
            enabled: true,
            priority: 0,
            parameters: { blockedLevels: ['confidential'] },
          },
        ],
      }),
    );
    const held = governSelectedCandidates(
      {
        runId: randomUUID(),
        tenantId: destination,
        selections: [
          {
            candidateId: candidate.id,
            snapshotDigest: candidateSnapshotDigest(candidate),
            minimumSensitivity: 'confidential',
          },
        ],
        actor: { type: 'human', id: 'synthetic-owner' },
        role: 'owner',
        reason: 'Synthetic local review',
      },
      db,
    );
    expect(held.outcomes[0]!.outcome).toBe('held');
    expect(candidates.findById(candidate.id)!.status).toBe('quarantined');
    const before = fingerprint();
    expect(() => prepare(source([memory]))).toThrow();
    expect(fingerprint()).toBe(before);
    expect(deps.memoryRepo.findByTenant(destination)).toEqual([]);
  });
  it.each(['quarantined', 'rejected', 'promoted', 'flagged', 'duplicate'] as const)(
    'refuses an existing %s candidate rather than bypassing local standing',
    (status) => {
      const memory = row();
      new CandidateRepository(db).insert(
        { ...importCandidate(memory, destination), status },
        memory.contentHash,
      );
      expect(() => prepare(source([memory]))).toThrow();
    },
  );
  it('refuses a changed policy after preview', () => {
    context.policy = makePolicy({ tenantId: destination });
    const preview = prepare(source());
    context.policy = { ...context.policy, version: context.policy.version + 1 };
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('combines a destination alias durable floor before content deduplication', () => {
    const existing = row({ tenantId: destination });
    deps.memoryRepo.insert(existing);
    strongerFloor(importCandidate(existing, destination));
    const result = apply(prepare(source()));
    expect(result.outcomes[0]!.minimumSensitivity).toBe('restricted');
    expect(deps.memoryRepo.findById(existing.id)!.sensitivity).toBe('restricted');
  });
  it('refuses tampered source content and mismatched repository connections', () => {
    const artifact = source();
    pins = [artifact.checkpoint];
    const altered = JSON.parse(artifact.raw);
    altered.payload.items[0].memory.content = 'Altered synthetic text';
    expect(() => previewSourceImport([JSON.stringify(altered)], deps, context)).toThrow();
    const other = createTestDatabase();
    try {
      expect(() =>
        previewSourceImport(
          [artifact.raw],
          { ...deps, auditRepo: new AuditRepository(other) },
          context,
        ),
      ).toThrow();
    } finally {
      other.close();
    }
  });
  it.each(['contentHash', 'minimumSensitivity'])(
    'refuses malformed imported %s on later review',
    (field) => {
      const memory = row();
      apply(prepare(source([memory])));
      const candidate = importCandidate(memory, destination);
      const event = deps.auditRepo.findByMemoryAndTenant(candidate.id, destination)[0]!;
      db.prepare('UPDATE audit_events SET details_json = ? WHERE id = ?').run(
        JSON.stringify({
          ...event.details,
          [field]: field === 'contentHash' ? 'a'.repeat(64) : 'invalid',
        }),
        event.id,
      );
      expect(() => resolveCandidateMinimumSensitivity(candidate, deps.auditRepo)).toThrow();
    },
  );
  it('loads registered destination policy even when the caller omits it', () => {
    new PolicyRepository(db).insert(
      makePolicy({
        tenantId: destination,
        rules: [
          {
            id: 'gate',
            type: 'sensitivity_gate',
            action: 'reject',
            priority: 0,
            enabled: true,
            parameters: { blockedLevels: ['confidential'] },
          },
        ],
      }),
    );
    expect(apply(prepare(source([row({ sensitivity: 'confidential' })]))).outcomes[0]!.status).toBe(
      'rejected',
    );
    expect(deps.memoryRepo.findByTenant(destination)).toEqual([]);
  });
  it('refuses a supplied policy that disagrees with the registered destination policy', () => {
    new PolicyRepository(db).insert(makePolicy({ tenantId: destination }));
    context.policy = makePolicy({ tenantId: destination });
    expect(() => prepare(source())).toThrow();
  });
  it('refuses registration of a policy between preview and apply', () => {
    const preview = prepare(source());
    new PolicyRepository(db).insert(makePolicy({ tenantId: destination }));
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('rolls back a policy registered during finalization', () => {
    const preview = prepare(source());
    const insert = deps.auditRepo.insert.bind(deps.auditRepo);
    vi.spyOn(deps.auditRepo, 'insert').mockImplementation((event) => {
      insert(event);
      if (event.details['kind'] === 'source-import-settled-v1')
        new PolicyRepository(db).insert(makePolicy({ tenantId: destination }));
    });
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('supplies destination hashes to configured duplicate policy while retaining stronger constraints', () => {
    const existing = row({ tenantId: destination });
    deps.memoryRepo.insert(existing);
    context.policy = makePolicy({
      tenantId: destination,
      rules: [
        {
          id: 'dedup',
          type: 'dedup_check',
          action: 'reject',
          priority: 0,
          enabled: true,
          parameters: {},
        },
      ],
    });
    const result = apply(prepare(source([row({ sensitivity: 'confidential' })])));
    expect(result.outcomes[0]!.status).toBe('rejected');
    expect(deps.memoryRepo.findById(existing.id)!.sensitivity).toBe('confidential');
  });
  it('combines stronger local pending alias floors under different candidate IDs', () => {
    const alias = importCandidate(row(), destination);
    new CandidateRepository(db).insert(alias, computeContentHash(alias.content));
    strongerFloor(alias);
    const result = apply(prepare(source()));
    expect(result.outcomes[0]!.sensitivity).toBe('restricted');
    expect(deps.memoryRepo.findByTenant(destination)[0]!.sensitivity).toBe('restricted');
  });
  it('refuses a quarantined local content alias with a different candidate ID', () => {
    const alias = { ...importCandidate(row(), destination), status: 'quarantined' as const };
    new CandidateRepository(db).insert(alias, computeContentHash(alias.content));
    expect(() => prepare(source())).toThrow();
  });
  it('refuses pending alias state changed after preview', () => {
    const alias = importCandidate(row(), destination);
    const repo = new CandidateRepository(db);
    repo.insert(alias, computeContentHash(alias.content));
    const preview = prepare(source());
    repo.updateStatus(alias.id, 'quarantined', destination);
    expect(() => apply(preview)).toThrow();
  });
  it.each(['imported-sensitivity-floor-v2', 'unknown-floor-shape'])(
    'refuses unsupported %s during later review',
    (kind) => {
      const memory = row();
      apply(prepare(source([memory])));
      const candidate = importCandidate(memory, destination);
      const event = deps.auditRepo.findByMemoryAndTenant(candidate.id, destination)[0]!;
      db.prepare('UPDATE audit_events SET details_json = ? WHERE id = ?').run(
        JSON.stringify({ ...event.details, kind }),
        event.id,
      );
      expect(() => resolveCandidateMinimumSensitivity(candidate, deps.auditRepo)).toThrow();
    },
  );
  it('rolls back when a local pending alias is quarantined during finalization', () => {
    const alias = importCandidate(row(), destination);
    const repo = new CandidateRepository(db);
    repo.insert(alias, computeContentHash(alias.content));
    const preview = prepare(source());
    const before = fingerprint();
    const insert = deps.auditRepo.insert.bind(deps.auditRepo);
    vi.spyOn(deps.auditRepo, 'insert').mockImplementation((event) => {
      insert(event);
      if (event.details['kind'] === 'source-import-settled-v1')
        repo.updateStatus(alias.id, 'quarantined', destination);
    });
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('retains audit-only rejected content restrictions across later candidate aliases', () => {
    context.policy = makePolicy({
      tenantId: destination,
      rules: [
        {
          id: 'gate',
          type: 'sensitivity_gate',
          action: 'reject',
          priority: 0,
          enabled: true,
          parameters: { blockedLevels: ['restricted'] },
        },
      ],
    });
    const first = row({ sensitivity: 'restricted' });
    expect(apply(prepare(source([first], 'a'))).outcomes[0]!.status).toBe('rejected');
    expect(deps.memoryRepo.findByTenant(destination)).toEqual([]);
    expect(new CandidateRepository(db).findByTenant(destination)).toEqual([]);
    const alias = row();
    const second = apply(prepare(source([alias], 'b')));
    expect(second.outcomes[0]).toMatchObject({
      status: 'rejected',
      minimumSensitivity: 'restricted',
    });
    expect(
      resolveCandidateMinimumSensitivity(importCandidate(row(), destination), deps.auditRepo),
    ).toBe('restricted');
    expect(
      resolveCandidateMinimumSensitivity(importCandidate(alias, 'foreign'), deps.auditRepo),
    ).toBeUndefined();
    expect(
      resolveCandidateMinimumSensitivity(
        importCandidate(row({ content: 'Unrelated synthetic text' }), destination),
        deps.auditRepo,
      ),
    ).toBeUndefined();
    delete context.policy;
    const admitted = apply(prepare(source([row()], 'c')));
    expect(admitted.outcomes[0]).toMatchObject({ status: 'promoted', sensitivity: 'restricted' });
    expect(deps.memoryRepo.findByTenant(destination)[0]!.sensitivity).toBe('restricted');
  });
  it('checks authority after expensive final integrity verification', () => {
    const preview = prepare(source());
    const original = deps.auditRepo.findAllChronological.bind(deps.auditRepo);
    vi.spyOn(deps.auditRepo, 'findAllChronological').mockImplementation(() => {
      const rows = original();
      if (rows.length > 0) pins = pins.map((pin) => ({ ...pin, revoked: true }));
      return rows;
    });
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('samples the clock again after final signature and policy verification', () => {
    const preview = prepare(source());
    let calls = 0;
    context.now = () => (++calls <= 3 ? now : Date.parse(expiresAt));
    const before = fingerprint();
    expect(() => apply(preview)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('rejects stripped legacy arrays on this path', () => {
    expect(() => previewSourceImport([JSON.stringify([row()])], deps, context)).toThrow();
  });
});
