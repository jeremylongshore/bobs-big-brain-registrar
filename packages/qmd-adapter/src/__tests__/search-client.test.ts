import { describe, it, expect, beforeEach } from 'vitest';
import { MockQmdExecutor } from '../executor/mock-executor.js';
import { SearchClient } from '../search/search-client.js';
import type { QmdSearchResult } from '../types.js';

/** Build a qmd `search --json` stdout payload from partial hits. */
function jsonHits(hits: Array<Partial<QmdSearchResult>>): string {
  return JSON.stringify(
    hits.map((h, i) => ({
      docid: `#${i}`,
      score: h.score ?? 0.9,
      file: h.file ?? '',
      title: 'T',
      snippet: h.snippet ?? '',
    })),
  );
}

describe('SearchClient', () => {
  let mock: MockQmdExecutor;
  let client: SearchClient;

  beforeEach(() => {
    mock = new MockQmdExecutor();
    client = new SearchClient(mock);
  });

  it('executes a search (with --json) and returns results', async () => {
    mock.queueSuccess(
      jsonHits([{ score: 0.95, file: 'qmd://kb-curated/doc.md', snippet: 'snip' }]),
    );
    const result = await client.search('test query');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.score).toBe(0.95);
      expect(result.value[0]!.collection).toBe('kb-curated');
    }
    // The client must request JSON output and terminate option parsing
    expect(mock.lastCommand).toEqual(['search', '--json', '--', 'test query']);
  });

  it('defaults scope to curated', async () => {
    mock.queueSuccess(
      jsonHits([
        { file: 'qmd://kb-curated/a.md' },
        { file: 'qmd://kb-inbox/b.md' },
        { file: 'qmd://kb-guides/c.md' },
      ]),
    );
    const result = await client.search('test');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const collections = result.value.map((r) => r.collection);
      expect(collections).not.toContain('kb-inbox');
      expect(collections).toContain('kb-curated');
      expect(collections).toContain('kb-guides');
    }
  });

  it('scope "all" returns everything', async () => {
    mock.queueSuccess(
      jsonHits([
        { file: 'qmd://kb-curated/a.md' },
        { file: 'qmd://kb-inbox/b.md' },
        { file: 'qmd://kb-archive/c.md' },
      ]),
    );
    const result = await client.search('test', 'all');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
    }
  });

  it('scope "inbox" only returns inbox results', async () => {
    mock.queueSuccess(
      jsonHits([{ file: 'qmd://kb-curated/a.md' }, { file: 'qmd://kb-inbox/b.md' }]),
    );
    const result = await client.search('test', 'inbox');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.collection).toBe('kb-inbox');
    }
  });

  it('scope "archived" only returns archive results', async () => {
    mock.queueSuccess(
      jsonHits([{ file: 'qmd://kb-curated/a.md' }, { file: 'qmd://kb-archive/b.md' }]),
    );
    const result = await client.search('test', 'archived');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.collection).toBe('kb-archive');
    }
  });

  it('scope "bulk" only returns bulk results (5bm.8)', async () => {
    mock.queueSuccess(
      jsonHits([{ file: 'qmd://kb-curated/a.md' }, { file: 'qmd://kb-bulk/b.md' }]),
    );
    const result = await client.search('test', 'bulk');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.collection).toBe('kb-bulk');
    }
  });

  it('default curated scope excludes kb-bulk hits (5bm.8)', async () => {
    mock.queueSuccess(
      jsonHits([{ file: 'qmd://kb-curated/a.md' }, { file: 'qmd://kb-bulk/b.md' }]),
    );
    const result = await client.search('test');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.collection).toBe('kb-curated');
    }
  });

  it('returns error on command failure', async () => {
    mock.queueFailure('search error', 1);
    const result = await client.search('test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('command_failed');
    }
  });

  it('handles empty search results', async () => {
    mock.queueSuccess('');
    const result = await client.search('nonexistent');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });
});
