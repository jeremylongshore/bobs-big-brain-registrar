import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, MemoryRepository } from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { SearchQuery } from '@qmd-team-intent-kb/schema';
import { SearchService } from '../services/search-service.js';

let db: ReturnType<typeof createTestDatabase>;
beforeEach(() => {
  db = createTestDatabase();
});
afterEach(() => {
  db.close();
});

describe('resolved qmd hit standing', () => {
  it.each(['member', 'admin', 'owner'] as const)(
    'checks tenant and audience for %s before returning snippets',
    async (role) => {
      const repo = new MemoryRepository(db);
      const rows = [
        makeMemory({
          tenantId: 'acme',
          title: 'tenant',
          metadata: { filePaths: [], tags: [], audience: 'tenant' },
        }),
        makeMemory({
          tenantId: 'acme',
          title: 'admins',
          metadata: { filePaths: [], tags: [], audience: 'admins' },
        }),
        makeMemory({
          tenantId: 'acme',
          title: 'owner',
          metadata: { filePaths: [], tags: [], audience: 'owner' },
        }),
        makeMemory({ tenantId: 'elsewhere', title: 'foreign' }),
        makeMemory({ tenantId: 'acme', title: 'confidential', sensitivity: 'confidential' }),
        makeMemory({ tenantId: 'acme', title: 'restricted', sensitivity: 'restricted' }),
      ];
      rows.forEach((row) => repo.insert(row));
      const service = new SearchService(repo, {
        query: async () => ({
          ok: true,
          value: rows.map((row) => ({
            file: `qmd://kb-curated/${row.id}.md`,
            snippet: `sentinel-${row.title}`,
            score: 1,
            collection: 'kb-curated',
          })),
        }),
      });
      const result = await service.search(
        SearchQuery.parse({
          query: 'needle',
          tenantId: 'acme',
          pagination: { page: 1, pageSize: 1 },
        }),
        role,
      );
      const allowed = role === 'owner' ? 3 : role === 'admin' ? 2 : 1;
      expect(result.totalCount).toBe(allowed);
      expect(result.hasMore).toBe(allowed > 1);
      const all = await service.search(
        SearchQuery.parse({ query: 'needle', tenantId: 'acme' }),
        role,
      );
      expect(all.hits.map((hit) => hit.memoryId).sort()).toEqual(
        rows
          .slice(0, allowed)
          .map((row) => row.id)
          .sort(),
      );
      for (const row of rows.slice(allowed)) {
        expect(JSON.stringify(all)).not.toContain(`sentinel-${row.title}`);
        expect(JSON.stringify(all)).not.toContain(row.id);
      }
    },
  );
});
