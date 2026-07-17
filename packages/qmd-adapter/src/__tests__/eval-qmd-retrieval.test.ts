import { describe, it, expect } from 'vitest';

import { QmdAdapter } from '../adapter.js';
import { MockQmdExecutor } from '../executor/mock-executor.js';
import { qmdRetrievalFn } from '../eval/qmd-retrieval.js';

const TENANT = 'intent-solutions';

function adapterWith(mock: MockQmdExecutor): QmdAdapter {
  return new QmdAdapter(
    { tenantId: TENANT, exportDir: '/tmp/does-not-matter', nativeIndexPath: ':memory:' },
    mock,
  );
}

/** A qmd `search --json` payload with ranked qmd:// citations. */
const HITS = JSON.stringify([
  { docid: '#a', score: 0.95, file: 'qmd://kb-curated/aaa.md', title: 'A', snippet: '' },
  { docid: '#b', score: 0.9, file: 'qmd://kb-guides/bbb.md', title: 'B', snippet: '' },
]);

describe('qmdRetrievalFn', () => {
  it('returns the ranked qmd:// citation ids from the production query path', async () => {
    const mock = new MockQmdExecutor();
    mock.queueSuccess(HITS);
    const retrieve = qmdRetrievalFn(adapterWith(mock), TENANT, 'all');

    const ids = await retrieve('some query', 10);

    expect(ids).toEqual(['qmd://kb-curated/aaa.md', 'qmd://kb-guides/bbb.md']);
    // Went through the real search command, not a re-implementation.
    expect(mock.lastCommand).toEqual(['search', '--json', '--', 'some query']);
  });

  it('defaults to curated scope', async () => {
    const mock = new MockQmdExecutor();
    // curated scope filters to kb-curated/kb-decisions/kb-guides; both hits qualify.
    mock.queueSuccess(HITS);
    const retrieve = qmdRetrievalFn(adapterWith(mock), TENANT);

    const ids = await retrieve('q', 10);
    expect(ids).toContain('qmd://kb-curated/aaa.md');
  });

  it('returns [] when the search command fails', async () => {
    const mock = new MockQmdExecutor();
    mock.queueFailure('boom', 1);
    const retrieve = qmdRetrievalFn(adapterWith(mock), TENANT, 'all');

    expect(await retrieve('q', 10)).toEqual([]);
  });

  it('returns [] when the tenant does not match the bound adapter (fail-closed guard)', async () => {
    const mock = new MockQmdExecutor();
    mock.queueSuccess(HITS);
    const retrieve = qmdRetrievalFn(adapterWith(mock), 'a-different-tenant', 'all');

    // The adapter's guard short-circuits before any search command runs.
    expect(await retrieve('q', 10)).toEqual([]);
    expect(mock.commands.length).toBe(0);
  });
});
