import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeContentHash, deriveAuditEventId } from '@qmd-team-intent-kb/common';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createDatabase,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { makeCandidate, makeMemory, makePolicy, TENANT } from './fixtures.js';
import { planMemoryRecovery } from '../recovery/recovery-plan.js';
import type { RecoveryPlan, RecoveryPlanInput } from '../recovery/recovery-plan.js';
import { memorySnapshotDigest } from '../recovery/source-archive.js';
import { applyRecoveryPlan, readRecoveryStatus } from '../recovery/recovery-application.js';
import { Curator } from '../curator.js';
import { resolveHold } from '../hold/resolve-hold.js';
import { intakeCandidate } from '../intake/candidate-intake.js';

let root: string;
let db: ReturnType<typeof createDatabase>;
let memories: MemoryRepository;
let candidates: CandidateRepository;
let audit: AuditRepository;
let input: RecoveryPlanInput;
let plan: RecoveryPlan;
const SECRET = 'fixture-recovery-origin';
function snapshot(): unknown {
  return Object.fromEntries(
    ['candidates', 'curated_memories', 'audit_events', 'memory_links', 'governance_policies'].map(
      (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  );
}
function apply() {
  return applyRecoveryPlan(plan, plan.digest, db, { originSecret: SECRET });
}
function replan(): void {
  plan = planMemoryRecovery(input, db, { origin: { secret: SECRET, channel: 'local-mcp' } });
}
function targetId(): string {
  return readRecoveryStatus(plan, plan.digest, db).entries[0]!.targetId!;
}
function mixedPlan(): void {
  db.prepare('DELETE FROM governance_policies').run();
  new PolicyRepository(db).insert(
    makePolicy({
      rules: [
        {
          id: 'secrets',
          type: 'secret_detection',
          action: 'reject',
          enabled: true,
          priority: 0,
          parameters: {},
        },
        {
          id: 'length',
          type: 'content_length',
          action: 'reject',
          enabled: true,
          priority: 1,
          parameters: { min: 1, max: 160 },
        },
        {
          id: 'sensitivity',
          type: 'sensitivity_gate',
          action: 'flag',
          enabled: true,
          priority: 2,
          parameters: {},
        },
        {
          id: 'relevance',
          type: 'relevance_score',
          action: 'flag',
          enabled: true,
          priority: 3,
          parameters: { minimumScore: 0.5 },
        },
      ],
    }),
  );
  const other = [
    makeMemory({
      tenantId: 'local',
      source: 'import',
      title: 'Billing escalation contact',
      content: 'Escalate the billing issue to fixture-contact@customer-example.com before Friday.',
      metadata: { filePaths: ['contact.md'], tags: [], audience: 'owner' },
    }),
    makeMemory({
      tenantId: 'local',
      source: 'import',
      title: 'Seasonal planting schedule',
      content:
        'Document the planting schedule with detailed observations about soil preparation, rainfall, seasonal temperatures, drainage, seed selection and harvest timing so the next operator can reproduce each recorded decision safely.',
      metadata: { filePaths: ['planting.md'], tags: ['planting'], audience: 'owner' },
    }),
    makeMemory({
      tenantId: 'local',
      source: 'manual',
      title: 'Brief operational note',
      category: 'reference',
      trustLevel: 'low',
      content: 'Short.',
      metadata: { filePaths: [], tags: [], audience: 'owner' },
    }),
  ];
  for (const source of other) memories.insert(source);
  input.selections = [
    ...input.selections,
    ...other.map((source) => ({ id: source.id, snapshotDigest: memorySnapshotDigest(source) })),
  ];
  replan();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recovery-application-'));
  db = createDatabase({ path: join(root, 'teamkb.db') });
  memories = new MemoryRepository(db);
  candidates = new CandidateRepository(db);
  audit = new AuditRepository(db);
  new PolicyRepository(db).insert(makePolicy());
  const source = makeMemory({
    tenantId: 'local',
    source: 'import',
    title: 'Orchard pruning guide',
    content: 'Prune orchard trees annually.',
    sensitivity: 'internal',
    trustLevel: 'high',
    metadata: {
      filePaths: ['orchard.md'],
      tags: ['orchard'],
      subjects: ['orchard.pruning'],
      audience: 'owner',
    },
  });
  const excluded = makeMemory({
    tenantId: 'local',
    title: 'Excluded tidal study',
    content: 'Keep the tidal study unchanged.',
  });
  memories.insert(source);
  memories.insert(excluded);
  const excludedTwo = makeMemory({
    tenantId: 'local',
    title: 'Excluded mountain projection',
    content: 'Retain the mountain projection note.',
  });
  memories.insert(excludedTwo);
  const queued = makeCandidate({ content: 'Unrelated inbox work.', title: 'Unrelated inbox' });
  candidates.insert(queued, computeContentHash(queued.content));
  input = {
    runId: randomUUID(),
    createdAt: '2026-10-26T04:15:00.000Z',
    storeLocator: join(root, 'teamkb.db'),
    sourceTenantId: 'local',
    targetTenantId: TENANT,
    selections: [{ id: source.id, snapshotDigest: memorySnapshotDigest(source) }],
    exclusions: [excluded, excludedTwo].map((source) => ({
      id: source.id,
      snapshotDigest: memorySnapshotDigest(source),
    })),
    actor: { type: 'human', id: 'fixture-operator' },
    role: 'owner',
    reason: 'Apply reviewed finite fixture recovery.',
  };
  replan();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('atomic same-store recovery application', () => {
  it('applies frozen proposal, enforces source floor, archives exact source and binds full plan receipt', () => {
    const before = snapshot() as Record<string, unknown[]>;
    const statusBefore = readRecoveryStatus(plan, plan.digest, db);
    expect(statusBefore.state).toBe('not_applied');
    expect(snapshot()).toEqual(before);
    const result = apply();
    expect(result.alreadyApplied).toBe(false);
    expect(result.status.state).toBe('complete');
    const entry = result.status.entries[0]!;
    const original = plan.entries[0]!.source;
    expect(memories.findById(original.id)).toEqual({
      ...original,
      lifecycle: 'archived',
      updatedAt: memories.findById(original.id)!.updatedAt,
    });
    const target = memories.findById(entry.targetId!)!;
    expect(target).toMatchObject({
      tenantId: TENANT,
      source: 'import',
      sensitivity: 'internal',
      trustLevel: 'medium',
      metadata: { ...original.metadata, proposedByRole: 'admin' },
      content: original.content,
    });
    expect(candidates.findById(entry.candidateId)?.status).toBe('promoted');
    expect(memories.findById(input.exclusions[0]!.id)?.lifecycle).toBe('active');
    const receipt = audit
      .findByMemoryAndTenant(plan.runId, TENANT)
      .find((e) => e.id === result.status.auditEventId)!;
    expect(receipt.details['planDigest']).toBe(plan.digest);
    expect(receipt.details['kind']).toBe('memory-recovery-apply-v1');
    expect(verifyAuditChain(audit).breaks).toEqual([]);
    const after = snapshot();
    expect(apply()).toEqual({ alreadyApplied: true, status: result.status });
    expect(snapshot()).toEqual(after);
  });
  it('runs status on a query-only connection without changing any rows', () => {
    apply();
    const before = snapshot();
    db.pragma('query_only = ON');
    expect(readRecoveryStatus(plan, plan.digest, db).state).toBe('complete');
    expect(snapshot()).toEqual(before);
  });
  it('accepts only exact already-captured proposals with canonical receipt', () => {
    const entry = plan.entries[0]!;
    intakeCandidate(entry.proposal, db, {
      actor: input.actor.id,
      role: 'admin',
      tenants: [TENANT],
    });
    expect(apply().status.state).toBe('complete');
  });
  it.each(['id', 'hash', 'unreceipted'] as const)(
    'refuses %s intake replay mismatch without changing existing work',
    (kind) => {
      const proposal = plan.entries[0]!.proposal;
      if (kind === 'unreceipted') candidates.insert(proposal, computeContentHash(proposal.content));
      else {
        const other = makeCandidate({
          ...proposal,
          id: kind === 'hash' ? randomUUID() : proposal.id,
          title: 'Different metadata on earlier proposal',
        });
        intakeCandidate(other, db, { actor: input.actor.id, role: 'admin', tenants: [TENANT] });
      }
      const before = snapshot();
      expect(() => apply()).toThrow();
      expect(snapshot()).toEqual(before);
    },
  );
  it.each(['policy', 'source', 'exclusion', 'target'] as const)(
    'refuses %s drift before new work',
    (kind) => {
      if (kind === 'policy')
        db.prepare('UPDATE governance_policies SET version = version + 1').run();
      if (kind === 'source')
        db.prepare('UPDATE curated_memories SET title = ? WHERE id = ?').run(
          'Changed source',
          input.selections[0]!.id,
        );
      if (kind === 'exclusion')
        db.prepare('UPDATE curated_memories SET title = ? WHERE id = ?').run(
          'Changed exclusion',
          input.exclusions[0]!.id,
        );
      if (kind === 'target')
        memories.insert(makeMemory({ content: plan.entries[0]!.source.content }));
      const before = snapshot();
      expect(() => apply()).toThrow();
      expect(snapshot()).toEqual(before);
    },
  );
  it('refuses unrelated historical run identity rather than adopting its settlement', () => {
    audit.insert({
      id: randomUUID(),
      action: 'governed',
      memoryId: plan.runId,
      tenantId: TENANT,
      actor: input.actor,
      reason: 'Unrelated historical run.',
      timestamp: input.createdAt,
      details: { kind: 'other-run' },
    });
    const before = snapshot();
    expect(() => apply()).toThrow(/run identity/);
    expect(snapshot()).toEqual(before);
  });
  it.each(['target', 'candidate', 'source', 'receipt', 'policy', 'exclusion'] as const)(
    'reports %s drift after historical success and refuses replay writes',
    (kind) => {
      const result = apply();
      if (kind === 'target') memories.updateLifecycle(targetId(), 'archived', input.createdAt);
      if (kind === 'candidate')
        db.prepare('UPDATE candidates SET title = ? WHERE id = ?').run(
          'Changed proposal',
          plan.entries[0]!.proposal.id,
        );
      if (kind === 'source')
        db.prepare('UPDATE curated_memories SET title = ? WHERE id = ?').run(
          'Changed source',
          input.selections[0]!.id,
        );
      if (kind === 'receipt')
        db.prepare('DELETE FROM audit_events WHERE id = ?').run(
          deriveAuditEventId(plan.entries[0]!.proposal.id, 'proposed'),
        );
      if (kind === 'policy')
        db.prepare('UPDATE governance_policies SET version = version + 1').run();
      if (kind === 'exclusion')
        db.prepare('UPDATE curated_memories SET title = ? WHERE id = ?').run(
          'Changed exclusion',
          input.exclusions[0]!.id,
        );
      const before = snapshot();
      const status = readRecoveryStatus(plan, plan.digest, db);
      expect(status.state).toBe('drifted');
      expect(status.entries[0]!.historicalOutcome).toBe('promoted');
      expect(status.auditEventId).toBe(result.status.auditEventId);
      expect(() => apply()).toThrow(/drift/);
      expect(snapshot()).toEqual(before);
    },
  );
  it('retains unadmitted sources for canonical origin refusal and replays partial outcomes honestly', () => {
    const result = applyRecoveryPlan(plan, plan.digest, db, { originSecret: 'wrong-fixture-key' });
    expect(result.status.state).toBe('partial');
    expect(result.status.entries[0]!.historicalOutcome).toBe('rejected');
    expect(memories.findById(input.selections[0]!.id)).toEqual(plan.entries[0]!.source);
    expect(result.status.entries[0]!.archived).toBe(false);
    const before = snapshot();
    expect(apply().alreadyApplied).toBe(true);
    expect(snapshot()).toEqual(before);
  });
  it.each(['proposed', 'promoted', 'archived', 'final'] as const)(
    'rolls back %s receipt ABORT and retries identical plan',
    (stage) => {
      const condition =
        stage === 'final'
          ? "json_extract(NEW.details_json, '$.kind') = 'memory-recovery-apply-v1'"
          : `NEW.action = '${stage}'`;
      db.exec(
        `CREATE TRIGGER recovery_fault BEFORE INSERT ON audit_events WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'injected recovery fault'); END`,
      );
      const before = snapshot();
      expect(() => apply()).toThrow();
      expect(snapshot()).toEqual(before);
      db.exec('DROP TRIGGER recovery_fault');
      expect(apply().status.state).toBe('complete');
    },
  );
  it.each(['proposed', 'promoted', 'archived', 'final'] as const)(
    'rolls back %s ignored receipt and retries identical plan',
    (stage) => {
      const condition =
        stage === 'final'
          ? "json_extract(NEW.details_json, '$.kind') = 'memory-recovery-apply-v1'"
          : `NEW.action = '${stage}'`;
      db.exec(
        `CREATE TRIGGER recovery_fault BEFORE INSERT ON audit_events WHEN ${condition} BEGIN SELECT RAISE(IGNORE); END`,
      );
      const before = snapshot();
      expect(() => apply()).toThrow();
      expect(snapshot()).toEqual(before);
      db.exec('DROP TRIGGER recovery_fault');
      expect(apply().status.state).toBe('complete');
    },
  );
  it.each(['source', 'candidate', 'target', 'proposal-receipt', 'exclusion'] as const)(
    'rolls back %s drift induced by final apply receipt',
    (kind) => {
      const actions: Record<string, string> = {
        source: `UPDATE curated_memories SET title = 'Changed source' WHERE id = '${input.selections[0]!.id}';`,
        candidate: `UPDATE candidates SET title = 'Changed candidate' WHERE id = '${plan.entries[0]!.proposal.id}';`,
        target: `UPDATE curated_memories SET title = 'Changed target' WHERE tenant_id = '${TENANT}';`,
        'proposal-receipt': `UPDATE audit_events SET reason = 'Changed proposal receipt' WHERE id = '${deriveAuditEventId(plan.entries[0]!.proposal.id, 'proposed')}';`,
        exclusion: `UPDATE curated_memories SET title = 'Changed exclusion' WHERE id = '${input.exclusions[0]!.id}';`,
      };
      db.exec(
        `CREATE TRIGGER recovery_fault AFTER INSERT ON audit_events WHEN json_extract(NEW.details_json, '$.kind') = 'memory-recovery-apply-v1' BEGIN ${actions[kind]} END`,
      );
      const before = snapshot();
      expect(() => apply()).toThrow();
      expect(snapshot()).toEqual(before);
      db.exec('DROP TRIGGER recovery_fault');
      expect(apply().status.state).toBe('complete');
    },
  );
  it('rolls back through an enclosing transaction', () => {
    const before = snapshot();
    expect(() =>
      db
        .transaction(() => {
          apply();
          throw new Error('outer rollback');
        })
        .immediate(),
    ).toThrow('outer rollback');
    expect(snapshot()).toEqual(before);
    expect(apply().status.state).toBe('complete');
  });
  it('commits mixed canonical promotion, hold, rejection and flag with only the promoted source archived', () => {
    mixedPlan();
    const originals = plan.entries.map((entry) => entry.source);
    const excluded = input.exclusions.map((binding) => memories.findById(binding.id));
    const unrelated = candidates
      .findByStatus('inbox', TENANT)
      .filter((row) => !plan.entries.some((entry) => entry.proposal.id === row.id));
    const result = apply();
    expect(result.status.state).toBe('partial');
    expect(result.status.entries.map((entry) => entry.historicalOutcome)).toEqual([
      'promoted',
      'held',
      'rejected',
      'flagged',
    ]);
    expect(result.status.entries.map((entry) => entry.archived)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    for (const source of originals.slice(1)) expect(memories.findById(source.id)).toEqual(source);
    expect(input.exclusions.map((binding) => memories.findById(binding.id))).toEqual(excluded);
    for (const row of unrelated) expect(candidates.findById(row.id)).toEqual(row);
    const before = snapshot();
    expect(apply()).toEqual({ alreadyApplied: true, status: result.status });
    expect(snapshot()).toEqual(before);
    expect(verifyAuditChain(audit).breaks).toEqual([]);
  });
  it('reports later canonical hold release as requiring finalization, without archiving its source', () => {
    mixedPlan();
    apply();
    const entry = plan.entries[1]!;
    const released = resolveHold(
      {
        candidateId: entry.proposal.id,
        tenantId: TENANT,
        resolution: 'release',
        audience: 'owner',
        actor: input.actor,
        role: 'owner',
        reason: 'Review the held synthetic contact.',
      },
      {
        candidateRepo: candidates,
        memoryRepo: memories,
        policyRepo: new PolicyRepository(db),
        auditRepo: audit,
      },
      { originSecret: SECRET },
    );
    expect(released.ok).toBe(true);
    const before = snapshot();
    const status = readRecoveryStatus(plan, plan.digest, db);
    expect(status.state).toBe('drifted');
    expect(status.entries[1]!.historicalOutcome).toBe('held');
    expect(status.entries[1]!.problems).toContain('later_review_requires_finalization');
    expect(status.entries[1]!.archived).toBe(false);
    expect(memories.findById(entry.source.id)).toEqual(entry.source);
    expect(() => apply()).toThrow(/drift/);
    expect(snapshot()).toEqual(before);
  });
  it.each(['earlier-source', 'earlier-proposal'] as const)(
    'rolls back %s drift during later source archival',
    (kind) => {
      const second = makeMemory({
        tenantId: 'local',
        source: 'import',
        title: 'Irrigation pressure settings',
        content: 'Inspect irrigation pressure weekly.',
        metadata: { filePaths: ['irrigation.md'], tags: ['irrigation'], audience: 'owner' },
      });
      memories.insert(second);
      input.selections = [
        ...input.selections,
        { id: second.id, snapshotDigest: memorySnapshotDigest(second) },
      ];
      replan();
      const statement =
        kind === 'earlier-source'
          ? `UPDATE curated_memories SET title = 'Changed earlier source' WHERE id = '${input.selections[0]!.id}';`
          : `UPDATE audit_events SET reason = 'Changed earlier proposal' WHERE id = '${deriveAuditEventId(plan.entries[0]!.proposal.id, 'proposed')}';`;
      db.exec(
        `CREATE TRIGGER recovery_fault AFTER INSERT ON audit_events WHEN NEW.action = 'archived' AND NEW.memory_id = '${second.id}' BEGIN ${statement} END`,
      );
      const before = snapshot();
      expect(() => apply()).toThrow();
      expect(snapshot()).toEqual(before);
      db.exec('DROP TRIGGER recovery_fault');
      expect(apply().status.state).toBe('complete');
    },
  );
  it('refuses a changed unresolved source instead of binding a post-govern snapshot', () => {
    mixedPlan();
    const heldSource = plan.entries[1]!.source.id;
    db.exec(
      `CREATE TRIGGER recovery_fault AFTER INSERT ON audit_events WHEN json_extract(NEW.details_json, '$.kind') = 'selected-govern-v1' BEGIN UPDATE curated_memories SET title = 'Changed unresolved source' WHERE id = '${heldSource}'; END`,
    );
    const before = snapshot();
    expect(() => apply()).toThrow();
    expect(snapshot()).toEqual(before);
    db.exec('DROP TRIGGER recovery_fault');
    expect(apply().status.state).toBe('partial');
  });
  it('retains an unrelated expired hold and its receipts without an expiry sweep', () => {
    const held = makeCandidate({
      title: 'Unrelated old held question',
      content: 'A different question awaits a human.',
      metadata: { filePaths: [], tags: [], audience: 'owner', proposedByRole: 'member' },
    });
    candidates.insert(held, computeContentHash(held.content));
    new Curator(
      {
        candidateRepo: candidates,
        memoryRepo: memories,
        policyRepo: new PolicyRepository(db),
        auditRepo: audit,
      },
      { tenantId: TENANT, now: () => '2020-01-01T00:00:00.000Z' },
    ).processSingle(held);
    expect(candidates.findById(held.id)?.status).toBe('quarantined');
    const row = candidates.findById(held.id);
    const receipts = audit.findByMemoryAndTenant(held.id, TENANT);
    expect(receipts.some((event) => event.action === 'held')).toBe(true);
    expect(apply().status.state).toBe('complete');
    expect(candidates.findById(held.id)).toEqual(row);
    expect(audit.findByMemoryAndTenant(held.id, TENANT)).toEqual(receipts);
  });
});
