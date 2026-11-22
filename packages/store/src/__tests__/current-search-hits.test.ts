import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import type { SearchScope } from '@qmd-team-intent-kb/schema';
import { createTestDatabase } from '../database.js';
import { MemoryRepository } from '../repositories/memory-repository.js';
import { readCurrentSearchHits } from '../current-search-hits.js';

let db: ReturnType<typeof createTestDatabase>;
let repo: MemoryRepository;
beforeEach(() => {
  db = createTestDatabase();
  repo = new MemoryRepository(db);
});
afterEach(() => db.close());
const locator = (id: string, score = 1) => ({ file: `qmd://kb-curated/${id}.md`, score });
const scope = { tenantId: 'acme', readerRole: 'member' as const, scope: 'curated' as SearchScope };

describe('current stored search authority', () => {
  it.each(['curated', 'archived', 'bulk', 'all', 'inbox'] as const)(
    'enforces current %s scope independently of the indexed collection',
    (selected) => {
      const rows = [
        makeMemory({ tenantId: 'acme', category: 'pattern' }),
        makeMemory({ tenantId: 'acme', lifecycle: 'archived' }),
        makeMemory({
          tenantId: 'acme',
          lifecycle: 'superseded',
          supersession: {
            supersededBy: '11111111-1111-4111-8111-111111111111',
            reason: 'fixture',
            linkedAt: '2026-11-22T00:00:00.000Z',
          },
        }),
        makeMemory({ tenantId: 'acme', lifecycle: 'deprecated', source: 'bulk_import' }),
        makeMemory({ tenantId: 'acme', source: 'bulk_import' }),
      ];
      rows.forEach((row) => repo.insert(row));
      const hits = readCurrentSearchHits(
        repo,
        rows.map((row) => locator(row.id)),
        { ...scope, scope: selected },
      );
      const expected =
        selected === 'all'
          ? rows
          : selected === 'curated'
            ? rows.slice(0, 1)
            : selected === 'archived'
              ? rows.slice(1, 4)
              : selected === 'bulk'
                ? rows.slice(4)
                : [];
      expect(hits.map((h) => h.memory.id)).toEqual(expected.map((row) => row.id));
    },
  );
  it.each(['member', 'admin', 'owner'] as const)(
    'enforces audience, tenant and sensitivity for %s',
    (role) => {
      const rows = [
        makeMemory({ tenantId: 'acme' }),
        makeMemory({ tenantId: 'acme', metadata: { filePaths: [], tags: [], audience: 'admins' } }),
        makeMemory({ tenantId: 'acme', metadata: { filePaths: [], tags: [], audience: 'owner' } }),
        makeMemory({ tenantId: 'other' }),
        makeMemory({ tenantId: 'acme', sensitivity: 'confidential' }),
        makeMemory({ tenantId: 'acme', sensitivity: 'restricted' }),
      ];
      rows.forEach((row) => repo.insert(row));
      const hits = readCurrentSearchHits(
        repo,
        rows.map((row) => locator(row.id)),
        { ...scope, readerRole: role },
      );
      expect(hits.map((h) => h.memory.id)).toEqual(
        rows.slice(0, role === 'owner' ? 3 : role === 'admin' ? 2 : 1).map((r) => r.id),
      );
    },
  );
  it('does not serve any partial response after a malformed stored row', () => {
    const first = makeMemory({ tenantId: 'acme' }),
      corrupt = makeMemory({ tenantId: 'acme' });
    repo.insert(first);
    repo.insert(corrupt);
    db.prepare('UPDATE curated_memories SET metadata_json=? WHERE id=?').run(
      'invalid-private-fixture',
      corrupt.id,
    );
    expect(readCurrentSearchHits(repo, [locator(first.id), locator(corrupt.id)], scope)).toEqual(
      [],
    );
  });
  it('rejects forged paths, non-finite scores and unknown rows; deduplicates valid locators', () => {
    const row = makeMemory({ tenantId: 'acme' });
    repo.insert(row);
    const hits = [
      { file: `file:///private/${row.id}.md`, score: 1 },
      { file: `qmd://kb-curated/private-sentinel/${row.id}.md`, score: 1 },
      { file: `qmd://private-sentinel/${row.id}.md`, score: 1 },
      locator(row.id, NaN),
      locator(row.id, Infinity),
      locator('legacy-private-title'),
      locator('11111111-1111-4111-8111-111111111111'),
      locator(row.id),
      locator(row.id),
    ];
    const result = readCurrentSearchHits(repo, hits, scope);
    expect(result).toHaveLength(1);
    expect(result[0]!.memory.id).toBe(row.id);
    expect(JSON.stringify(result)).not.toContain('private-sentinel');
  });
  it('observes redaction and narrowing on the next read without index updates or durable writes', () => {
    const row = makeMemory({
      tenantId: 'acme',
      content: 'old private sentinel',
      title: 'old title',
    });
    repo.insert(row);
    const cached = [locator(row.id)];
    expect(readCurrentSearchHits(repo, cached, scope)[0]!.snippet).toBe(row.content);
    repo.update({ ...row, title: 'new title', content: '[REDACTED]' });
    const before = db.prepare('SELECT total_changes() AS n').get();
    const result = readCurrentSearchHits(repo, cached, scope);
    expect(result[0]!.snippet).toBe('[REDACTED]');
    expect(result[0]!.memory.title).toBe('new title');
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    db.prepare(
      "UPDATE curated_memories SET metadata_json=json_set(metadata_json,'$.audience','owner') WHERE id=?",
    ).run(row.id);
    expect(readCurrentSearchHits(repo, cached, scope)).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });
  it.each([
    ['decision', 'kb-decisions'],
    ['pattern', 'kb-curated'],
    ['convention', 'kb-curated'],
    ['architecture', 'kb-curated'],
    ['reference', 'kb-guides'],
    ['troubleshooting', 'kb-guides'],
    ['onboarding', 'kb-guides'],
  ] as const)('projects the current %s collection and bounded content', (category, collection) => {
    const row = makeMemory({ tenantId: 'acme', category, content: 'x'.repeat(300) });
    repo.insert(row);
    const [hit] = readCurrentSearchHits(repo, [locator(row.id)], scope);
    expect(hit!.file).toBe(`qmd://${collection}/${row.id}.md`);
    expect(hit!.collection).toBe(collection);
    expect(hit!.snippet).toHaveLength(200);
  });
});
