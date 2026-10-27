import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, MemoryRepository, MemoryLinksRepository } from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { searchTool } from '../tools/search.js';
import type { McpServerConfig } from '../config.js';

let root: string;
let db: ReturnType<typeof createDatabase>;
let config: McpServerConfig;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contradiction-search-'));
  config = {
    tenantId: 'acme',
    basePath: root,
    dbPath: join(root, 'teamkb.db'),
    spoolPath: join(root, 'spool'),
    feedbackPath: join(root, 'feedback'),
  };
  db = createDatabase({ path: config.dbPath });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('MCP contradiction metadata transport', () => {
  it('local mode reads scoped references without changing citations/scores or durable state', async () => {
    const primary = makeMemory({ tenantId: 'acme' });
    const target = makeMemory({ tenantId: 'acme', title: 'visible conflict' });
    const hidden = makeMemory({
      tenantId: 'acme',
      title: 'owner-only sentinel',
      metadata: { filePaths: [], tags: [], audience: 'owner' },
    });
    const repo = new MemoryRepository(db);
    [primary, target, hidden].forEach((memory) => repo.insert(memory));
    const links = new MemoryLinksRepository(db);
    for (const memory of [target, hidden])
      links.insert({
        id: randomUUID(),
        sourceMemoryId: memory.id,
        targetMemoryId: primary.id,
        linkType: 'contradicts',
        weight: 1,
        createdBy: 'fixture',
        source: 'curator',
        importBatchId: null,
        createdAt: primary.updatedAt,
      });
    const raw = {
      file: `qmd://kb-curated/${primary.id}.md`,
      snippet: 'unchanged',
      score: 0.7,
      collection: 'kb-curated',
    };
    const before = db.prepare('SELECT total_changes() AS n').get();
    const result = await searchTool({ query: 'needle' }, config, {
      makeAdapter: () => ({ query: async () => ({ ok: true, value: [raw] }) }),
    });
    expect(result.results[0]).toEqual({
      citation: raw.file,
      snippet: raw.snippet,
      score: raw.score,
      collection: raw.collection,
      contradictions: {
        status: 'available',
        references: [{ memoryId: target.id, title: target.title }],
      },
    });
    expect(JSON.stringify(result)).not.toContain(hidden.id);
    expect(JSON.stringify(result)).not.toContain(hidden.title);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('local unknown citation and unavailable store never claim a measured zero', async () => {
    const port = {
      makeAdapter: () => ({
        query: async () => ({
          ok: true as const,
          value: [
            {
              file: 'qmd://kb-curated/legacy.md',
              snippet: 'legacy',
              score: 1,
              collection: 'kb-curated',
            },
          ],
        }),
      }),
    };
    expect((await searchTool({ query: 'x' }, config, port)).results[0]!.contradictions).toEqual({
      status: 'unavailable',
    });
    expect(
      (await searchTool({ query: 'x' }, { ...config, dbPath: join(root, 'missing.db') }, port))
        .results[0]!.contradictions,
    ).toEqual({ status: 'unavailable' });
  });

  it.each(['available', 'unavailable', 'absent', 'malformed', 'duplicate'])(
    'remote mode forwards %s metadata with validation',
    async (kind) => {
      const reference = { memoryId: randomUUID(), title: 'visible reference' };
      const metadata =
        kind === 'available'
          ? { status: 'available', references: [reference] }
          : kind === 'unavailable'
            ? { status: 'unavailable' }
            : kind === 'duplicate'
              ? { status: 'available', references: [reference, reference] }
              : kind === 'malformed'
                ? {
                    status: 'available',
                    references: [{ memoryId: 'broken', title: 'private sentinel' }],
                  }
                : undefined;
      const response = {
        hits: [
          {
            citation: 'qmd://kb-curated/a.md',
            snippet: 'unchanged',
            score: 0.5,
            contradictions: metadata,
          },
        ],
      };
      const fetchFn = (async () => ({
        ok: true,
        json: async () => response,
      })) as unknown as typeof fetch;
      const result = await searchTool(
        { query: 'x' },
        { ...config, apiUrl: 'http://fixture.invalid' },
        { fetchFn },
      );
      expect(result.results[0]!.contradictions).toEqual(
        kind === 'available' ? metadata : kind === 'absent' ? undefined : { status: 'unavailable' },
      );
      expect(result.results[0]!.score).toBe(0.5);
      expect(result.results[0]!.citation).toBe('qmd://kb-curated/a.md');
      if (kind === 'malformed') expect(JSON.stringify(result)).not.toContain('private sentinel');
    },
  );
});
