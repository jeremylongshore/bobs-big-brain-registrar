import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import { createTestDatabase } from '../database.js';
import { MemoryRepository } from '../repositories/memory-repository.js';
import { MemoryLinksRepository } from '../repositories/memory-links-repository.js';
import type { GraphReadScope } from '../repositories/memory-links-repository.js';
import { readContradictionReferences } from '../contradiction-references.js';

let db: Database.Database;
let repo: MemoryRepository;
let links: MemoryLinksRepository;
let primary: CuratedMemory;
let target: CuratedMemory;
const scope: GraphReadScope = { tenantId: 'test-tenant', readerRole: 'member' };
beforeEach(() => {
  db = createTestDatabase();
  repo = new MemoryRepository(db);
  links = new MemoryLinksRepository(db);
  primary = makeMemory({ title: 'Keep logs seven days.', tenantId: scope.tenantId });
  target = makeMemory({ title: 'Keep logs thirty days.', tenantId: scope.tenantId });
  repo.insert(primary);
  repo.insert(target);
});
afterEach(() => db.close());
function edge(
  source = primary.id,
  destination = target.id,
  type: 'contradicts' | 'relates_to' = 'contradicts',
) {
  links.insert({
    id: randomUUID(),
    sourceMemoryId: source,
    targetMemoryId: destination,
    linkType: type,
    weight: 1,
    createdBy: 'synthetic-reviewer',
    source: 'curator',
    importBatchId: null,
    createdAt: '2026-10-27T10:00:00.000Z',
  });
}
function read(readScope = scope) {
  return readContradictionReferences(db, primary.id, readScope);
}

describe('current visible contradiction references', () => {
  it.each(['outgoing', 'incoming'])(
    'reads the %s edge without changing any durable state',
    (direction) => {
      edge(
        direction === 'outgoing' ? primary.id : target.id,
        direction === 'outgoing' ? target.id : primary.id,
      );
      const before = db.prepare('SELECT total_changes() AS count').get();
      expect(read()).toEqual({
        status: 'available',
        references: [{ memoryId: target.id, title: target.title }],
      });
      expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
      expect(db.prepare('SELECT count(*) AS count FROM audit_events').get()).toEqual({ count: 0 });
    },
  );

  it('deduplicates reverse edges, ignores self/other relationship types and sorts references', () => {
    edge();
    edge(target.id, primary.id);
    edge(primary.id, primary.id);
    const other = makeMemory({ tenantId: scope.tenantId, title: 'Another conflict' });
    repo.insert(other);
    edge(primary.id, other.id);
    const related = makeMemory({ tenantId: scope.tenantId });
    repo.insert(related);
    edge(primary.id, related.id, 'relates_to');
    expect(read()).toEqual({
      status: 'available',
      references: [target, other]
        .map((memory) => ({ memoryId: memory.id, title: memory.title }))
        .sort((a, b) => (a.memoryId < b.memoryId ? -1 : 1)),
    });
  });

  it.each(['tenant', 'audience', 'confidential', 'restricted', 'deprecated', 'archived'])(
    'does not expose a counterpart hidden by %s, including to an unscoped administrator',
    (boundary) => {
      edge();
      if (boundary === 'tenant')
        db.prepare("UPDATE curated_memories SET tenant_id='other-tenant' WHERE id=?").run(
          target.id,
        );
      if (boundary === 'audience')
        db.prepare(
          "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.audience','owner') WHERE id=?",
        ).run(target.id);
      if (boundary === 'confidential' || boundary === 'restricted')
        db.prepare('UPDATE curated_memories SET sensitivity=? WHERE id=?').run(boundary, target.id);
      if (boundary === 'deprecated' || boundary === 'archived')
        db.prepare('UPDATE curated_memories SET lifecycle=? WHERE id=?').run(boundary, target.id);
      expect(read()).toEqual({ status: 'available', references: [] });
      if (boundary !== 'audience')
        expect(read({ readerRole: 'owner' })).toEqual({ status: 'available', references: [] });
      expect(JSON.stringify(read())).not.toContain(target.id);
      expect(JSON.stringify(read())).not.toContain(target.title);
    },
  );

  it.each(['tenant', 'audience', 'sensitivity', 'inactive'])(
    'does not claim graph evidence for an unavailable primary: %s',
    (boundary) => {
      edge();
      if (boundary === 'tenant')
        db.prepare("UPDATE curated_memories SET tenant_id='other-tenant' WHERE id=?").run(
          primary.id,
        );
      if (boundary === 'audience')
        db.prepare(
          "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.audience','owner') WHERE id=?",
        ).run(primary.id);
      if (boundary === 'sensitivity')
        db.prepare("UPDATE curated_memories SET sensitivity='confidential' WHERE id=?").run(
          primary.id,
        );
      if (boundary === 'inactive')
        db.prepare("UPDATE curated_memories SET lifecycle='deprecated' WHERE id=?").run(primary.id);
      expect(read()).toEqual({ status: 'unavailable' });
    },
  );

  it('uses current audience standing and tenant allowlists at both ends', () => {
    edge();
    db.prepare(
      "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.audience','admins') WHERE id=?",
    ).run(target.id);
    expect(read()).toEqual({ status: 'available', references: [] });
    expect(read({ ...scope, readerRole: 'admin' })).toMatchObject({
      references: [{ memoryId: target.id }],
    });
    expect(read({ ...scope, readerRole: 'owner' })).toMatchObject({
      references: [{ memoryId: target.id }],
    });
    expect(read({ ...scope, readerRole: 'owner', allowedTenantIds: [] })).toEqual({
      status: 'unavailable',
    });
    expect(read({ readerRole: 'owner', allowedTenantIds: ['other-tenant'] })).toEqual({
      status: 'unavailable',
    });
    expect(read({ readerRole: 'owner', allowedTenantIds: [primary.tenantId] })).toMatchObject({
      references: [{ memoryId: target.id }],
    });
  });

  it('omits dangling counterparts without revealing their identifiers', () => {
    db.pragma('foreign_keys=OFF');
    edge(primary.id, randomUUID());
    expect(read()).toEqual({ status: 'available', references: [] });
  });

  it('distinguishes empty visible graph from missing graph, malformed rows, missing primary and invalid identifiers', () => {
    expect(read()).toEqual({ status: 'available', references: [] });
    expect(readContradictionReferences(db, randomUUID(), scope)).toEqual({ status: 'unavailable' });
    expect(readContradictionReferences(db, 'not-a-memory', scope)).toEqual({
      status: 'unavailable',
    });
    db.exec('DROP TABLE memory_links');
    expect(read()).toEqual({ status: 'unavailable' });
  });

  it('does not disclose partial references if canonical row parsing fails', () => {
    edge();
    db.prepare("UPDATE curated_memories SET metadata_json='not-json' WHERE id=?").run(target.id);
    expect(read()).toEqual({ status: 'unavailable' });
  });
});
