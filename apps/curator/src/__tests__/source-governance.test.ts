import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeContentHash, deriveMemoryId } from '@qmd-team-intent-kb/common';
import {
  createTestDatabase,
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  verifyAuditChain,
  generateActorKeypair,
} from '@qmd-team-intent-kb/store';
import { makeCandidate, makeMemory, makePolicy } from './fixtures.js';
import { makeSourceGovernanceFixture } from './source-governance-fixtures.js';
import {
  signSourceClassification,
  sourceProfileDigest,
} from '../origin/source-classification-codec.js';
import { applySourceGovernance, previewSourceGovernance } from '../origin/source-governance.js';
import { sourceGovernanceRepositories } from '../origin/source-governance-prepare.js';
import {
  governSelectedCandidates,
  candidateSnapshotDigest,
} from '../recovery/selected-governance.js';
import { mergeGovern } from '../merge/merge-gate.js';
import { exportSourceSnapshot } from '../merge/source-snapshot.js';
import { SignedSourceSnapshot } from '../merge/source-snapshot-schema.js';
import { previewSourceImport, applySourceImport } from '../merge/source-import.js';
import { PROVENANCE_FLOOR_KIND } from '../recovery/provenance-sensitivity-constraint.js';
import { resolveCandidateMinimumSensitivity } from '../recovery/sensitivity-constraint.js';
import type { SourceGovernanceContext } from '../origin/source-governance-schema.js';

let db: Database.Database;
let f: ReturnType<typeof makeSourceGovernanceFixture>;
let deps: ReturnType<typeof sourceGovernanceRepositories>;
let context: SourceGovernanceContext;
let wire: string;
beforeEach(() => {
  db = createTestDatabase();
  deps = sourceGovernanceRepositories(db);
  f = makeSourceGovernanceFixture();
  deps.candidateRepo.insert(f.candidate, computeContentHash(f.candidate.content));
  saveRegistry();
  context = { readReceiver: () => f.receiver };
  wire = signSourceClassification(f.payload, f.keys.privateKey);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});
function saveRegistry() {
  db.prepare('INSERT OR REPLACE INTO source_classification_authority VALUES (1, ?)').run(
    JSON.stringify(f.registry),
  );
}
function preview() {
  return previewSourceGovernance(f.candidate.id, wire, db, context);
}
function apply(plan = preview()) {
  return applySourceGovernance(plan, wire, db, context);
}
function policy(blocked: string[] = ['confidential']) {
  const value = makePolicy({
    tenantId: f.candidate.tenantId,
    rules: [
      {
        id: 'source-sensitivity',
        name: 'Source sensitivity',
        type: 'sensitivity_gate',
        enabled: true,
        priority: 0,
        action: 'reject',
        parameters: { blockedLevels: blocked },
      },
    ],
  });
  deps.policyRepo.insert(value);
  return value;
}
function alias(sensitivity: 'public' | 'restricted' = 'public') {
  const id = randomUUID(),
    hash = computeContentHash(f.candidate.content);
  const row = makeMemory({
    id: deriveMemoryId(id, hash),
    candidateId: id,
    tenantId: f.candidate.tenantId,
    content: f.candidate.content,
    contentHash: hash,
    sensitivity,
    metadata: { filePaths: [], tags: [], audience: 'owner' },
  });
  deps.memoryRepo.insert(row);
  return row;
}
function fingerprint() {
  return db.serialize().toString('base64');
}

describe('transactional provenance governance', () => {
  it('previews without writes and promotes with a durable floor on the no-policy path', () => {
    const before = fingerprint(),
      plan = preview();
    expect(fingerprint()).toBe(before);
    expect(plan).toMatchObject({ minimumSensitivity: 'confidential', policyOutcome: 'approved' });
    const result = apply(plan);
    expect(result.settlement.outcome).toBe('promoted');
    expect(deps.memoryRepo.findById(result.settlement.memoryId!)?.sensitivity).toBe('confidential');
    expect(resolveCandidateMinimumSensitivity(f.candidate, deps.auditRepo)).toBe('confidential');
    expect(verifyAuditChain(deps.auditRepo).breaks).toEqual([]);
    expect(JSON.stringify(deps.auditRepo.findByTenant(f.candidate.tenantId))).not.toContain(
      f.candidate.content,
    );
  });
  it('uses the same floor in policy evaluation and rejection, retaining it for later review', () => {
    policy();
    const plan = preview();
    expect(plan.policyOutcome).toBe('rejected');
    expect(apply(plan).settlement.outcome).toBe('rejected');
    expect(deps.memoryRepo.findByTenant(f.candidate.tenantId)).toEqual([]);
    expect(
      resolveCandidateMinimumSensitivity({ ...f.candidate, id: randomUUID() }, deps.auditRepo),
    ).toBe('confidential');
  });
  it('tightens an existing public alias before returning duplicate, preserving its audience', () => {
    const row = alias();
    policy();
    const plan = preview();
    expect(plan.policyOutcome).toBe('rejected');
    expect(apply(plan).settlement.outcome).toBe('duplicate');
    expect(deps.memoryRepo.findById(row.id)).toMatchObject({
      sensitivity: 'confidential',
      version: row.version + 1,
      metadata: { audience: 'owner' },
    });
    expect(deps.memoryRepo.findByTenant(f.candidate.tenantId)).toHaveLength(1);
  });
  it('persists the stricter pre-existing alias restriction, even if the incoming profile is weaker', () => {
    alias('restricted');
    expect(preview().minimumSensitivity).toBe('restricted');
    apply();
    expect(
      resolveCandidateMinimumSensitivity({ ...f.candidate, id: randomUUID() }, deps.auditRepo),
    ).toBe('restricted');
  });
  it('keeps settled restrictions after profile deletion, key revocation and expiry', () => {
    apply();
    f.registry.profiles = [];
    f.registry.keys[0]!.revoked = true;
    saveRegistry();
    f.receiver.now = '2026-11-23T09:02:00.000Z';
    expect(
      resolveCandidateMinimumSensitivity({ ...f.candidate, id: randomUUID() }, deps.auditRepo),
    ).toBe('confidential');
    expect(() => preview()).toThrow();
  });
  it('returns exact historical replay after expiry without new writes or reactivation', () => {
    const plan = preview(),
      first = apply(plan);
    f.receiver.now = '2026-11-23T09:02:00.000Z';
    f.registry.keys = [];
    saveRegistry();
    const before = fingerprint();
    const replay = apply(plan);
    expect(replay).toEqual({ ...first, alreadySettled: true });
    expect(fingerprint()).toBe(before);
  });
  it.each([
    'candidate',
    'policy',
    'registry',
    'profile',
    'key',
    'receiver',
    'ingress',
    'envelope',
    'plan',
  ] as const)('refuses %s drift between preview and apply without new writes', (kind) => {
    const plan = preview();
    switch (kind) {
      case 'candidate':
        db.prepare('UPDATE candidates SET title = ? WHERE id = ?').run('Changed', f.candidate.id);
        break;
      case 'policy':
        policy();
        break;
      case 'registry':
        f.registry.revision++;
        break;
      case 'profile':
        f.registry.profiles[0]!.revision++;
        break;
      case 'key':
        f.registry.keys[0]!.revoked = true;
        break;
      case 'receiver':
        f.receiver.receiverId = 'other';
        break;
      case 'ingress':
        f.receiver.ingressId = 'other';
        break;
      case 'envelope':
        wire += ' ';
        break;
      case 'plan':
        plan.minimumSensitivity = 'public';
        break;
    }
    saveRegistry();
    const before = fingerprint();
    expect(() => apply(plan)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it.each(['registry', 'key', 'expiry', 'candidate', 'policy'] as const)(
    'rolls back if %s changes during an authority reload',
    (kind) => {
      const plan = preview(),
        before = fingerprint();
      let reads = 0;
      context.readReceiver = () => {
        reads++;
        if (reads === 3) {
          if (kind === 'registry') f.registry.revision++;
          if (kind === 'key') f.registry.keys[0]!.revoked = true;
          if (kind === 'registry' || kind === 'key') saveRegistry();
          if (kind === 'expiry') f.receiver.now = f.payload.expiresAt;
          if (kind === 'candidate')
            db.prepare('UPDATE candidates SET title = ? WHERE id = ?').run(
              'Changed',
              f.candidate.id,
            );
          if (kind === 'policy') policy();
        }
        return f.receiver;
      };
      expect(() => apply(plan)).toThrow();
      expect(fingerprint()).toBe(before);
    },
  );
  it.each(['floor', 'tightening', 'promoted', 'settlement'] as const)(
    'rolls back every write if the %s receipt fails',
    (kind) => {
      if (kind === 'tightening') alias();
      const plan = preview(),
        before = fingerprint();
      const insert = AuditRepository.prototype.insert;
      vi.spyOn(AuditRepository.prototype, 'insert').mockImplementation(function (
        this: AuditRepository,
        event,
      ) {
        const match =
          kind === 'promoted'
            ? event.action === 'promoted'
            : event.details['kind'] ===
              (kind === 'floor'
                ? PROVENANCE_FLOOR_KIND
                : kind === 'tightening'
                  ? 'source-provenance-tightening-v1'
                  : 'source-governance-settlement-v1');
        if (match) throw new Error('Synthetic write failure');
        return insert.call(this, event);
      });
      expect(() => apply(plan)).toThrow();
      expect(fingerprint()).toBe(before);
    },
  );
  it('refuses silent alias-update loss and rolls back its floor', () => {
    alias();
    const plan = preview(),
      before = fingerprint();
    vi.spyOn(MemoryRepository.prototype, 'update').mockReturnValue(true);
    expect(() => apply(plan)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('rejects same assertion identity reused for a different signed candidate', () => {
    const plan = preview();
    apply(plan);
    const other = makeCandidate({
      ...f.candidate,
      id: randomUUID(),
      content: 'Different synthetic content',
    });
    deps.candidateRepo.insert(other, computeContentHash(other.content));
    f.candidate = other;
    f.payload.candidateId = other.id;
    f.payload.contentHash = computeContentHash(other.content);
    wire = signSourceClassification(f.payload, f.keys.privateKey);
    const otherPlan = preview(),
      before = fingerprint();
    expect(() => apply(otherPlan)).toThrow('replay');
    expect(fingerprint()).toBe(before);
  });
  it('never lowers earlier durable floors when a fresh public profile assertion arrives', () => {
    apply();
    const next = makeCandidate({ ...f.candidate, id: randomUUID() });
    deps.candidateRepo.insert(next, computeContentHash(next.content));
    f.candidate = next;
    f.registry.profiles[0]!.minimumSensitivity = 'public';
    f.registry.profiles[0]!.revision++;
    saveRegistry();
    Object.assign(f.payload, {
      candidateId: next.id,
      assertionId: randomUUID(),
      profileRevision: f.registry.profiles[0]!.revision,
      profileDigest: sourceProfileDigest(f.registry.profiles[0]!),
    });
    wire = signSourceClassification(f.payload, f.keys.privateKey);
    expect(preview().minimumSensitivity).toBe('confidential');
    apply();
    expect(
      deps.memoryRepo.findByTenant(next.tenantId).every((r) => r.sensitivity === 'confidential'),
    ).toBe(true);
  });

  it('retains original-classification refusal under a non-monotonic sensitivity policy', () => {
    policy(['public']);
    const plan = preview();
    expect(plan.minimumSensitivity).toBe('confidential');
    expect(plan.policyOutcome).toBe('rejected');
    expect(apply(plan).settlement.outcome).toBe('rejected');
    expect(deps.memoryRepo.findByTenant(f.candidate.tenantId)).toEqual([]);
  });
  it('preserves sensitivity-policy holds rather than treating signed source as release authority', () => {
    const configured = policy();
    db.prepare('UPDATE governance_policies SET rules_json = ? WHERE id = ?').run(
      JSON.stringify(configured.rules.map((r) => ({ ...r, action: 'flag' }))),
      configured.id,
    );
    expect(apply().settlement.outcome).toBe('held');
    expect(deps.candidateRepo.findById(f.candidate.id)?.status).toBe('quarantined');
    expect(deps.memoryRepo.findByTenant(f.candidate.tenantId)).toEqual([]);
    expect(resolveCandidateMinimumSensitivity(f.candidate, deps.auditRepo)).toBe('confidential');
  });
  it('retains member quarantine because a source signature grants no human review standing', () => {
    db.prepare('UPDATE candidates SET metadata_json = ? WHERE id = ?').run(
      JSON.stringify({ ...f.candidate.metadata, proposedByRole: 'member' }),
      f.candidate.id,
    );
    expect(apply().settlement.outcome).toBe('quarantined');
    expect(deps.candidateRepo.findById(f.candidate.id)?.status).toBe('quarantined');
    expect(deps.memoryRepo.findByTenant(f.candidate.tenantId)).toEqual([]);
  });
  it('historical replay never reactivates an archived memory', () => {
    const plan = preview(),
      result = apply(plan);
    const row = deps.memoryRepo.findById(result.settlement.memoryId!)!;
    deps.memoryRepo.update({ ...row, lifecycle: 'archived', version: row.version + 1 });
    const before = fingerprint();
    expect(apply(plan).alreadySettled).toBe(true);
    expect(fingerprint()).toBe(before);
    expect(deps.memoryRepo.findById(row.id)?.lifecycle).toBe('archived');
  });
  it('preserves a provenance restriction through legacy human governance on optional enrollment', () => {
    f.registry.enrollments[0]!.required = false;
    saveRegistry();
    const configured = policy();
    apply();
    // Change the synthetic policy to permit promotion; no recovery floor is supplied.
    db.prepare('UPDATE governance_policies SET rules_json = ? WHERE id = ?').run(
      JSON.stringify(configured.rules.map((r) => ({ ...r, enabled: false }))),
      configured.id,
    );
    const candidate = deps.candidateRepo.findById(f.candidate.id)!;
    const result = governSelectedCandidates(
      {
        runId: randomUUID(),
        tenantId: candidate.tenantId,
        selections: [
          { candidateId: candidate.id, snapshotDigest: candidateSnapshotDigest(candidate) },
        ],
        actor: { type: 'human', id: 'synthetic-owner' },
        role: 'owner',
        reason: 'Synthetic review',
      },
      db,
    );
    expect(result.outcomes[0]!.outcome).toBe('promoted');
    expect(deps.memoryRepo.findById(result.outcomes[0]!.memoryId!)?.sensitivity).toBe(
      'confidential',
    );
  });
  it('carries a source restriction through authenticated snapshot export and cross-clone import', () => {
    apply();
    const transportKeys = generateActorKeypair();
    const options = {
      sourceId: 'synthetic-source',
      sourceTenantId: f.candidate.tenantId,
      destinationTenantId: 'destination',
      sequence: 1,
      issuedAt: '2026-11-22T09:01:00.000Z',
      expiresAt: '2026-11-23T09:00:00.000Z',
    };
    const artifact = exportSourceSnapshot(db, options, transportKeys.privateKeyHex);
    const snapshot = SignedSourceSnapshot.parse(JSON.parse(artifact));
    expect(snapshot.payload.items[0]!.minimumSensitivity).toBe('confidential');
    const destination = createTestDatabase();
    try {
      const target = sourceGovernanceRepositories(destination);
      const checkpoint = {
        ...options,
        keyId: snapshot.payload.keyId,
        publicKeyHex: transportKeys.publicKeyHex,
        snapshotDigest: snapshot.digest,
        validFrom: options.issuedAt,
        validUntil: options.expiresAt,
        revoked: false,
      };
      // Checkpoint's closed schema has its own validity fields, not assertion timestamps.
      const { issuedAt: _issued, expiresAt: _expires, ...pin } = checkpoint;
      const importContext = {
        tenantId: 'destination',
        loadCheckpoints: () => [pin],
        now: () => Date.parse(f.receiver.now),
      };
      const prepared = previewSourceImport([artifact], target, importContext);
      const result = applySourceImport(prepared.plan, [artifact], target, importContext);
      expect(result.outcomes[0]).toMatchObject({ status: 'promoted', sensitivity: 'confidential' });
      const imported = target.memoryRepo.findById(result.outcomes[0]!.memoryId)!;
      expect(
        resolveCandidateMinimumSensitivity(
          { ...f.candidate, id: randomUUID(), tenantId: 'destination', content: imported.content },
          target.auditRepo,
        ),
      ).toBe('confidential');
      expect(verifyAuditChain(target.auditRepo).breaks).toEqual([]);
    } finally {
      destination.close();
    }
  });
  it.each([
    'minimumSensitivity',
    'assertionDigest',
    'replayIdentity',
    'candidateId',
    'contentHash',
  ] as const)('refuses malformed settled floor %s', (field) => {
    apply();
    db.prepare(
      "UPDATE audit_events SET details_json = json_set(details_json, ?, 'invalid') WHERE json_extract(details_json,'$.kind') = ?",
    ).run('$.' + field, PROVENANCE_FLOOR_KIND);
    expect(() => resolveCandidateMinimumSensitivity(f.candidate, deps.auditRepo)).toThrow();
  });
  it('retains destination provenance floors in the ordinary merge gate', () => {
    const configured = policy();
    apply();
    const id = randomUUID(),
      contentHash = computeContentHash(f.candidate.content);
    const incoming = makeMemory({
      id: deriveMemoryId(id, contentHash),
      candidateId: id,
      tenantId: f.candidate.tenantId,
      content: f.candidate.content,
      contentHash,
      sensitivity: 'public',
    });
    const result = mergeGovern([incoming], [], deps, {
      tenantId: f.candidate.tenantId,
      policy: configured,
    });
    expect(result.promoted).toEqual([]);
    expect(result.quarantined).toHaveLength(1);
    expect(resolveCandidateMinimumSensitivity({ ...f.candidate, id }, deps.auditRepo)).toBe(
      'confidential',
    );
  });
  it('rolls back if the candidate disposition is not retained', () => {
    const plan = preview(),
      before = fingerprint();
    vi.spyOn(CandidateRepository.prototype, 'updateStatus').mockReturnValue(0);
    expect(() => apply(plan)).toThrow();
    expect(fingerprint()).toBe(before);
  });
  it('does not treat a source assertion as permission to supersede another memory', () => {
    const content = 'Different old synthetic planning',
      contentHash = computeContentHash(content),
      candidateId = randomUUID();
    deps.memoryRepo.insert(
      makeMemory({
        id: deriveMemoryId(candidateId, contentHash),
        candidateId,
        tenantId: f.candidate.tenantId,
        title: f.candidate.title,
        category: f.candidate.category,
        content,
        contentHash,
        sensitivity: 'public',
      }),
    );
    const plan = preview(),
      before = fingerprint();
    expect(() => apply(plan)).toThrow('supersession');
    expect(fingerprint()).toBe(before);
  });
  it('tightens a previously promoted public candidate under the same stable ID without readmission', () => {
    const contentHash = computeContentHash(f.candidate.content);
    const row = makeMemory({
      id: deriveMemoryId(f.candidate.id, contentHash),
      candidateId: f.candidate.id,
      tenantId: f.candidate.tenantId,
      content: f.candidate.content,
      contentHash,
      sensitivity: 'public',
      lifecycle: 'archived',
    });
    deps.memoryRepo.insert(row);
    deps.candidateRepo.updateStatus(f.candidate.id, 'promoted', f.candidate.tenantId);
    const plan = preview();
    expect(plan.restrictionOnly).toBe(true);
    expect(apply(plan).settlement.outcome).toBe('restricted-existing');
    expect(deps.memoryRepo.findById(row.id)).toMatchObject({
      sensitivity: 'confidential',
      lifecycle: 'archived',
    });
    expect(deps.candidateRepo.findById(f.candidate.id)?.status).toBe('promoted');
    expect(deps.auditRepo.findByTenantAndAction(f.candidate.tenantId, 'promoted')).toEqual([]);
  });
  it.each(['rejected', 'quarantined', 'duplicate', 'flagged'] as const)(
    'learns a floor for %s content without reopening its disposition',
    (status) => {
      deps.candidateRepo.updateStatus(f.candidate.id, status, f.candidate.tenantId);
      expect(apply().settlement.outcome).toBe('restricted-existing');
      expect(deps.candidateRepo.findById(f.candidate.id)?.status).toBe(status);
      expect(deps.memoryRepo.findByTenant(f.candidate.tenantId)).toEqual([]);
      expect(resolveCandidateMinimumSensitivity(f.candidate, deps.auditRepo)).toBe('confidential');
    },
  );
  it('combines content classification with a public profile before alias deduplication', () => {
    f.candidate.content = 'Synthetic contact jane@example.com';
    const contentHash = computeContentHash(f.candidate.content);
    db.prepare('UPDATE candidates SET content = ?, content_hash = ? WHERE id = ?').run(
      f.candidate.content,
      contentHash,
      f.candidate.id,
    );
    f.registry.profiles[0]!.minimumSensitivity = 'public';
    saveRegistry();
    f.payload.contentHash = contentHash;
    f.payload.profileDigest = sourceProfileDigest(f.registry.profiles[0]!);
    wire = signSourceClassification(f.payload, f.keys.privateKey);
    const row = alias();
    expect(preview().minimumSensitivity).toBe('confidential');
    expect(apply().settlement.outcome).toBe('duplicate');
    expect(deps.memoryRepo.findById(row.id)?.sensitivity).toBe('confidential');
    expect(resolveCandidateMinimumSensitivity(f.candidate, deps.auditRepo)).toBe('confidential');
  });
  it('refuses unknown floor kinds instead of silently discarding evidence', () => {
    apply();
    db.prepare(
      "UPDATE audit_events SET details_json = json_set(details_json, '$.kind', 'future-sensitivity-floor-v9') WHERE json_extract(details_json,'$.kind') = ?",
    ).run(PROVENANCE_FLOOR_KIND);
    expect(() => resolveCandidateMinimumSensitivity(f.candidate, deps.auditRepo)).toThrow(
      'Unsupported',
    );
  });
  it('loads the stored registry rather than a divergent in-memory registry', () => {
    f.registry.keys = [];
    f.registry.enrollments = [];
    expect(apply().settlement.outcome).toBe('promoted');
  });
  it('refuses missing stored authority instead of falling back to a supplied registry', () => {
    db.exec('DELETE FROM source_classification_authority');
    expect(() => preview()).toThrow('current verified authority');
    expect(deps.memoryRepo.count()).toBe(0);
  });
  it('refuses stored revocation even when the fixture registry still authorizes the key', () => {
    const revoked = structuredClone(f.registry);
    revoked.keys[0]!.revoked = true;
    db.prepare('UPDATE source_classification_authority SET registry_json = ?').run(
      JSON.stringify(revoked),
    );
    expect(() => preview()).toThrow('current verified authority');
    expect(deps.memoryRepo.count()).toBe(0);
  });
  it('does not let a historical source floor authorize selected human legacy admission', () => {
    const configured = policy();
    apply();
    db.prepare('UPDATE governance_policies SET rules_json = ? WHERE id = ?').run(
      JSON.stringify(configured.rules.map((r) => ({ ...r, enabled: false }))),
      configured.id,
    );
    const candidate = deps.candidateRepo.findById(f.candidate.id)!;
    const before = fingerprint();
    expect(() =>
      governSelectedCandidates(
        {
          runId: randomUUID(),
          tenantId: candidate.tenantId,
          selections: [
            { candidateId: candidate.id, snapshotDigest: candidateSnapshotDigest(candidate) },
          ],
          actor: { type: 'human', id: 'synthetic-owner' },
          role: 'owner',
          reason: 'Synthetic review',
        },
        db,
      ),
    ).toThrow('Source enrollment');
    expect(fingerprint()).toBe(before);
    expect(resolveCandidateMinimumSensitivity(candidate, deps.auditRepo)).toBe('confidential');
  });
  it.each(['registry', 'key', 'expiry', 'candidate', 'policy'] as const)(
    'rolls back %s drift after settlement on the final authority reload',
    (kind) => {
      const plan = preview(),
        before = fingerprint();
      let settled = false;
      const insert = AuditRepository.prototype.insert;
      vi.spyOn(AuditRepository.prototype, 'insert').mockImplementation(function (
        this: AuditRepository,
        event,
      ) {
        const result = insert.call(this, event);
        if (event.details['kind'] === 'source-governance-settlement-v1') settled = true;
        return result;
      });
      context.readReceiver = () => {
        if (settled) {
          if (kind === 'registry') {
            f.registry.revision++;
            saveRegistry();
          }
          if (kind === 'key') {
            f.registry.keys[0]!.revoked = true;
            saveRegistry();
          }
          if (kind === 'expiry') f.receiver.now = f.payload.expiresAt;
          if (kind === 'candidate')
            db.prepare('UPDATE candidates SET title = ? WHERE id = ?').run(
              'Changed',
              f.candidate.id,
            );
          if (kind === 'policy') policy();
        }
        return f.receiver;
      };
      expect(() => apply(plan)).toThrow();
      expect(settled).toBe(true);
      expect(fingerprint()).toBe(before);
    },
  );
  it('refuses provider writes even on historical replay and rolls them back', () => {
    const plan = preview();
    apply(plan);
    const before = fingerprint();
    context.readReceiver = () => {
      db.exec('DELETE FROM source_classification_authority');
      return f.receiver;
    };
    expect(() => apply(plan)).toThrow('provider wrote');
    expect(fingerprint()).toBe(before);
  });
});
