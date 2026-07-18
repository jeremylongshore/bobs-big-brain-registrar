import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createDatabase, MemoryRepository } from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { searchTool } from '../tools/search.js';
import type { QmdQueryPort } from '../tools/search.js';
import type { McpServerConfig } from '../config.js';

function makeConfig(over: Partial<McpServerConfig> = {}): McpServerConfig {
  const base = '/tmp/teamkb-search-test';
  return {
    tenantId: 'test-tenant',
    basePath: base,
    spoolPath: join(base, 'spool'),
    dbPath: join(base, 'teamkb.db'),
    feedbackPath: join(base, 'feedback'),
    exportDir: join(base, 'kb-export'),
    ...over,
  };
}

function fakeAdapter(
  hits: Array<{ file: string; score: number; snippet: string; collection: string }>,
  fail = false,
): QmdQueryPort {
  return {
    query: () =>
      Promise.resolve(
        fail ? { ok: false as const, error: 'x' } : { ok: true as const, value: hits },
      ),
  };
}

describe('searchTool — local qmd mode (TEAMKB_API_URL unset)', () => {
  it('returns qmd:// citations from the local adapter', async () => {
    const adapter = fakeAdapter([
      {
        file: 'qmd://kb-curated/system-map.md',
        score: 0.9,
        snippet: 'map',
        collection: 'kb-curated',
      },
    ]);
    const result = await searchTool({ query: 'caddy' }, makeConfig(), {
      makeAdapter: () => adapter,
    });

    expect(result.source).toBe('qmd-local');
    expect(result.scope).toBe('curated');
    expect(result.count).toBe(1);
    expect(result.results[0]!.citation).toBe('qmd://kb-curated/system-map.md');
    expect(result.results[0]!.collection).toBe('kb-curated');
  });

  it('passes tenant + exportDir into the adapter factory', async () => {
    let seen: { tenantId?: string; exportDir?: string } = {};
    await searchTool({ query: 'x' }, makeConfig({ tenantId: 'acme', exportDir: '/data/exp' }), {
      makeAdapter: (tenantId, exportDir) => {
        seen = { tenantId, exportDir };
        return fakeAdapter([]);
      },
    });
    expect(seen.tenantId).toBe('acme');
    expect(seen.exportDir).toBe('/data/exp');
  });

  it('honours the limit', async () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({
      file: `qmd://kb-curated/${i}.md`,
      score: 1 - i / 10,
      snippet: '',
      collection: 'kb-curated',
    }));
    const result = await searchTool({ query: 'x', limit: 2 }, makeConfig(), {
      makeAdapter: () => fakeAdapter(hits),
    });
    expect(result.results).toHaveLength(2);
  });

  it('degrades to empty results when qmd fails (no throw)', async () => {
    const result = await searchTool({ query: 'x' }, makeConfig(), {
      makeAdapter: () => fakeAdapter([], true),
    });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });
});

describe('searchTool — remote brain mode (TEAMKB_API_URL set)', () => {
  it('proxies to the brain API and forwards the bearer token', async () => {
    let captured: { url?: string; auth?: string; body?: unknown } = {};
    const fetchFn = ((url: string, init: RequestInit) => {
      captured = {
        url,
        auth: (init.headers as Record<string, string>)['authorization'],
        body: JSON.parse(init.body as string),
      };
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            hits: [
              {
                citation: 'qmd://kb-curated/a.md',
                snippet: 's',
                score: 0.8,
                collection: 'kb-curated',
              },
            ],
          }),
      });
    }) as unknown as typeof fetch;

    const result = await searchTool(
      { query: 'caddy', scope: 'curated', limit: 5 },
      makeConfig({ apiUrl: 'http://dev:3847/', apiToken: 'user-token-abc' }),
      { fetchFn },
    );

    expect(result.source).toBe('brain-api');
    expect(captured.url).toBe('http://dev:3847/api/search');
    expect(captured.auth).toBe('Bearer user-token-abc');
    expect((captured.body as { query: string }).query).toBe('caddy');
    expect(result.results[0]!.citation).toBe('qmd://kb-curated/a.md');
  });

  it('degrades to empty results when the brain is unreachable', async () => {
    const fetchFn = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const result = await searchTool({ query: 'x' }, makeConfig({ apiUrl: 'http://dev:3847' }), {
      fetchFn,
    });
    expect(result.source).toBe('brain-api');
    expect(result.count).toBe(0);
  });

  it('omits the Authorization header when no token is configured', async () => {
    let auth: string | undefined = 'unset';
    const fetchFn = ((_url: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>)['authorization'];
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ hits: [] }) });
    }) as unknown as typeof fetch;

    await searchTool({ query: 'x' }, makeConfig({ apiUrl: 'http://dev:3847' }), { fetchFn });
    expect(auth).toBeUndefined();
  });
});

describe('searchTool — local read-time sensitivity filter (5bm.11)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('drops a confidential hit whose citation resolves to a sensitive stored row', async () => {
    dir = mkdtempSync(join(tmpdir(), 'teamkb-sens-'));
    const dbPath = join(dir, 'teamkb.db');
    const db = createDatabase({ path: dbPath });
    const repo = new MemoryRepository(db);
    const visible = makeMemory({ title: 'Public map', sensitivity: 'internal' });
    const secret = makeMemory({
      title: 'Secret map',
      sensitivity: 'confidential',
      contentHash: 'c'.repeat(64),
    });
    repo.insert(visible);
    repo.insert(secret);
    db.close();

    // A stale/pre-skip index could surface BOTH citations; the read-time filter
    // must still drop the confidential one.
    const adapter: QmdQueryPort = {
      query: () =>
        Promise.resolve({
          ok: true as const,
          value: [
            {
              file: `qmd://kb-curated/${visible.id}.md`,
              score: 0.9,
              snippet: '',
              collection: 'kb-curated',
            },
            {
              file: `qmd://kb-curated/${secret.id}.md`,
              score: 0.8,
              snippet: '',
              collection: 'kb-curated',
            },
          ],
        }),
    };

    const result = await searchTool({ query: 'map' }, makeConfig({ dbPath }), {
      makeAdapter: () => adapter,
    });

    const citations = result.results.map((r) => r.citation);
    expect(citations).toContain(`qmd://kb-curated/${visible.id}.md`);
    expect(citations).not.toContain(`qmd://kb-curated/${secret.id}.md`);
    expect(result.count).toBe(1);
  });
});
