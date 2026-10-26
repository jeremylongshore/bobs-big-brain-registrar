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
import {
  candidateSnapshotDigest,
  governSelectedCandidates,
} from '../recovery/selected-governance.js';
import {
  archiveRecoveredSource,
  auditEventSnapshotDigest,
  memorySnapshotDigest,
} from '../recovery/source-archive.js';
import type { RecoverySourceArchiveInput } from '../recovery/source-archive.js';

let root: string;
let db: ReturnType<typeof createDatabase>;
let memories: MemoryRepository;
let candidates: CandidateRepository;
let audit: AuditRepository;
let input: RecoverySourceArchiveInput;

function snapshot(): unknown {
  return Object.fromEntries(
    ['candidates', 'curated_memories', 'audit_events', 'memory_links', 'governance_policies'].map(
      (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  );
}

function rebind(): void {
  input.source.snapshotDigest = memorySnapshotDigest(memories.findById(input.source.id)!);
  input.target.snapshotDigest = memorySnapshotDigest(memories.findById(input.target.id)!);
  input.candidate.snapshotDigest = candidateSnapshotDigest(
    candidates.findById(input.candidate.id)!,
  );
  for (const [binding, memoryId] of [
    [input.promotionReceipt, input.target.id],
    [input.settlementReceipt, input.runId],
  ] as const) {
    const event = audit
      .findByMemoryAndTenant(memoryId, TENANT)
      .find((item) => item.id === binding.id);
    if (event) binding.snapshotDigest = auditEventSnapshotDigest(event);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recovery-source-archive-'));
  db = createDatabase({ path: join(root, 'teamkb.db') });
  memories = new MemoryRepository(db);
  candidates = new CandidateRepository(db);
  audit = new AuditRepository(db);
  new PolicyRepository(db).insert(makePolicy());
  const candidate = makeCandidate({
    metadata: { filePaths: ['guide.md'], tags: ['fixture'], subjects: ['fixture.topic'] },
  });
  const source = makeMemory({
    tenantId: 'local',
    sensitivity: 'public',
    content: candidate.content,
    title: candidate.title,
    category: candidate.category,
    trustLevel: candidate.trustLevel,
    metadata: candidate.metadata,
  });
  memories.insert(source);
  candidates.insert(candidate, computeContentHash(candidate.content));
  const runId = randomUUID();
  const result = governSelectedCandidates(
    {
      runId,
      tenantId: TENANT,
      selections: [
        { candidateId: candidate.id, snapshotDigest: candidateSnapshotDigest(candidate) },
      ],
      actor: { type: 'human', id: 'fixture-operator' },
      role: 'owner',
      reason: 'Govern finite fixture recovery.',
    },
    db,
  );
  const targetId = result.outcomes[0]!.memoryId!;
  input = {
    runId,
    sourceTenantId: 'local',
    targetTenantId: TENANT,
    source: { id: source.id, snapshotDigest: '' },
    target: { id: targetId, snapshotDigest: '' },
    candidate: { id: candidate.id, snapshotDigest: '' },
    promotionReceipt: { id: deriveAuditEventId(targetId, 'promoted'), snapshotDigest: '' },
    settlementReceipt: { id: result.auditEventId, snapshotDigest: '' },
    actor: { type: 'human', id: 'fixture-operator' },
    role: 'owner',
    reason: 'Archive only after verified recovery.',
  };
  rebind();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('conditional recovery source archival on a file-backed store', () => {
  it('archives only the exact source and retains payload, current target and unrelated work', () => {
    const source = memories.findById(input.source.id)!;
    const target = memories.findById(input.target.id)!;
    const unrelated = makeMemory({ tenantId: 'other-team' });
    memories.insert(unrelated);
    const queued = makeCandidate({ content: 'Unrelated queued fixture.' });
    candidates.insert(queued, computeContentHash(queued.content));
    const result = archiveRecoveredSource(input, db);
    expect(result.alreadyArchived).toBe(false);
    const archived = memories.findById(source.id)!;
    expect(archived).toEqual({ ...source, lifecycle: 'archived', updatedAt: archived.updatedAt });
    expect(memories.findById(target.id)).toEqual(target);
    expect(memories.findById(unrelated.id)).toEqual(unrelated);
    expect(candidates.findById(queued.id)).toEqual(queued);
    const receipt = audit
      .findByMemoryAndTenant(source.id, 'local')
      .find((event) => event.id === result.auditEventId)!;
    expect(receipt).toMatchObject({
      action: 'archived',
      actor: input.actor,
      reason: input.reason,
      timestamp: archived.updatedAt,
      details: {
        from: 'active',
        to: 'archived',
        targetId: target.id,
        runId: input.runId,
        archivedSnapshotDigest: memorySnapshotDigest(archived),
      },
    });
    expect(verifyAuditChain(audit).breaks).toEqual([]);
    const after = snapshot();
    expect(archiveRecoveredSource(input, db)).toEqual({ ...result, alreadyArchived: true });
    expect(snapshot()).toEqual(after);
  });

  it.each(['source', 'target', 'candidate', 'promotionReceipt', 'settlementReceipt'] as const)(
    'refuses drifted %s binding without writes',
    (binding) => {
      input[binding].snapshotDigest = 'a'.repeat(64);
      const before = snapshot();
      expect(() => archiveRecoveredSource(input, db)).toThrow();
      expect(snapshot()).toEqual(before);
    },
  );

  it.each([
    'archived-target',
    'quarantined',
    'inbox',
    'duplicate',
    'foreign-target',
    'missing-promotion',
    'missing-settlement',
    'wrong-run',
    'duplicate-settlement',
    'trust-increase',
    'sensitivity-reduction',
    'metadata-loss',
    'foreign-source',
    'archived-source',
  ])('refuses %s even with current snapshot bindings', (fault) => {
    if (fault === 'archived-target')
      memories.updateLifecycle(input.target.id, 'archived', new Date().toISOString());
    if (['quarantined', 'inbox', 'duplicate'].includes(fault))
      candidates.updateStatus(
        input.candidate.id,
        fault as 'quarantined' | 'inbox' | 'duplicate',
        TENANT,
      );
    if (fault === 'foreign-target')
      db.prepare('UPDATE curated_memories SET tenant_id = ? WHERE id = ?').run(
        'other-team',
        input.target.id,
      );
    if (fault === 'foreign-source') input.sourceTenantId = 'other-team';
    if (fault === 'archived-source')
      memories.updateLifecycle(input.source.id, 'archived', new Date().toISOString());
    if (fault === 'missing-promotion')
      db.prepare('DELETE FROM audit_events WHERE id = ?').run(input.promotionReceipt.id);
    if (fault === 'missing-settlement')
      db.prepare('DELETE FROM audit_events WHERE id = ?').run(input.settlementReceipt.id);
    if (fault === 'wrong-run') input.runId = randomUUID();
    if (fault === 'duplicate-settlement') {
      const event = audit.findByMemoryAndTenant(input.runId, TENANT)[0]!;
      db.prepare('UPDATE audit_events SET details_json = ? WHERE id = ?').run(
        JSON.stringify({
          ...event.details,
          outcomes: [
            { candidateId: input.candidate.id, memoryId: input.target.id, outcome: 'duplicate' },
          ],
        }),
        event.id,
      );
    }
    if (fault === 'trust-increase') {
      db.prepare("UPDATE curated_memories SET trust_level = 'high' WHERE id = ?").run(
        input.target.id,
      );
      db.prepare("UPDATE candidates SET trust_level = 'high' WHERE id = ?").run(input.candidate.id);
    }
    if (fault === 'sensitivity-reduction')
      db.prepare("UPDATE curated_memories SET sensitivity = 'confidential' WHERE id = ?").run(
        input.source.id,
      );
    if (fault === 'metadata-loss') {
      const metadata = JSON.stringify({ filePaths: [], tags: [] });
      db.prepare('UPDATE curated_memories SET metadata_json = ? WHERE id = ?').run(
        metadata,
        input.target.id,
      );
      db.prepare('UPDATE candidates SET metadata_json = ? WHERE id = ?').run(
        metadata,
        input.candidate.id,
      );
    }
    rebind();
    const before = snapshot();
    expect(() => archiveRecoveredSource(input, db)).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it.each(['ai', 'empty-actor', 'member', 'empty-reason', 'same-tenant', 'audience'])(
    'refuses %s authority without writes',
    (fault) => {
      if (fault === 'ai') input.actor.type = 'ai';
      if (fault === 'empty-actor') input.actor.id = ' ';
      if (fault === 'member') input.role = 'member' as 'owner';
      if (fault === 'empty-reason') input.reason = ' ';
      if (fault === 'same-tenant') input.sourceTenantId = TENANT;
      if (fault === 'audience') {
        input.role = 'admin';
        const source = memories.findById(input.source.id)!;
        memories.update({ ...source, metadata: { ...source.metadata, audience: 'owner' } });
        rebind();
      }
      const before = snapshot();
      expect(() => archiveRecoveredSource(input, db)).toThrow();
      expect(snapshot()).toEqual(before);
    },
  );

  it.each([
    'source-abort',
    'source-ignore',
    'receipt-abort',
    'receipt-ignore',
    'source-drift',
    'target-drift',
    'candidate-drift',
    'promotion-loss',
    'settlement-loss',
    'archive-receipt-drift',
  ])('rolls back %s and retries the identical plan after fault removal', (fault) => {
    let trigger: string;
    if (fault.startsWith('source-') && ['source-abort', 'source-ignore'].includes(fault)) {
      const statement =
        fault === 'source-abort' ? "RAISE(ABORT, 'injected archive fault')" : 'RAISE(IGNORE)';
      trigger = `BEFORE UPDATE ON curated_memories WHEN NEW.id = '${input.source.id}' BEGIN SELECT ${statement}; END`;
    } else {
      const statements: Record<string, string> = {
        'receipt-abort': "SELECT RAISE(ABORT, 'injected archive receipt fault');",
        'receipt-ignore': 'SELECT RAISE(IGNORE);',
        'source-drift': `UPDATE curated_memories SET title = 'altered source' WHERE id = '${input.source.id}';`,
        'target-drift': `UPDATE curated_memories SET title = 'altered target' WHERE id = '${input.target.id}';`,
        'candidate-drift': `UPDATE candidates SET title = 'altered candidate' WHERE id = '${input.candidate.id}';`,
        'promotion-loss': `DELETE FROM audit_events WHERE id = '${input.promotionReceipt.id}';`,
        'settlement-loss': `DELETE FROM audit_events WHERE id = '${input.settlementReceipt.id}';`,
        'archive-receipt-drift':
          "UPDATE audit_events SET reason = 'altered archive receipt' WHERE id = NEW.id;",
      };
      trigger = `${fault === 'receipt-ignore' ? 'BEFORE' : 'AFTER'} INSERT ON audit_events WHEN NEW.action = 'archived' BEGIN ${statements[fault]} END`;
    }
    db.exec(`CREATE TRIGGER archive_fault ${trigger}`);
    const before = snapshot();
    expect(() => archiveRecoveredSource(input, db)).toThrow();
    expect(snapshot()).toEqual(before);
    db.exec('DROP TRIGGER archive_fault');
    expect(archiveRecoveredSource(input, db).alreadyArchived).toBe(false);
  });

  it('rechecks current target evidence on repeat and refuses a changed manifest', () => {
    archiveRecoveredSource(input, db);
    const after = snapshot();
    expect(() => archiveRecoveredSource({ ...input, reason: 'a different manifest' }, db)).toThrow(
      /different manifest/,
    );
    expect(snapshot()).toEqual(after);
    memories.updateLifecycle(input.target.id, 'archived', new Date().toISOString());
    const retired = snapshot();
    expect(() => archiveRecoveredSource(input, db)).toThrow();
    expect(snapshot()).toEqual(retired);
  });

  it('rolls back archival and its receipt with an enclosing transaction', () => {
    const before = snapshot();
    expect(() =>
      db
        .transaction(() => {
          archiveRecoveredSource(input, db);
          throw new Error('outer rollback');
        })
        .immediate(),
    ).toThrow('outer rollback');
    expect(snapshot()).toEqual(before);
  });
});
