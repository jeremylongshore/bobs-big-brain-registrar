import { randomUUID, createHash } from 'node:crypto';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import {
  AuditRepository,
  MemoryRepository,
  createTestDatabase,
  verifyAuditChain,
  computeEntryHash,
} from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditEventSnapshotDigest } from '../recovery/source-archive.js';
import {
  settleReviewedStaleness,
  type ReviewedStalenessDependencies,
} from '../staleness/reviewed-staleness.js';
import {
  reviewedStalenessDigest,
  reviewedStalenessSnapshot,
  stalenessDigest,
  type ReviewedStalenessManifest,
} from '../staleness/reviewed-staleness-manifest.js';
import { ESTATE_STALENESS_RULES, type StalenessRule } from '../staleness/staleness-rules.js';

const AT = '2026-10-27T05:00:00.000Z';
const REVIEWED = '2026-10-27T04:00:00.000Z';
// Synthetic bytes and source descriptors; not a real private decision/approval.
const SOURCE = Buffer.from('Synthetic historical estate removal fixture.');
let db: Database.Database;
let memories: MemoryRepository;
let audit: AuditRepository;
let ids: string[];
let rule: StalenessRule;
let deps: ReviewedStalenessDependencies;

beforeEach(() => {
  db = createTestDatabase();
  memories = new MemoryRepository(db);
  audit = new AuditRepository(db);
  rule = {
    ...structuredClone(ESTATE_STALENESS_RULES[0]!),
    id: 'fixture-gcp',
    authority: {
      ...ESTATE_STALENESS_RULES[0]!.authority!,
      sources: [
        {
          repository: 'fixture/estate',
          path: 'decision.md',
          revision: 'a'.repeat(40),
          sha256: createHash('sha256').update(SOURCE).digest('hex'),
          visibility: 'private',
          locator: 'synthetic decision fixture',
        },
      ],
    },
  };
  ids = [1, 2].map((index) => {
    const memory = makeMemory({ content: `Use BigQuery for warehouse ${index}.` });
    memories.insert(memory);
    return memory.id;
  });
  memories.insert(makeMemory({ content: 'Keep PostgreSQL.', title: 'Unselected control' }));
  memories.insert(makeMemory({ content: 'Use BigQuery elsewhere.', tenantId: 'other-tenant' }));
  deps = { rules: [rule], sourceBytes: () => SOURCE, now: () => AT };
});
afterEach(() => db.close());

function manifest(selected = ids): ReviewedStalenessManifest {
  return {
    version: 1,
    runId: randomUUID(),
    tenantId: memories.findById(ids[0]!)!.tenantId,
    operation: 'deprecate',
    actor: { type: 'human', id: 'fixture-reviewer' },
    role: 'owner',
    reason: 'Reviewed synthetic estate procedure',
    reviewedAt: REVIEWED,
    selections: selected.map((id) => ({
      ...reviewedStalenessSnapshot(db, id),
      ruleId: rule.id,
      ruleDigest: stalenessDigest(rule),
      scope: 'intent-solutions-estate',
      scopeEvidenceRef: 'fixture://reviewed-scope',
    })),
  };
}
function apply(input = manifest(), dependencies = deps) {
  return settleReviewedStaleness(input, reviewedStalenessDigest(input), db, dependencies);
}
function state() {
  return {
    memories: db.prepare('SELECT * FROM curated_memories ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM audit_events ORDER BY seq').all(),
  };
}
function restore(input: ReviewedStalenessManifest, receiptId: string): ReviewedStalenessManifest {
  const id = input.selections[0]!.memoryId;
  const event = audit
    .findByMemoryAndTenant(id, input.tenantId)
    .find((item) => item.id === receiptId)!;
  return {
    ...input,
    runId: randomUUID(),
    operation: 'reactivate',
    selections: [
      {
        ...input.selections[0]!,
        ...reviewedStalenessSnapshot(db, id),
        scope: 'external',
        deprecationReceipt: { id: receiptId, snapshotDigest: auditEventSnapshotDigest(event) },
      },
    ],
  };
}

describe('reviewed finite staleness settlement', () => {
  it('refuses an existing transaction rather than settling in a savepoint', () => {
    const input = manifest();
    const before = state();
    db.exec('BEGIN DEFERRED');
    try {
      expect(() => apply(input)).toThrow(/existing transaction/);
      expect(state()).toEqual(before);
    } finally {
      db.exec('ROLLBACK');
    }
  });

  it('changes only the selected tenant rows with per-memory and run receipts, without copying review/source text', () => {
    const before = state();
    const input = manifest();
    input.reason = 'private reason sentinel';
    input.selections[0]!.scopeEvidenceRef = 'private scope sentinel';
    const result = apply(input);
    expect(result.replay).toBe(false);
    expect(result.transitionReceiptIds).toHaveLength(2);
    expect(ids.map((id) => memories.findById(id)!.lifecycle)).toEqual(['deprecated', 'deprecated']);
    expect(state().memories.filter((row) => !ids.includes((row as { id: string }).id))).toEqual(
      before.memories.filter((row) => !ids.includes((row as { id: string }).id)),
    );
    expect(audit.findAllChronological()).toHaveLength(3);
    expect(verifyAuditChain(audit)).toMatchObject({ unverifiedRows: 0, breaks: [] });
    const serialized = JSON.stringify(state().audit);
    expect(serialized).not.toContain('private reason sentinel');
    expect(serialized).not.toContain('private scope sentinel');
    expect(serialized).not.toContain(SOURCE.toString());
  });

  it('normalizes optional undefined fields to the reviewed JSON artifact for persistence and replay', () => {
    const input = manifest();
    const equivalent = { ...input, actor: { ...input.actor, name: undefined } };
    expect(reviewedStalenessDigest(equivalent)).toBe(reviewedStalenessDigest(input));
    const result = apply(equivalent);
    expect(apply(input)).toEqual({ ...result, replay: true });
  });

  it('replays the exact run without writes and refuses a new manifest under its run identity', () => {
    const input = manifest();
    const result = apply(input);
    const before = state();
    expect(apply(input)).toEqual({ ...result, replay: true });
    expect(state()).toEqual(before);
    expect(() => apply({ ...input, reason: 'Different approved plan' })).toThrow(
      /different reviewed manifest/,
    );
    expect(state()).toEqual(before);
  });

  it('binds an independent expected digest and rejects unknown manifest fields or duplicate selections', () => {
    const input = manifest();
    const before = state();
    expect(() =>
      settleReviewedStaleness(
        { ...input, reason: 'modified' },
        reviewedStalenessDigest(input),
        db,
        deps,
      ),
    ).toThrow(/independent review digest/);
    expect(() =>
      settleReviewedStaleness({ ...input, extra: true }, 'a'.repeat(64), db, deps),
    ).toThrow();
    expect(() =>
      settleReviewedStaleness(
        { ...input, selections: [input.selections[0], input.selections[0]] },
        'a'.repeat(64),
        db,
        deps,
      ),
    ).toThrow();
    expect(state()).toEqual(before);
  });

  it.each([
    "UPDATE curated_memories SET content='Edited content' WHERE id=?",
    "UPDATE curated_memories SET title='Edited title' WHERE id=?",
    'UPDATE curated_memories SET version=version+1 WHERE id=?',
    "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.branch','changed') WHERE id=?",
    "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.unrecognizedField','changed') WHERE id=?",
    "UPDATE curated_memories SET lifecycle='deprecated' WHERE id=?",
  ])('refuses reviewed snapshot drift without writing: %s', (sql) => {
    const input = manifest();
    db.prepare(sql).run(ids[0]);
    const before = state();
    expect(() => apply(input)).toThrow(/reviewed snapshot/);
    expect(state()).toEqual(before);
  });

  it('does not lose unknown stored metadata during a valid lifecycle change', () => {
    db.prepare(
      "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.unrecognizedField','retained') WHERE id=?",
    ).run(ids[0]);
    apply(manifest());
    expect(
      db.prepare('SELECT metadata_json FROM curated_memories WHERE id=?').get(ids[0]),
    ).toMatchObject({ metadata_json: expect.stringContaining('retained') });
  });

  it('refuses another tenant or an owner-only row presented to a declared admin', () => {
    const other = db
      .prepare("SELECT id FROM curated_memories WHERE tenant_id='other-tenant'")
      .get() as { id: string };
    const input = manifest([other.id]);
    const before = state();
    expect(() => apply(input)).toThrow(/within reviewed authority/);
    db.prepare(
      "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.audience','owner') WHERE id=?",
    ).run(ids[0]);
    const hidden = { ...manifest([ids[0]!]), role: 'admin' as const };
    const after = state();
    expect(() => apply(hidden)).toThrow(/within reviewed authority/);
    expect(state()).toEqual(after);
    expect(before.audit).toEqual(after.audit);
  });

  it.each([undefined, Buffer.from('different source bytes')])(
    'refuses unavailable or mismatched private evidence bytes',
    (bytes) => {
      const input = manifest();
      const before = state();
      expect(() => apply(input, { ...deps, sourceBytes: () => bytes })).toThrow(/source bytes/);
      expect(state()).toEqual(before);
    },
  );

  it.each([
    'Use Redis instead of BigQuery.',
    'We built a BigQuery schema.',
    'BigQuery was retired.',
    '"Use BigQuery."',
  ])('refuses a reviewed noncandidate: %s', (content) => {
    db.prepare('UPDATE curated_memories SET content=?,content_hash=? WHERE id=?').run(
      content,
      computeContentHash(content),
      ids[0],
    );
    const input = manifest();
    const before = state();
    expect(() => apply(input)).toThrow(/not a staleness retirement candidate/);
    expect(state()).toEqual(before);
  });

  it('refuses external scope, metadata-remedy rules, changed definitions and missing authority', () => {
    const input = manifest();
    const before = state();
    input.selections[0]!.scope = 'external';
    expect(() => apply(input)).toThrow(/not a staleness retirement candidate/);
    for (const altered of [
      { ...rule, remedy: 'metadata-review' as const },
      { ...rule, authority: null },
      { ...rule, exemptIfHistorical: false },
    ]) {
      rule = altered;
      deps = { ...deps, rules: [rule] };
      expect(() => apply(manifest())).toThrow(/ineligible staleness rule/);
    }
    expect(state()).toEqual(before);
  });

  it('refuses future review timestamps and nonhuman/member declarations without writes', () => {
    const input = manifest();
    const before = state();
    expect(() => apply(input, { ...deps, now: () => '2026-10-26T00:00:00.000Z' })).toThrow(
      /timestamp/,
    );
    expect(() =>
      settleReviewedStaleness(
        { ...input, actor: { type: 'ai', id: 'model' } },
        'a'.repeat(64),
        db,
        deps,
      ),
    ).toThrow();
    expect(() =>
      settleReviewedStaleness({ ...input, role: 'member' }, 'a'.repeat(64), db, deps),
    ).toThrow();
    expect(state()).toEqual(before);
  });

  it.each(['IGNORE', 'ABORT'])(
    'rolls back the whole run if the second transition receipt is %s',
    (mode) => {
      const input = manifest();
      const before = state();
      db.exec(
        `CREATE TRIGGER refuse_receipt BEFORE INSERT ON audit_events WHEN NEW.memory_id='${ids[1]}' AND NEW.action='demoted' BEGIN SELECT RAISE(${mode}${mode === 'ABORT' ? ", 'fixture-audit-refusal'" : ''}); END`,
      );
      expect(() => apply(input)).toThrow();
      expect(state()).toEqual(before);
    },
  );

  it('rolls back if a lifecycle UPDATE is silently ignored', () => {
    const input = manifest();
    const before = state();
    db.exec(
      `CREATE TRIGGER ignore_lifecycle BEFORE UPDATE ON curated_memories WHEN NEW.id='${ids[1]}' BEGIN SELECT RAISE(IGNORE); END`,
    );
    expect(() => apply(input)).toThrow(/not persisted/);
    expect(state()).toEqual(before);
  });

  it('rolls back if the run receipt is ignored after all transition writes', () => {
    const input = manifest();
    const before = state();
    db.exec(
      "CREATE TRIGGER ignore_run BEFORE INSERT ON audit_events WHEN NEW.action='governed' BEGIN SELECT RAISE(IGNORE); END",
    );
    expect(() => apply(input)).toThrow(/receipt is missing/);
    expect(state()).toEqual(before);
  });

  it.each(['memory', 'receipt'])(
    'rolls back when the last receipt alters an earlier %s witness',
    (target) => {
      const input = manifest();
      const before = state();
      const mutation =
        target === 'memory'
          ? `UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.unrecognizedField','late-change') WHERE id='${ids[0]}';`
          : `UPDATE audit_events SET reason='late-change' WHERE memory_id='${ids[0]}' AND action='demoted';`;
      db.exec(
        `CREATE TRIGGER alter_earlier AFTER INSERT ON audit_events WHEN NEW.action='governed' BEGIN ${mutation} END`,
      );
      expect(() => apply(input)).toThrow(/changed during settlement/);
      expect(state()).toEqual(before);
    },
  );

  it.each([
    'raw-metadata',
    'reactivated',
    'missing-transition',
    'missing-run',
    'receipt-timestamp',
  ])('refuses a corrupted replay: %s', (change) => {
    const input = manifest();
    const result = apply(input);
    if (change === 'raw-metadata')
      db.prepare(
        "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.unknown','edited') WHERE id=?",
      ).run(ids[0]);
    if (change === 'reactivated')
      db.prepare("UPDATE curated_memories SET lifecycle='active' WHERE id=?").run(ids[0]);
    if (change === 'missing-transition')
      db.prepare('DELETE FROM audit_events WHERE id=?').run(result.transitionReceiptIds[0]);
    if (change === 'missing-run')
      db.prepare('DELETE FROM audit_events WHERE id=?').run(result.runReceiptId);
    if (change === 'receipt-timestamp')
      db.prepare("UPDATE audit_events SET timestamp='2026-01-01T00:00:00.000Z' WHERE id=?").run(
        result.transitionReceiptIds[0],
      );
    const before = state();
    expect(() => apply(input)).toThrow();
    expect(state()).toEqual(before);
  });

  it('performs a separately reviewed reversal of the current row, preserving edits and receipting the reversal', () => {
    const input = manifest();
    const result = apply(input);
    const edited = 'Current corrected PostgreSQL procedure.';
    db.prepare(
      "UPDATE curated_memories SET content=?,content_hash=?,metadata_json=json_set(metadata_json,'$.unknown','keep-current') WHERE id=?",
    ).run(edited, computeContentHash(edited), ids[0]);
    const reversal = restore(input, result.transitionReceiptIds[0]!);
    const restored = apply(reversal);
    expect(memories.findById(ids[0]!)!).toMatchObject({ lifecycle: 'active', content: edited });
    expect(memories.findById(ids[1]!)!.lifecycle).toBe('deprecated');
    expect(audit.findAllChronological()).toHaveLength(5);
    expect(apply(reversal)).toEqual({ ...restored, replay: true });
    expect(() => apply(input)).toThrow();
  });

  it('refuses stale reversal snapshots and changed deprecation witnesses', () => {
    const input = manifest();
    const result = apply(input);
    const reversal = restore(input, result.transitionReceiptIds[0]!);
    db.prepare('UPDATE curated_memories SET version=version+1 WHERE id=?').run(ids[0]);
    const before = state();
    expect(() => apply(reversal)).toThrow(/reviewed snapshot/);
    expect(state()).toEqual(before);
    const fresh = restore(input, result.transitionReceiptIds[0]!);
    fresh.selections[0]!.deprecationReceipt!.snapshotDigest = 'a'.repeat(64);
    expect(() => apply(fresh)).toThrow(/deprecation evidence/);
    expect(state()).toEqual(before);
  });

  it('refuses a missing deprecation run receipt rather than fabricating reversal evidence', () => {
    const input = manifest();
    const result = apply(input);
    const reversal = restore(input, result.transitionReceiptIds[0]!);
    db.prepare('DELETE FROM audit_events WHERE id=?').run(result.runReceiptId);
    const before = state();
    expect(() => apply(reversal)).toThrow(/run settlement/);
    expect(state()).toEqual(before);
  });

  it('refuses a tampered pre-existing audit chain without modifying or rehashing it', () => {
    const input = manifest();
    audit.insert({
      id: randomUUID(),
      memoryId: ids[0]!,
      tenantId: input.tenantId,
      action: 'exported',
      actor: input.actor,
      timestamp: AT,
      details: {},
    });
    db.exec("UPDATE audit_events SET reason='tampered'");
    const before = state();
    expect(() => apply(input)).toThrow(/strictly verified/);
    expect(state()).toEqual(before);
  });
  it('refuses a changed eligible rule definition under the old reviewed rule digest', () => {
    const input = manifest();
    const before = state();
    expect(() =>
      apply(input, { ...deps, rules: [{ ...rule, because: 'Changed historical declaration' }] }),
    ).toThrow(/changed or ineligible/);
    expect(state()).toEqual(before);
  });

  it('refuses unverified historical audit rows without exception amnesty', () => {
    const input = manifest();
    db.prepare(
      'INSERT INTO audit_events (id,action,memory_id,tenant_id,actor_json,details_json,timestamp) VALUES (?,?,?,?,?,?,?)',
    ).run(randomUUID(), 'exported', ids[0], input.tenantId, JSON.stringify(input.actor), '{}', AT);
    const before = state();
    expect(verifyAuditChain(audit).unverifiedRows).toBe(1);
    expect(() => apply(input)).toThrow(/strictly verified/);
    expect(state()).toEqual(before);
  });

  it('refuses an intact historical fork without treating it as tampering or rewriting it', () => {
    const input = manifest();
    for (let i = 0; i < 3; i++)
      audit.insert({
        id: randomUUID(),
        memoryId: ids[0]!,
        tenantId: input.tenantId,
        action: 'exported',
        actor: input.actor,
        timestamp: AT,
        details: { fixture: i },
      });
    const rows = audit.findAllChronological();
    const last = rows[2]!;
    const fork = { ...last, prev_entry_hash: rows[0]!.entry_hash };
    db.prepare('UPDATE audit_events SET prev_entry_hash=?,entry_hash=? WHERE id=?').run(
      fork.prev_entry_hash,
      computeEntryHash(fork, 2),
      last.id,
    );
    expect(verifyAuditChain(audit).breaks.map((item) => item.reason)).toContain('CHAIN_FORK');
    const before = state();
    expect(() => apply(input)).toThrow(/strictly verified/);
    expect(state()).toEqual(before);
  });
});
