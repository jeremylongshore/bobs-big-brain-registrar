import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, MemoryRepository } from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { SearchQuery } from '@qmd-team-intent-kb/schema';
import { SearchService } from '../services/search-service.js';

let db: ReturnType<typeof createTestDatabase>;
let repo: MemoryRepository;
beforeEach(() => {
  db = createTestDatabase();
  repo = new MemoryRepository(db);
});
afterEach(() => {
  db.close();
});
const query = SearchQuery.parse({ query: 'needle', tenantId: 'acme' });
const hit = (id: string) => ({
  file: `qmd://kb-curated/${id}.md`,
  snippet: 'stale-private-sentinel',
  collection: 'kb-curated',
  score: 1,
});
const service = (hits: ReturnType<typeof hit>[]) =>
  new SearchService(repo, { query: async () => ({ ok: true, value: hits }) });

describe('API current store authority', () => {
  it('withholds unresolved and malformed citations without returning their text or identifiers', async () => {
    const result = await service([
      hit('legacy-private-title'),
      hit('11111111-1111-4111-8111-111111111111'),
    ]).search(query);
    expect(result.hits).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('serves current redacted text and title without trusting cached content', async () => {
    const row = makeMemory({
      tenantId: 'acme',
      title: 'Current title',
      content: 'needle [REDACTED]',
    });
    repo.insert(row);
    const result = await service([hit(row.id)]).search(query);
    expect(result.hits[0]!.title).toBe(row.title);
    expect(result.hits[0]!.snippet).toBe(row.content);
    expect(JSON.stringify(result)).not.toContain('stale-private-sentinel');
  });
  it('fails closed without echoing row validation errors', async () => {
    const row = makeMemory({ tenantId: 'acme' });
    repo.insert(row);
    db.prepare('UPDATE curated_memories SET metadata_json=? WHERE id=?').run(
      'private-malformed-json',
      row.id,
    );
    const result = await service([hit(row.id)]).search(query);
    expect(result.hits).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each(['archived', 'bulk'] as const)(
    'checks current %s scope independently of stale collection',
    async (kind) => {
      const row = makeMemory({
        tenantId: 'acme',
        ...(kind === 'archived'
          ? { lifecycle: 'archived' as const }
          : { source: 'bulk_import' as const }),
      });
      repo.insert(row);
      const search = service([hit(row.id)]);
      expect((await search.search(query)).hits).toEqual([]);
      const selected = await search.search({ ...query, scope: kind });
      expect(selected.hits).toHaveLength(1);
      expect(selected.hits[0]!.snippet).toBe(row.content.slice(0, 200));
      expect(selected.hits[0]!.collection).toBe(kind === 'archived' ? 'kb-archive' : 'kb-bulk');
    },
  );
});
