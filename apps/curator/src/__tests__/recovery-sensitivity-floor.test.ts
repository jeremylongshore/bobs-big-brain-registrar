import { Curator } from '../curator.js';
import { promote } from '../promotion/promoter.js';
import { resolveHold } from '../hold/resolve-hold.js';
import {
  recordCandidateMinimumSensitivity,
  resolveCandidateMinimumSensitivity,
} from '../recovery/sensitivity-constraint.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sensitivity } from '@qmd-team-intent-kb/schema';
import { computeContentHash, deriveAuditEventId } from '@qmd-team-intent-kb/common';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createTestDatabase,
} from '@qmd-team-intent-kb/store';
import {
  candidateSnapshotDigest,
  governSelectedCandidates,
} from '../recovery/selected-governance.js';
import { makeCandidate, makePolicy, TENANT } from './fixtures.js';

let db: ReturnType<typeof createTestDatabase>;
let candidates: CandidateRepository;
let memories: MemoryRepository;
let audit: AuditRepository;

beforeEach(() => {
  db = createTestDatabase();
  candidates = new CandidateRepository(db);
  memories = new MemoryRepository(db);
  audit = new AuditRepository(db);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function prepare(
  minimumSensitivity: Sensitivity | undefined,
  blockedLevels: string[] = [],
  action = 'reject',
  overrides: Record<string, unknown> = {},
) {
  const candidate = makeCandidate({
    content: 'A benign convention about formatting project documentation.',
    ...overrides,
  });
  candidates.insert(candidate, computeContentHash(candidate.content));
  new PolicyRepository(db).insert(
    makePolicy({
      rules: [
        {
          id: 'sensitivity-fixture',
          type: 'sensitivity_gate',
          action,
          priority: 0,
          enabled: true,
          parameters: {
            blockedLevels:
              blockedLevels.length > 0 ? blockedLevels : ['confidential', 'restricted'],
          },
        },
      ],
    }),
  );
  // Keeping bindings in a variable also lets this regression run against the
  // prior public interface, which silently ignored the new constraint field.
  const selections = [
    {
      candidateId: candidate.id,
      snapshotDigest: candidateSnapshotDigest(candidate),
      minimumSensitivity,
    },
  ];
  return {
    runId: randomUUID(),
    tenantId: TENANT,
    selections,
    actor: { type: 'human' as const, id: 'fixture-operator' },
    role: 'owner' as const,
    reason: 'Preserve the reviewed source sensitivity.',
  };
}

describe('reviewed recovery sensitivity floor', () => {
  it('retains an internal source floor in the promoted target and its receipt', () => {
    const result = governSelectedCandidates(prepare('internal'), db);
    expect(result.outcomes[0]!.outcome).toBe('promoted');
    const memory = memories.findById(result.outcomes[0]!.memoryId!)!;
    expect(memory.sensitivity).toBe('internal');
    const event = audit
      .findByMemoryAndTenant(memory.id, TENANT)
      .find((item) => item.id === deriveAuditEventId(memory.id, 'promoted'))!;
    expect(event.details['sensitivityConstraint']).toEqual({
      classified: 'public',
      minimum: 'internal',
      effective: 'internal',
    });
  });

  it('applies the floor to the canonical policy decision before promotion', () => {
    const result = governSelectedCandidates(prepare('confidential'), db);
    expect(result.outcomes[0]!.outcome).toBe('rejected');
    expect(memories.findByTenant(TENANT)).toEqual([]);
  });

  it('does not bypass an original classified-level refusal with a nonmonotonic blocked set', () => {
    const result = governSelectedCandidates(prepare('internal', ['public']), db);
    expect(result.outcomes[0]!.outcome).toBe('rejected');
    expect(memories.findByTenant(TENANT)).toEqual([]);
  });
});

function snapshot(): unknown {
  return Object.fromEntries(
    ['candidates', 'curated_memories', 'audit_events', 'memory_links', 'governance_policies'].map(
      (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  );
}

function constraintContext(candidateId: string) {
  const candidate = candidates.findById(candidateId)!;
  return {
    runId: randomUUID(),
    manifestDigest: 'a'.repeat(64),
    candidateSnapshotDigest: candidateSnapshotDigest(candidate),
    actor: { type: 'human' as const, id: 'fixture-operator' },
    role: 'owner' as const,
    reason: 'A reviewed stronger privacy bound.',
  };
}

describe('durable same-store sensitivity constraints', () => {
  it('keeps no-floor behavior and receipt vocabulary unchanged', () => {
    const result = governSelectedCandidates(prepare(undefined), db);
    const memory = memories.findById(result.outcomes[0]!.memoryId!)!;
    expect(memory.sensitivity).toBe('public');
    expect(
      audit.findByMemoryAndTenant(memory.id, TENANT)[0]!.details['sensitivityConstraint'],
    ).toBeUndefined();
    expect(audit.findByMemoryAndTenant(memory.candidateId, TENANT)).toEqual([]);
  });

  it('keeps a classifier level stronger than the declared minimum', () => {
    const result = governSelectedCandidates(
      prepare('public', [], 'reject', {
        content: 'The workspace guide is at /home/fixture/workspace/guide.md.',
      }),
      db,
    );
    const memory = memories.findById(result.outcomes[0]!.memoryId!)!;
    expect(memory.sensitivity).toBe('internal');
    expect(
      audit.findByMemoryAndTenant(memory.id, TENANT)[0]!.details['sensitivityConstraint'],
    ).toEqual({ classified: 'internal', minimum: 'public', effective: 'internal' });
  });

  it('refuses an invalid runtime floor before any writes', () => {
    const input = prepare('not-a-sensitivity' as Sensitivity);
    const before = snapshot();
    expect(() => governSelectedCandidates(input, db)).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('binds a floor change to run identity and repeats without extra receipts', () => {
    const input = prepare('internal');
    governSelectedCandidates(input, db);
    const after = snapshot();
    expect(governSelectedCandidates(input, db).alreadySettled).toBe(true);
    expect(snapshot()).toEqual(after);
    const changed = {
      ...input,
      selections: input.selections.map((binding) => ({
        ...binding,
        minimumSensitivity: 'public' as const,
      })),
    };
    expect(() => governSelectedCandidates(changed, db)).toThrow(/different manifest/);
    expect(snapshot()).toEqual(after);
  });

  it('does not reinterpret an old ignored binding key as an applied floor', () => {
    const input = prepare('internal');
    const binding = input.selections[0]!;
    const oldManifest = {
      selections: [
        {
          candidateId: binding.candidateId,
          minimumSensitivity: 'internal',
          snapshotDigest: binding.snapshotDigest,
        },
      ],
      tenantId: TENANT,
    };
    audit.insert({
      id: randomUUID(),
      memoryId: input.runId,
      tenantId: TENANT,
      action: 'governed',
      actor: input.actor,
      timestamp: new Date().toISOString(),
      details: {
        kind: 'selected-govern-v1',
        manifestDigest: computeContentHash(JSON.stringify(oldManifest)),
        outcomes: [{ candidateId: binding.candidateId, outcome: 'quarantined' }],
      },
    });
    const before = snapshot();
    expect(() => governSelectedCandidates(input, db)).toThrow(/different manifest/);
    expect(snapshot()).toEqual(before);
  });

  it('retains the strongest valid floor and cannot lower it with another reviewed declaration', () => {
    const input = prepare('confidential', [], 'reject', {
      metadata: { proposedByRole: 'member', filePaths: [], tags: [] },
    });
    expect(governSelectedCandidates(input, db).outcomes[0]!.outcome).toBe('quarantined');
    const candidate = candidates.findById(input.selections[0]!.candidateId)!;
    const before = snapshot();
    recordCandidateMinimumSensitivity(candidate, 'public', constraintContext(candidate.id), audit);
    expect(resolveCandidateMinimumSensitivity(candidate, audit)).toBe('confidential');
    expect(snapshot()).toEqual(before);
  });

  it('preserves the durable floor through canonical hold placement and later human release', () => {
    const input = prepare('confidential', [], 'flag');
    expect(governSelectedCandidates(input, db).outcomes[0]!.outcome).toBe('held');
    const candidateId = input.selections[0]!.candidateId;
    const result = resolveHold(
      {
        candidateId,
        tenantId: TENANT,
        resolution: 'release',
        audience: 'tenant',
        actor: input.actor,
        role: 'owner',
        reason: 'Review the sensitivity flag without lowering its bound.',
      },
      {
        candidateRepo: candidates,
        memoryRepo: memories,
        policyRepo: new PolicyRepository(db),
        auditRepo: audit,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected release');
    expect(memories.findById(result.memoryId!)!.sensitivity).toBe('confidential');
    expect(
      audit
        .findByMemoryAndTenant(result.memoryId!, TENANT)
        .find((event) => event.action === 'promoted')!.details['sensitivityConstraint'],
    ).toEqual({ classified: 'public', minimum: 'confidential', effective: 'confidential' });
  });

  it.each(['invalid', 'content-mismatch'])(
    'refuses a malformed %s durable receipt without dropping its bound',
    (fault) => {
      const input = prepare('internal', [], 'reject', {
        metadata: { proposedByRole: 'member', filePaths: [], tags: [] },
      });
      governSelectedCandidates(input, db);
      const candidate = candidates.findById(input.selections[0]!.candidateId)!;
      const receipt = audit.findByMemoryAndTenant(candidate.id, TENANT)[0]!;
      const details = {
        ...receipt.details,
        ...(fault === 'invalid'
          ? { minimumSensitivity: 'unknown' }
          : { contentHash: 'b'.repeat(64) }),
      };
      db.prepare('UPDATE audit_events SET details_json = ? WHERE id = ?').run(
        JSON.stringify(details),
        receipt.id,
      );
      const before = snapshot();
      expect(() =>
        new Curator(
          {
            candidateRepo: candidates,
            memoryRepo: memories,
            policyRepo: new PolicyRepository(db),
            auditRepo: audit,
          },
          { tenantId: TENANT },
        ).processSingle(candidate),
      ).toThrow();
      expect(snapshot()).toEqual(before);
    },
  );

  it('rejects a promotion evaluated without its existing durable constraint', () => {
    const input = prepare('internal', [], 'reject', {
      metadata: { proposedByRole: 'member', filePaths: [], tags: [] },
    });
    governSelectedCandidates(input, db);
    const candidate = candidates.findById(input.selections[0]!.candidateId)!;
    expect(() =>
      promote(
        {
          candidate,
          contentHash: computeContentHash(candidate.content),
          pipelineResult: {
            candidateId: candidate.id,
            outcome: 'approved',
            evaluations: [],
          },
        },
        memories,
        audit,
      ),
    ).toThrow(/changed since policy evaluation/);
    expect(memories.findByTenant(TENANT)).toEqual([]);
  });

  it('rereads a constraint strengthened after the initial policy-bound observation and before commit', () => {
    const input = prepare('internal', [], 'reject', {
      metadata: { proposedByRole: 'member', filePaths: [], tags: [] },
    });
    governSelectedCandidates(input, db);
    const candidate = candidates.findById(input.selections[0]!.candidateId)!;
    const original = audit.findByMemoryAndTenant.bind(audit);
    let injected = false;
    vi.spyOn(audit, 'findByMemoryAndTenant').mockImplementation((id, tenant) => {
      const rows = original(id, tenant);
      if (!injected && id === candidate.id) {
        injected = true;
        recordCandidateMinimumSensitivity(
          candidate,
          'confidential',
          constraintContext(candidate.id),
          audit,
        );
      }
      return rows;
    });
    expect(() =>
      promote(
        {
          candidate,
          minimumSensitivity: 'internal',
          contentHash: computeContentHash(candidate.content),
          pipelineResult: { candidateId: candidate.id, outcome: 'approved', evaluations: [] },
        },
        memories,
        audit,
      ),
    ).toThrow(/changed before promotion commit/);
    expect(memories.findByTenant(TENANT)).toEqual([]);
    expect(resolveCandidateMinimumSensitivity(candidate, audit)).toBe('confidential');
  });

  it.each([
    'abort',
    'ignore',
    'constraint-drift',
    'floor-loss',
    'receipt-drift',
    'batch-floor-loss',
  ])('rolls back %s and retries the same plan after removing only the fault', (fault) => {
    const input = prepare('internal');
    let trigger: string;
    if (fault === 'abort' || fault === 'ignore' || fault === 'constraint-drift') {
      const statement =
        fault === 'abort'
          ? "SELECT RAISE(ABORT, 'injected floor fault');"
          : fault === 'ignore'
            ? 'SELECT RAISE(IGNORE);'
            : "UPDATE audit_events SET details_json = '{}' WHERE id = NEW.id;";
      trigger = `${fault === 'ignore' ? 'BEFORE' : 'AFTER'} INSERT ON audit_events
        WHEN json_extract(NEW.details_json, '$.kind') = 'recovery-sensitivity-floor-v1' BEGIN ${statement} END`;
    } else {
      const statement =
        fault === 'receipt-drift'
          ? "UPDATE audit_events SET details_json = '{}' WHERE id = NEW.id;"
          : "UPDATE curated_memories SET sensitivity = 'public';";
      const condition =
        fault === 'batch-floor-loss'
          ? "json_extract(NEW.details_json, '$.kind') = 'selected-govern-v1'"
          : "NEW.action = 'promoted'";
      trigger = `AFTER INSERT ON audit_events WHEN ${condition} BEGIN ${statement} END`;
    }
    db.exec(`CREATE TRIGGER floor_fault ${trigger}`);
    const before = snapshot();
    expect(() => governSelectedCandidates(input, db)).toThrow();
    expect(snapshot()).toEqual(before);
    db.exec('DROP TRIGGER floor_fault');
    const result = governSelectedCandidates(input, db);
    expect(memories.findById(result.outcomes[0]!.memoryId!)!.sensitivity).toBe('internal');
  });
});
