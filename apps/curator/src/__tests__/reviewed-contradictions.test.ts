import { createHash, randomUUID } from 'node:crypto';

import { deriveCandidateId, deriveAuditEventId } from '@qmd-team-intent-kb/common';
import {
  AuditRepository,
  MemoryRepository,
  MemoryLinksRepository,
  createTestDatabase,
  verifyAuditChain,
  computeEntryHash,
} from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  reviewedContradictionEndpointSnapshot,
  reviewedContradictionStoreDigest,
  reviewedContradictionsDigest,
} from '../contradictions/reviewed-contradictions-manifest.js';
import type { ReviewedContradictionsManifest } from '../contradictions/reviewed-contradictions-manifest.js';
import { settleReviewedContradictions } from '../contradictions/reviewed-contradictions.js';
import type { ReviewedContradictionsDependencies } from '../contradictions/reviewed-contradictions.js';

const AT = '2026-10-27T09:00:00.000Z';
const REVIEWED = '2026-10-27T08:00:00.000Z';
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const workspaceId = 'synthetic-workspace';
const pageBytes = Buffer.from('Synthetic reviewed contradiction pairs, not real approval.');
const lineage = {
  workspaceId,
  compilationId: 'synthetic-01',
  pagePath: 'wiki/contradictions/pairs.md',
  pageSha256: sha(pageBytes),
  sourceIds: ['a', 'b', 'c', 'd'],
  evidenceRef: 'fixture://captured-compiler-evidence',
};
let db: Database.Database;
let memories: MemoryRepository;
let audit: AuditRepository;
let ids: string[];
let emissions: { relativePath: string; bodySha256: string; candidateId: string }[];
let bytes: Map<string, Buffer>;
let deps: ReviewedContradictionsDependencies;
let tenantId: string;

beforeEach(() => {
  db = createTestDatabase();
  memories = new MemoryRepository(db);
  audit = new AuditRepository(db);
  bytes = new Map();
  emissions = [];
  ids = lineage.sourceIds.map((sourceId, index) => {
    const content = [
      'Delete logs after seven days.',
      'Retain logs at least thirty days.',
      'Use workflow setting enabled.',
      'Use workflow setting disabled.',
    ][index]!;
    const relativePath = `wiki/sources/${sourceId}.md`;
    const body = Buffer.from(content);
    bytes.set(relativePath, body);
    const candidateId = deriveCandidateId(workspaceId, relativePath, sha(body));
    emissions.push({ relativePath, bodySha256: sha(body), candidateId });
    const memory = makeMemory({ candidateId, content });
    tenantId = memory.tenantId;
    memories.insert(memory);
    audit.insert({
      id: deriveAuditEventId(memory.id, 'promoted'),
      action: 'promoted',
      memoryId: memory.id,
      tenantId,
      actor: memory.promotedBy,
      timestamp: REVIEWED,
      details: { candidateId },
    });
    return memory.id;
  });
  memories.insert(
    makeMemory({ title: 'Unselected tenant control', content: 'Keep this unrelated record.' }),
  );
  memories.insert(makeMemory({ tenantId: 'other-tenant', content: 'Other tenant control.' }));
  deps = {
    compilations: () => [{ lineage: structuredClone(lineage), pageBytes }],
    emissionBytes: (_workspace, relativePath) => bytes.get(relativePath),
    now: () => AT,
  };
});
afterEach(() => db.close());

function manifest(): ReviewedContradictionsManifest {
  return {
    version: 1,
    runId: randomUUID(),
    tenantId,
    actor: { type: 'human', id: 'synthetic-reviewer' },
    role: 'owner',
    reason: 'Private review reason sentinel',
    reviewedAt: REVIEWED,
    storeDigest: reviewedContradictionStoreDigest(db),
    selections: [0, 2].map((offset) => ({
      lineage: structuredClone(lineage),
      endpoints: [offset, offset + 1].map((index) => ({
        sourceId: lineage.sourceIds[index]!,
        emission: emissions[index]!,
        ...reviewedContradictionEndpointSnapshot(
          db,
          ids[index]!,
          deriveAuditEventId(ids[index]!, 'promoted'),
        ),
      })) as ReviewedContradictionsManifest['selections'][number]['endpoints'],
    })),
  };
}
function apply(input = manifest(), dependencies = deps) {
  return settleReviewedContradictions(input, reviewedContradictionsDigest(input), db, dependencies);
}
const state = (): string => reviewedContradictionStoreDigest(db);

describe('finite reviewed contradiction settlement', () => {
  it('writes only two explicit unordered edges with canonical receipts, preserving all other rows', () => {
    const input = manifest();
    const beforeMemories = db.prepare('SELECT * FROM curated_memories ORDER BY id').all();
    const result = apply(input);
    expect(result.replay).toBe(false);
    expect(result.linkIds).toHaveLength(2);
    expect(audit.findAllChronological()).toHaveLength(7);
    expect(verifyAuditChain(audit)).toMatchObject({ breaks: [], unverifiedRows: 0 });
    expect(db.prepare('SELECT * FROM curated_memories ORDER BY id').all()).toEqual(beforeMemories);
    const links = new MemoryLinksRepository(db).findByType('contradicts');
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.sourceMemoryId < link.targetMemoryId).toBe(true);
    const receipts = JSON.stringify(audit.findAllChronological());
    expect(receipts).not.toContain(input.reason);
    expect(receipts).not.toContain('fixture://');
    expect(receipts).not.toContain('Delete logs');
    const settled = state();
    expect(apply(input)).toEqual({ ...result, replay: true });
    expect(state()).toBe(settled);
  });

  it('normalizes optional undefined fields before receipt persistence and replay', () => {
    const input = manifest();
    const equivalent = { ...input, actor: { ...input.actor, name: undefined } };
    expect(reviewedContradictionsDigest(equivalent)).toBe(reviewedContradictionsDigest(input));
    const result = apply(equivalent);
    expect(apply(input)).toEqual({ ...result, replay: true });
  });

  it('refuses changed independent approval, unknown fields, role escalation declarations and duplicate reverse pairs', () => {
    const input = manifest();
    const before = state();
    expect(() =>
      settleReviewedContradictions(
        { ...input, reason: 'changed' },
        reviewedContradictionsDigest(input),
        db,
        deps,
      ),
    ).toThrow(/independent review digest/);
    for (const altered of [
      { ...input, extra: true },
      { ...input, role: 'member' },
      { ...input, actor: { type: 'ai', id: 'model' } },
      {
        ...input,
        selections: [
          input.selections[0],
          { ...input.selections[0], endpoints: [...input.selections[0]!.endpoints].reverse() },
        ],
      },
    ]) {
      expect(() => settleReviewedContradictions(altered, 'a'.repeat(64), db, deps)).toThrow();
    }
    expect(state()).toBe(before);
  });

  it.each(['memory', 'raw-memory', 'promotion', 'unrelated-row', 'graph'])(
    'refuses stale reviewed store evidence: %s',
    (target) => {
      const input = manifest();
      if (target === 'memory')
        db.prepare('UPDATE curated_memories SET version=version+1 WHERE id=?').run(ids[0]);
      if (target === 'raw-memory')
        db.prepare(
          "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.unknown','drift') WHERE id=?",
        ).run(ids[0]);
      if (target === 'promotion')
        db.prepare('UPDATE audit_events SET timestamp=? WHERE memory_id=?').run(AT, ids[0]);
      if (target === 'unrelated-row')
        db.prepare(
          "UPDATE curated_memories SET title='changed' WHERE title='Unselected tenant control'",
        ).run();
      if (target === 'graph')
        new MemoryLinksRepository(db).insert({
          id: randomUUID(),
          sourceMemoryId: ids[0]!,
          targetMemoryId: ids[1]!,
          linkType: 'relates_to',
          weight: 1,
          createdBy: 'fixture',
          source: 'manual',
          importBatchId: null,
          createdAt: AT,
        });
      const before = state();
      expect(() => apply(input)).toThrow();
      expect(state()).toBe(before);
    },
  );

  it.each([
    'inactive',
    'tenant',
    'audience',
    'self',
    'restatement',
    'source',
    'candidate',
    'promotion-binding',
  ])('refuses an independently reviewed but ineligible pair: %s', (target) => {
    const initial = manifest();
    if (target === 'inactive')
      db.prepare("UPDATE curated_memories SET lifecycle='deprecated' WHERE id=?").run(ids[0]);
    if (target === 'tenant')
      db.prepare("UPDATE curated_memories SET tenant_id='other-tenant' WHERE id=?").run(ids[0]);
    if (target === 'audience')
      db.prepare(
        "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.audience','owner') WHERE id=?",
      ).run(ids[0]);
    if (target === 'restatement')
      db.prepare(
        'UPDATE curated_memories SET content=(SELECT content FROM curated_memories WHERE id=?),content_hash=(SELECT content_hash FROM curated_memories WHERE id=?) WHERE id=?',
      ).run(ids[0], ids[0], ids[1]);
    const input = target === 'tenant' ? { ...initial, storeDigest: state() } : manifest();
    const endpoints = input.selections[0]!.endpoints;
    if (target === 'audience') input.role = 'admin';
    if (target === 'self') endpoints[1] = structuredClone(endpoints[0]);
    if (target === 'source') endpoints[0].sourceId = 'not-attributed';
    if (target === 'candidate')
      endpoints[0].emission = { ...endpoints[0].emission, candidateId: randomUUID() };
    if (target === 'promotion-binding') endpoints[0].promotionDigest = 'a'.repeat(64);
    const before = state();
    expect(() => apply(input)).toThrow();
    expect(state()).toBe(before);
  });

  it.each(['missing', 'ambiguous', 'lineage', 'page', 'emission'])(
    'refuses unavailable or changed captured compiler evidence: %s',
    (target) => {
      const input = manifest();
      const record = { lineage: structuredClone(lineage), pageBytes };
      if (target === 'lineage') record.lineage.evidenceRef = 'changed';
      if (target === 'page') record.pageBytes = Buffer.from('changed');
      const altered = {
        ...deps,
        compilations: () =>
          target === 'missing' ? [] : target === 'ambiguous' ? [record, record] : [record],
        emissionBytes: target === 'emission' ? () => undefined : deps.emissionBytes,
      };
      const before = state();
      expect(() => apply(input, altered)).toThrow();
      expect(state()).toBe(before);
    },
  );

  it.each(['forward', 'reverse'])(
    'refuses an existing %s contradiction edge even when the new review includes it',
    (direction) => {
      const [a, b] = ids.slice(0, 2).sort() as [string, string];
      new MemoryLinksRepository(db).insert({
        id: randomUUID(),
        sourceMemoryId: direction === 'forward' ? a : b,
        targetMemoryId: direction === 'forward' ? b : a,
        linkType: 'contradicts',
        weight: 1,
        createdBy: 'fixture',
        source: 'manual',
        importBatchId: null,
        createdAt: AT,
      });
      const input = manifest();
      const before = state();
      expect(() => apply(input)).toThrow(/duplicate contradiction/);
      expect(state()).toBe(before);
    },
  );

  it.each(['IGNORE', 'ABORT', 'rewrite'])(
    'rolls back earlier edges and receipts when the second edge insert is %s',
    (mode) => {
      const [a] = ids.slice(2, 4).sort();
      db.exec(
        mode === 'rewrite'
          ? `CREATE TRIGGER edge_mutation AFTER INSERT ON memory_links WHEN NEW.source_memory_id='${a}' BEGIN UPDATE memory_links SET weight=0.5 WHERE id=NEW.id; END`
          : `CREATE TRIGGER edge_refusal BEFORE INSERT ON memory_links WHEN NEW.source_memory_id='${a}' BEGIN SELECT RAISE(${mode}${mode === 'ABORT' ? ", 'synthetic-refusal'" : ''}); END`,
      );
      const input = manifest();
      const before = state();
      expect(() => apply(input)).toThrow();
      expect(state()).toBe(before);
    },
  );

  it.each(['IGNORE', 'ABORT', 'rewrite', 'non-target', 'earlier-link', 'earlier-promotion'])(
    'rolls back all writes on final receipt %s',
    (mode) => {
      const inputRunId = randomUUID();
      let action: string;
      if (mode === 'IGNORE' || mode === 'ABORT')
        action = `SELECT RAISE(${mode}${mode === 'ABORT' ? ", 'synthetic-refusal'" : ''});`;
      else if (mode === 'rewrite')
        action = "UPDATE audit_events SET timestamp='2020-01-01T00:00:00.000Z' WHERE id=NEW.id;";
      else if (mode === 'earlier-link') action = 'UPDATE memory_links SET weight=0.5;';
      else if (mode === 'earlier-promotion')
        action =
          "UPDATE audit_events SET timestamp='2020-01-01T00:00:00.000Z' WHERE action='promoted';";
      else
        action =
          "UPDATE curated_memories SET title='changed control' WHERE title='Unselected tenant control';";
      db.exec(
        `CREATE TRIGGER receipt_mutation ${mode === 'IGNORE' || mode === 'ABORT' ? 'BEFORE' : 'AFTER'} INSERT ON audit_events WHEN NEW.memory_id='${inputRunId}' BEGIN ${action} END`,
      );
      const input = { ...manifest(), runId: inputRunId };
      const before = state();
      expect(() => apply(input)).toThrow();
      expect(state()).toBe(before);
    },
  );

  it('rolls back late captured evidence drift and accidental callback database writes', () => {
    const input = manifest();
    const before = state();
    let count = 0;
    expect(() =>
      apply(input, {
        ...deps,
        compilations: () => {
          count++;
          return [{ lineage, pageBytes: count > 2 ? Buffer.from('late drift') : pageBytes }];
        },
      }),
    ).toThrow(/compilation lineage/);
    expect(state()).toBe(before);
    expect(() =>
      apply(input, {
        ...deps,
        emissionBytes: (_workspace, path) => {
          db.prepare(
            "UPDATE curated_memories SET title='callback changed control' WHERE title='Unselected tenant control'",
          ).run();
          return bytes.get(path);
        },
      }),
    ).toThrow(/Store changed/);
    expect(state()).toBe(before);
  });

  it('refuses preexisting transactions and future review timestamps without writes', () => {
    const input = manifest();
    const before = state();
    db.exec('BEGIN DEFERRED');
    try {
      expect(() => apply(input)).toThrow(/existing transaction/);
    } finally {
      db.exec('ROLLBACK');
    }
    expect(() => apply({ ...input, reviewedAt: '2026-10-28T00:00:00.000Z' })).toThrow(/timestamp/);
    expect(state()).toBe(before);
  });

  it.each(['manifest', 'link', 'receipt', 'run', 'unrelated'])(
    'refuses incomplete or changed replay: %s',
    (target) => {
      const input = manifest();
      const result = apply(input);
      if (target === 'manifest') input.reason = 'different approved manifest';
      if (target === 'link')
        db.prepare('DELETE FROM memory_links WHERE id=?').run(result.linkIds[0]);
      if (target === 'receipt')
        db.prepare('DELETE FROM audit_events WHERE id=?').run(result.edgeReceiptIds[0]);
      if (target === 'run')
        db.prepare('DELETE FROM audit_events WHERE id=?').run(result.runReceiptId);
      if (target === 'unrelated')
        db.prepare(
          "UPDATE curated_memories SET title='later edit' WHERE title='Unselected tenant control'",
        ).run();
      const before = state();
      expect(() => apply(input)).toThrow();
      expect(state()).toBe(before);
    },
  );

  it('refuses an unverified historical audit row without repairing it', () => {
    db.prepare(
      'INSERT INTO audit_events (id,action,memory_id,tenant_id,actor_json,details_json,timestamp) VALUES (?,?,?,?,?,?,?)',
    ).run(randomUUID(), 'exported', ids[0], tenantId, '{"type":"human","id":"fixture"}', '{}', AT);
    const input = manifest();
    const before = state();
    expect(() => apply(input)).toThrow(/strictly verified/);
    expect(state()).toBe(before);
  });

  it('preserves unknown tables, exact 64-bit integers and blobs and detects late changes to them', () => {
    db.exec('CREATE TABLE synthetic_control (id TEXT PRIMARY KEY, n INTEGER, bytes BLOB)');
    db.prepare('INSERT INTO synthetic_control VALUES (?,?,?)').run(
      'control',
      9007199254740993n,
      Buffer.from([0, 255, 1]),
    );
    const before = db.prepare('SELECT * FROM synthetic_control').safeIntegers().get();
    const input = manifest();
    const result = apply(input);
    expect(db.prepare('SELECT * FROM synthetic_control').safeIntegers().get()).toEqual(before);
    expect(apply(input)).toEqual({ ...result, replay: true });
    // A fresh store snapshot also notices a one-unit change beyond JS safe integers.
    const first = state();
    db.prepare('UPDATE synthetic_control SET n=?').run(9007199254740994n);
    expect(state()).not.toBe(first);
  });

  it('rolls back when the final receipt mutates an unknown table', () => {
    db.exec(
      "CREATE TABLE synthetic_control (value TEXT); INSERT INTO synthetic_control VALUES ('keep');",
    );
    const runId = randomUUID();
    db.exec(
      `CREATE TRIGGER mutate_unknown AFTER INSERT ON audit_events WHEN NEW.memory_id='${runId}' BEGIN UPDATE synthetic_control SET value='changed'; END`,
    );
    const input = { ...manifest(), runId };
    const before = state();
    expect(() => apply(input)).toThrow(/Non-target store changed/);
    expect(state()).toBe(before);
  });

  it('distinguishes nonfinite SQLite REAL values during non-target preservation', () => {
    db.exec('CREATE TABLE synthetic_real (value REAL)');
    db.prepare('INSERT INTO synthetic_real VALUES (?)').run(Infinity);
    const runId = randomUUID();
    db.exec(
      `CREATE TRIGGER mutate_real AFTER INSERT ON audit_events WHEN NEW.memory_id='${runId}' BEGIN UPDATE synthetic_real SET value=-value; END`,
    );
    const input = { ...manifest(), runId };
    const before = state();
    expect(() => apply(input)).toThrow(/Non-target store changed/);
    expect(state()).toBe(before);
    expect(db.prepare('SELECT value FROM synthetic_real').get()).toEqual({ value: Infinity });
  });

  it('rolls back hidden rowid changes to an otherwise unchanged non-target row', () => {
    db.exec(
      "CREATE TABLE synthetic_rowid(value TEXT); INSERT INTO synthetic_rowid VALUES ('keep')",
    );
    const runId = randomUUID();
    db.exec(
      `CREATE TRIGGER mutate_rowid AFTER INSERT ON audit_events WHEN NEW.memory_id='${runId}' BEGIN UPDATE synthetic_rowid SET rowid=999; END`,
    );
    const input = { ...manifest(), runId };
    const before = state();
    expect(() => apply(input)).toThrow(/Non-target store changed/);
    expect(state()).toBe(before);
    expect(db.prepare('SELECT rowid,value FROM synthetic_rowid').get()).toEqual({
      rowid: 1,
      value: 'keep',
    });
  });

  it('supports WITHOUT ROWID tables and refuses inaccessible shadowed hidden rowids', () => {
    db.exec(
      "CREATE TABLE synthetic_without (id TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; INSERT INTO synthetic_without VALUES ('id','keep')",
    );
    apply(manifest());
    expect(db.prepare('SELECT * FROM synthetic_without').get()).toEqual({
      id: 'id',
      value: 'keep',
    });
    db.exec('CREATE TABLE synthetic_shadowed (rowid TEXT, _rowid_ TEXT, oid TEXT)');
    expect(() => state()).toThrow(/Cannot bind hidden rowid/);
  });

  it('resolves hidden rowid aliases with SQLite case-insensitive column names', () => {
    db.exec(
      `CREATE TABLE synthetic_upper("ROWID" TEXT, value TEXT); INSERT INTO synthetic_upper VALUES ('decoy','keep')`,
    );
    const runId = randomUUID();
    db.exec(
      `CREATE TRIGGER mutate_upper AFTER INSERT ON audit_events WHEN NEW.memory_id='${runId}' BEGIN UPDATE synthetic_upper SET _rowid_=999; END`,
    );
    const input = { ...manifest(), runId };
    const before = state();
    expect(() => apply(input)).toThrow(/Non-target store changed/);
    expect(state()).toBe(before);
    expect(db.prepare('SELECT _rowid_ AS actual_rowid,value FROM synthetic_upper').get()).toEqual({
      actual_rowid: 1,
      value: 'keep',
    });
    db.exec('CREATE TABLE synthetic_all_upper("ROWID" TEXT,"_ROWID_" TEXT,"OID" TEXT)');
    expect(() => state()).toThrow(/Cannot bind hidden rowid/);
  });

  it.each(['memory_links', 'audit_events'])(
    'refuses silently unbound new columns in target table %s',
    (table) => {
      db.exec(`ALTER TABLE ${table} ADD COLUMN synthetic_future_field TEXT DEFAULT 'unbound'`);
      const input = manifest();
      const before = state();
      expect(() => apply(input)).toThrow(/raw (link|receipt)/);
      expect(state()).toBe(before);
    },
  );

  it('refuses an intact historical fork without rewriting its hashes', () => {
    const rows = audit.findAllChronological();
    const last = rows[3]!;
    const fork = { ...last, prev_entry_hash: rows[0]!.entry_hash };
    db.prepare('UPDATE audit_events SET prev_entry_hash=?,entry_hash=? WHERE id=?').run(
      fork.prev_entry_hash,
      computeEntryHash(fork, 2),
      last.id,
    );
    const input = manifest();
    const before = state();
    expect(verifyAuditChain(audit).breaks.map((item) => item.reason)).toContain('CHAIN_FORK');
    expect(() => apply(input)).toThrow(/strictly verified/);
    expect(state()).toBe(before);
  });
});
