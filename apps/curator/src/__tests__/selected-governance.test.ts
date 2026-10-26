import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createDatabase,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Curator } from '../curator.js';
import {
  candidateSnapshotDigest,
  governSelectedCandidates,
} from '../recovery/selected-governance.js';
import type { SelectedGovernanceInput } from '../recovery/selected-governance.js';
import {
  makeAttestedCandidate,
  makeCandidate,
  makeMemory,
  makePolicy,
  TENANT,
} from './fixtures.js';

let root: string;
let db: ReturnType<typeof createDatabase>;
let candidates: CandidateRepository;
let memories: MemoryRepository;
let audit: AuditRepository;
let policies: PolicyRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'selected-governance-'));
  db = createDatabase({ path: join(root, 'teamkb.db') });
  candidates = new CandidateRepository(db);
  memories = new MemoryRepository(db);
  audit = new AuditRepository(db);
  policies = new PolicyRepository(db);
  policies.insert(makePolicy());
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seed(overrides: Parameters<typeof makeCandidate>[0] = {}): MemoryCandidate {
  const candidate = makeCandidate(overrides);
  candidates.insert(candidate, computeContentHash(candidate.content));
  return candidate;
}

function input(
  rows: MemoryCandidate[],
  overrides: Partial<SelectedGovernanceInput> = {},
): SelectedGovernanceInput {
  return {
    runId: randomUUID(),
    tenantId: TENANT,
    selections: rows.map((row) => ({
      candidateId: row.id,
      snapshotDigest: candidateSnapshotDigest(row),
    })),
    actor: { type: 'human', id: 'fixture-operator' },
    role: 'owner',
    reason: 'Govern this finite reviewed fixture manifest.',
    ...overrides,
  };
}

function snapshot(): unknown {
  return Object.fromEntries(
    ['candidates', 'curated_memories', 'audit_events', 'memory_links', 'governance_policies'].map(
      (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  );
}

describe('finite canonical governance on a real file-backed store', () => {
  it('governs exactly the selected snapshot and preserves every unrelated row', () => {
    const other = Array.from({ length: 110 }, (_, n) =>
      seed({ content: `Unselected fixture note ${n}.`, title: `Unselected ${n}` }),
    );
    const quarantined = Array.from({ length: 3 }, () => seed({ status: 'quarantined' }));
    const row = seed({
      metadata: { filePaths: ['guide.md'], tags: ['fixture'], subjects: ['fixture.topic'] },
    });
    const beforeRows = [...other, ...quarantined].map((item) => candidates.findById(item.id));
    const result = governSelectedCandidates(input([row]), db);
    expect(result.alreadySettled).toBe(false);
    expect(result.outcomes).toEqual([
      { candidateId: row.id, outcome: 'promoted', memoryId: expect.any(String) },
    ]);
    expect(candidates.findById(row.id)).toEqual({ ...row, status: 'promoted' });
    expect([...other, ...quarantined].map((item) => candidates.findById(item.id))).toEqual(
      beforeRows,
    );
    const memory = memories.findById(result.outcomes[0]!.memoryId!)!;
    expect(memory).toMatchObject({
      content: row.content,
      metadata: row.metadata,
      candidateId: row.id,
      tenantId: TENANT,
    });
    expect(audit.findByTenant(TENANT)).toHaveLength(2);
    expect(verifyAuditChain(audit)).toMatchObject({ totalRows: 2, cleanRows: 2, breaks: [] });
    expect(audit.findByMemoryAndTenant(result.runId, TENANT)[0]!.details).not.toHaveProperty(
      'content',
    );
  });

  it('repeats the same manifest without another disposition or receipt', () => {
    const plan = input([seed()]);
    const first = governSelectedCandidates(plan, db);
    const before = snapshot();
    expect(governSelectedCandidates(plan, db)).toEqual({ ...first, alreadySettled: true });
    expect(snapshot()).toEqual(before);
  });

  it('refuses a different manifest under an already-settled run identity', () => {
    const plan = input([seed()]);
    governSelectedCandidates(plan, db);
    const before = snapshot();
    expect(() =>
      governSelectedCandidates(
        { ...plan, selections: [{ ...plan.selections[0]!, snapshotDigest: '0'.repeat(64) }] },
        db,
      ),
    ).toThrow('different manifest');
    expect(snapshot()).toEqual(before);
  });

  it.each(['missing', 'foreign', 'drifted', 'terminal', 'admitted', 'duplicate-binding'] as const)(
    'refuses %s bindings before settling a valid preceding candidate',
    (mode) => {
      const valid = seed();
      const second = seed({
        content: 'Another independently selected fixture note.',
        title: 'Second distinct topic',
      });
      const plan = input([valid, second]);
      if (mode === 'missing')
        plan.selections = [
          ...plan.selections.slice(0, 1),
          { candidateId: randomUUID(), snapshotDigest: candidateSnapshotDigest(second) },
        ];
      if (mode === 'foreign') plan.tenantId = 'other-tenant';
      if (mode === 'drifted') candidates.updateStatus(second.id, 'duplicate', TENANT);
      if (mode === 'terminal') {
        candidates.updateStatus(second.id, 'rejected', TENANT);
        plan.selections = [
          plan.selections[0]!,
          {
            candidateId: second.id,
            snapshotDigest: candidateSnapshotDigest(candidates.findById(second.id)!),
          },
        ];
      }
      if (mode === 'admitted')
        memories.insert(makeMemory({ candidateId: second.id, content: second.content }));
      if (mode === 'duplicate-binding')
        plan.selections = [plan.selections[0]!, plan.selections[0]!];
      const before = snapshot();
      expect(() => governSelectedCandidates(plan, db)).toThrow();
      expect(snapshot()).toEqual(before);
    },
  );

  it('requires an existing enabled policy without seeding one', () => {
    const row = seed();
    db.prepare('DELETE FROM governance_policies').run();
    const before = snapshot();
    expect(() => governSelectedCandidates(input([row]), db)).toThrow('existing enabled');
    expect(snapshot()).toEqual(before);
  });

  it.each(['agent', 'member', 'blank-reason', 'empty', 'oversized', 'above-standing'] as const)(
    'refuses %s authority or manifest without mutation',
    (mode) => {
      const row = seed({ metadata: { audience: 'owner' } });
      const plan = input([row]);
      if (mode === 'agent') plan.actor = { type: 'ai', id: 'fixture-agent' };
      if (mode === 'member') (plan as { role: string }).role = 'member';
      if (mode === 'blank-reason') plan.reason = ' ';
      if (mode === 'empty') plan.selections = [];
      if (mode === 'oversized')
        plan.selections = Array.from({ length: 101 }, () => plan.selections[0]!);
      if (mode === 'above-standing') plan.role = 'admin';
      const before = snapshot();
      expect(() => governSelectedCandidates(plan, db)).toThrow();
      expect(snapshot()).toEqual(before);
    },
  );

  it('binds metadata in the digest and normalizes object-key order', () => {
    const row = seed({ metadata: { filePaths: ['one.md'], tags: ['reviewed'] } });
    const reordered = { ...row, metadata: { tags: ['reviewed'], filePaths: ['one.md'] } };
    expect(candidateSnapshotDigest(reordered)).toBe(candidateSnapshotDigest(row));
    expect(
      candidateSnapshotDigest({ ...row, metadata: { ...row.metadata, tags: ['changed'] } }),
    ).not.toBe(candidateSnapshotDigest(row));
    const plan = input([row]);
    plan.selections = [
      {
        candidateId: row.id,
        snapshotDigest: candidateSnapshotDigest({
          ...row,
          metadata: { ...row.metadata, tags: ['changed'] },
        }),
      },
    ];
    const before = snapshot();
    expect(() => governSelectedCandidates(plan, db)).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('verifies valid capture provenance through the canonical gate', () => {
    const secret = 'synthetic-selected-origin';
    const row = makeAttestedCandidate(secret);
    candidates.insert(row, computeContentHash(row.content));
    const result = governSelectedCandidates(input([row]), db, { originSecret: secret });
    const receipt = audit
      .findByMemoryAndTenant(result.outcomes[0]!.memoryId!, TENANT)
      .find((event) => event.action === 'promoted')!;
    expect(receipt.details).toMatchObject({ candidateId: row.id, originChannel: 'local-mcp' });
    expect(JSON.stringify(receipt)).not.toContain(row.origin!.tokenHmac);
  });

  it.each(['flagged', 'held'] as const)(
    'retains canonical %s work without admitting or resolving it',
    (outcome) => {
      db.prepare('DELETE FROM governance_policies').run();
      policies.insert(
        makePolicy({
          rules: [
            {
              id: 'fixture-review',
              type: outcome === 'flagged' ? 'relevance_score' : 'sensitivity_gate',
              action: 'flag',
              enabled: true,
              priority: 0,
              parameters: { minimumScore: 0.99 },
            },
          ],
        }),
      );
      const row = seed({
        title: 'note',
        category: 'reference',
        trustLevel: 'low',
        content:
          outcome === 'flagged'
            ? 'Short.'
            : 'Escalate the billing issue to dana.whitfield@customer-example.com before Friday.',
      });
      const plan = input([row]);
      const result = governSelectedCandidates(plan, db);
      expect(result.outcomes).toEqual([{ candidateId: row.id, outcome }]);
      expect(candidates.findById(row.id)?.status).toBe(
        outcome === 'held' ? 'quarantined' : 'inbox',
      );
      expect(memories.count()).toBe(0);
      expect(
        audit
          .findByMemoryAndTenant(row.id, TENANT)
          .some((event) => event.action === (outcome === 'held' ? 'held' : 'deleted')),
      ).toBe(true);
      const before = snapshot();
      expect(governSelectedCandidates(plan, db).alreadySettled).toBe(true);
      expect(snapshot()).toEqual(before);
    },
  );

  it('rolls back the whole selected run when an enclosing transaction aborts', () => {
    const plan = input([seed()]);
    const before = snapshot();
    expect(() =>
      db
        .transaction(() => {
          governSelectedCandidates(plan, db);
          throw new Error('enclosing fixture abort');
        })
        .immediate(),
    ).toThrow('enclosing fixture abort');
    expect(snapshot()).toEqual(before);
    expect(governSelectedCandidates(plan, db).alreadySettled).toBe(false);
  });

  it.each(['subject', 'title'] as const)(
    'refuses %s supersession and rolls back an earlier promotion',
    (basis) => {
      const protectedMemory = makeMemory({
        title: 'Latest operational routing decision',
        category: 'decision',
        content: 'Newer protected team operational knowledge stays active.',
        promotedAt: '2026-10-25T12:00:00.000Z',
        metadata: {
          filePaths: [],
          tags: [],
          ...(basis === 'subject' ? { subjects: ['routing.current'] } : {}),
        },
      });
      memories.insert(protectedMemory);
      const valid = seed({ title: 'Independent fixture convention' });
      const conflict = seed({
        title: basis === 'title' ? protectedMemory.title : 'Older differently titled decision',
        category: 'decision',
        content:
          'Old source recaptured with a fresh timestamp must not replace newer team knowledge.',
        capturedAt: '2026-10-26T12:00:00.000Z',
        metadata: {
          filePaths: [],
          tags: [],
          ...(basis === 'subject' ? { subjects: ['routing.current'] } : {}),
        },
      });
      const before = snapshot();
      expect(() => governSelectedCandidates(input([valid, conflict]), db)).toThrow(
        'unapproved supersession',
      );
      expect(snapshot()).toEqual(before);
    },
  );

  it('preserves member quarantine and canonical origin rejection without admission', () => {
    const member = seed({ metadata: { proposedByRole: 'member' } });
    const attested = makeAttestedCandidate('synthetic-fixture-origin', {
      content: 'Separate origin-gated fixture knowledge.',
      title: 'Attested fixture',
    });
    candidates.insert(attested, computeContentHash(attested.content));
    const result = governSelectedCandidates(input([member, attested]), db);
    expect(result.outcomes).toEqual([
      { candidateId: member.id, outcome: 'quarantined' },
      { candidateId: attested.id, outcome: 'rejected' },
    ]);
    expect(candidates.findById(member.id)?.status).toBe('quarantined');
    expect(candidates.findById(attested.id)?.status).toBe('rejected');
    expect(memories.count()).toBe(0);
    expect(audit.findByMemoryAndTenant(attested.id, TENANT)).toHaveLength(1);
  });

  it('retains duplicate outcomes and does not invent an admitted target', () => {
    const row = seed();
    memories.insert(makeMemory({ content: row.content }));
    const result = governSelectedCandidates(input([row]), db);
    expect(result.outcomes).toEqual([{ candidateId: row.id, outcome: 'duplicate' }]);
    expect(candidates.findById(row.id)?.status).toBe('duplicate');
    expect(memories.count()).toBe(1);
  });

  it.each([
    'batch-ignore',
    'promotion-ignore',
    'rejection-ignore',
    'status-ignore',
    'audit-abort',
  ] as const)(
    'rolls back %s, then the identical request succeeds after removing only the trigger',
    (fault) => {
      const attested = makeAttestedCandidate('synthetic-fixture-origin');
      const row = fault === 'rejection-ignore' ? attested : makeCandidate();
      candidates.insert(row, computeContentHash(row.content));
      const plan = input([row]);
      const clauses: Record<typeof fault, string> = {
        'batch-ignore':
          "BEFORE INSERT ON audit_events WHEN NEW.action = 'governed' BEGIN SELECT RAISE(IGNORE); END",
        'promotion-ignore':
          "BEFORE INSERT ON audit_events WHEN NEW.action = 'promoted' BEGIN SELECT RAISE(IGNORE); END",
        'rejection-ignore':
          "BEFORE INSERT ON audit_events WHEN NEW.action = 'deleted' BEGIN SELECT RAISE(IGNORE); END",
        'status-ignore': 'BEFORE UPDATE ON candidates BEGIN SELECT RAISE(IGNORE); END',
        'audit-abort':
          "BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture receipt abort'); END",
      };
      db.exec(`CREATE TEMP TRIGGER selected_fault ${clauses[fault]}`);
      const before = snapshot();
      expect(() => governSelectedCandidates(plan, db)).toThrow();
      expect(snapshot()).toEqual(before);
      db.exec('DROP TRIGGER selected_fault');
      expect(governSelectedCandidates(plan, db).alreadySettled).toBe(false);
      expect(verifyAuditChain(audit).breaks).toEqual([]);
    },
  );

  it('does not honor unsupported runtime tenant or dry-run overrides', () => {
    const row = seed();
    const result = governSelectedCandidates(input([row]), db, {
      tenantId: 'other-tenant',
      dryRun: true,
    } as never);
    expect(memories.findById(result.outcomes[0]!.memoryId!)?.tenantId).toBe(TENANT);
    expect(candidates.findById(row.id)?.status).toBe('promoted');
  });

  it.each(['later-row', 'current-row', 'batch-receipt'] as const)(
    'rolls back %s snapshot drift inside the selected transaction',
    (mode) => {
      const first = seed();
      const second = seed({
        title: 'Another independent topic',
        content: 'A separate selected candidate for transactional drift verification.',
      });
      const plan = input([first, second]);
      const changedId = mode === 'later-row' ? second.id : first.id;
      const action = mode === 'batch-receipt' ? 'governed' : 'promoted';
      db.exec(
        `CREATE TEMP TRIGGER selected_drift AFTER INSERT ON audit_events WHEN NEW.action = '${action}' BEGIN UPDATE candidates SET content = 'Changed by a synthetic same-connection trigger.' WHERE id = '${changedId}'; END`,
      );
      const before = snapshot();
      expect(() => governSelectedCandidates(plan, db)).toThrow();
      expect(snapshot()).toEqual(before);
      db.exec('DROP TRIGGER selected_drift');
      expect(governSelectedCandidates(plan, db).outcomes.map((item) => item.outcome)).toEqual([
        'promoted',
        'promoted',
      ]);
    },
  );

  it('retains the canonical full-hold-queue refusal and all unrelated active holds', () => {
    db.prepare('DELETE FROM governance_policies').run();
    policies.insert(
      makePolicy({
        rules: [
          {
            id: 'fixture-sensitivity',
            type: 'sensitivity_gate',
            action: 'flag',
            enabled: true,
            priority: 0,
            parameters: {},
          },
        ],
      }),
    );
    const existing = seed({
      title: 'Existing held question',
      content: 'Ask dana.whitfield@customer-example.com about billing.',
    });
    const deps = {
      candidateRepo: candidates,
      memoryRepo: memories,
      policyRepo: policies,
      auditRepo: audit,
    };
    expect(
      new Curator(deps, { tenantId: TENANT, holdLimits: { maxActiveHolds: 1 } }).processSingle(
        existing,
      ).outcome,
    ).toBe('held');
    const beforeExisting = candidates.findById(existing.id);
    const beforeReceipts = audit.findByMemoryAndTenant(existing.id, TENANT);
    const selected = seed({
      title: 'Another review question',
      content: 'Ask laura.west@customer-example.com about the next billing question.',
    });
    const result = governSelectedCandidates(input([selected]), db, {
      holdLimits: { maxActiveHolds: 1 },
    });
    expect(result.outcomes).toEqual([{ candidateId: selected.id, outcome: 'flagged' }]);
    expect(candidates.findById(selected.id)?.status).toBe('inbox');
    expect(memories.count()).toBe(0);
    expect(candidates.findById(existing.id)).toEqual(beforeExisting);
    expect(audit.findByMemoryAndTenant(existing.id, TENANT)).toEqual(beforeReceipts);
    expect(
      audit.findByMemoryAndTenant(selected.id, TENANT).filter((event) => event.action === 'held'),
    ).toHaveLength(0);
    expect(verifyAuditChain(audit).breaks).toEqual([]);
  });

  it('leaves unrelated expired holds and their receipts untouched', () => {
    const held = seed({ metadata: { audience: 'owner', proposedByRole: 'member' } });
    new Curator(
      { candidateRepo: candidates, memoryRepo: memories, policyRepo: policies, auditRepo: audit },
      { tenantId: TENANT, now: () => '2020-01-01T00:00:00.000Z' },
    ).processSingle(held);
    expect(candidates.findById(held.id)?.status).toBe('quarantined');
    const heldBefore = candidates.findById(held.id);
    const receipts = audit.findByMemoryAndTenant(held.id, TENANT);
    expect(receipts.some((event) => event.action === 'held')).toBe(true);
    governSelectedCandidates(input([seed({ title: 'Unrelated fresh fixture' })]), db);
    expect(candidates.findById(held.id)).toEqual(heldBefore);
    expect(audit.findByMemoryAndTenant(held.id, TENANT)).toEqual(receipts);
  });

  it.each(['held', 'flagged', 'rejected', 'batch'] as const)(
    'rolls back %s receipt loss or drift during final batch insertion',
    (outcome) => {
      if (outcome === 'held' || outcome === 'flagged') {
        db.prepare('DELETE FROM governance_policies').run();
        policies.insert(
          makePolicy({
            rules: [
              {
                id: 'fixture-review',
                type: outcome === 'held' ? 'sensitivity_gate' : 'relevance_score',
                action: 'flag',
                enabled: true,
                priority: 0,
                parameters: { minimumScore: 0.99 },
              },
            ],
          }),
        );
      }
      const candidate =
        outcome === 'rejected'
          ? makeAttestedCandidate('synthetic-unverifiable-origin')
          : makeCandidate({
              title: 'note',
              content:
                outcome === 'held'
                  ? 'Ask laura.west@customer-example.com about billing.'
                  : outcome === 'flagged'
                    ? 'Short.'
                    : 'Independent fixture note for final batch receipt verification.',
            });
      candidates.insert(candidate, computeContentHash(candidate.content));
      const plan = input([candidate]);
      const mutation =
        outcome === 'batch'
          ? "UPDATE audit_events SET details_json = '{}' WHERE id = NEW.id;"
          : `DELETE FROM audit_events WHERE memory_id = '${candidate.id}' AND action = '${outcome === 'held' ? 'held' : 'deleted'}';`;
      db.exec(
        `CREATE TEMP TRIGGER selected_receipt_drift AFTER INSERT ON audit_events WHEN NEW.action = 'governed' BEGIN ${mutation} END`,
      );
      const before = snapshot();
      expect(() => governSelectedCandidates(plan, db)).toThrow(
        'receipt changed or was not persisted',
      );
      expect(snapshot()).toEqual(before);
      db.exec('DROP TRIGGER selected_receipt_drift');
      expect(governSelectedCandidates(plan, db).alreadySettled).toBe(false);
      expect(verifyAuditChain(audit).breaks).toEqual([]);
    },
  );

  it.each(['title', 'content_hash'] as const)(
    'refuses promoted %s drift during the final batch insertion',
    (column) => {
      const row = seed();
      const plan = input([row]);
      const value =
        column === 'content_hash' ? '0'.repeat(64) : 'Changed by a synthetic final-batch trigger.';
      db.exec(
        `CREATE TEMP TRIGGER selected_memory_drift AFTER INSERT ON audit_events WHEN NEW.action = 'governed' BEGIN UPDATE curated_memories SET ${column} = '${value}' WHERE candidate_id = '${row.id}'; END`,
      );
      const before = snapshot();
      expect(() => governSelectedCandidates(plan, db)).toThrow('Selected promotion');
      expect(snapshot()).toEqual(before);
      db.exec('DROP TRIGGER selected_memory_drift');
      expect(governSelectedCandidates(plan, db).outcomes[0]!.outcome).toBe('promoted');
      expect(verifyAuditChain(audit).breaks).toEqual([]);
    },
  );
});
