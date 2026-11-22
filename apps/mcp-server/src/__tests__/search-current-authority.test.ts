import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, MemoryRepository } from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { searchTool } from '../tools/search.js';
import type { McpServerConfig } from '../config.js';
let root: string;
let db: ReturnType<typeof createDatabase>;
let config: McpServerConfig;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'search-authority-'));
  config = {
    tenantId: 'acme',
    basePath: root,
    dbPath: join(root, 'store.db'),
    spoolPath: join(root, 'spool'),
    feedbackPath: join(root, 'feedback'),
  };
  db = createDatabase({ path: config.dbPath });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const port = (id: string) => ({
  makeAdapter: () => ({
    query: async () => ({
      ok: true as const,
      value: [
        {
          file: `qmd://kb-curated/${id}.md`,
          snippet: 'stale-private-sentinel',
          score: 1,
          collection: 'kb-curated',
        },
      ],
    }),
  }),
});
describe('local MCP current store authority', () => {
  it('withholds unresolved citations', async () => {
    expect(
      (await searchTool({ query: 'needle' }, config, port('legacy-private-title'))).results,
    ).toEqual([]);
  });
  it('withholds hits when the store cannot be opened', async () => {
    expect(
      (
        await searchTool(
          { query: 'needle' },
          { ...config, dbPath: join(root, 'absent.db') },
          port('11111111-1111-4111-8111-111111111111'),
        )
      ).results,
    ).toEqual([]);
  });
  it('returns current content instead of stale cached text', async () => {
    const row = makeMemory({ tenantId: 'acme', content: 'needle [REDACTED]' });
    new MemoryRepository(db).insert(row);
    const result = await searchTool({ query: 'needle' }, config, port(row.id));
    expect(result.results[0]!.snippet).toBe(row.content);
    expect(JSON.stringify(result)).not.toContain('stale-private-sentinel');
  });
  it('withholds all hits on malformed stored authority', async () => {
    const row = makeMemory({ tenantId: 'acme' });
    new MemoryRepository(db).insert(row);
    db.prepare('UPDATE curated_memories SET metadata_json=? WHERE id=?').run(
      'private-invalid-json',
      row.id,
    );
    expect((await searchTool({ query: 'needle' }, config, port(row.id))).results).toEqual([]);
  });
});
