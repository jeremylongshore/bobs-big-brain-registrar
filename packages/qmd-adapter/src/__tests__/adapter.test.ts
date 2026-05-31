import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockQmdExecutor } from '../executor/mock-executor.js';
import { QmdAdapter } from '../adapter.js';

describe('QmdAdapter', () => {
  let mock: MockQmdExecutor;
  let adapter: QmdAdapter;
  let exportDir: string;

  beforeEach(() => {
    mock = new MockQmdExecutor();
    exportDir = mkdtempSync(join(tmpdir(), 'qmd-adapter-test-'));
    adapter = new QmdAdapter({ tenantId: 'test-tenant', exportDir }, mock);
  });

  afterEach(() => {
    rmSync(exportDir, { recursive: true, force: true });
  });

  it('delegates query to search client', async () => {
    mock.queueSuccess(
      JSON.stringify([{ score: 0.9, file: 'qmd://kb-curated/doc.md', snippet: 'Result snippet' }]),
    );
    const result = await adapter.query('test query');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
    }
  });

  it('delegates health to checkHealth', async () => {
    mock.queueSuccess('qmd 2.0.1');
    mock.queueSuccess('kb-curated');
    const status = await adapter.health();
    expect(status.available).toBe(true);
  });

  it('delegates update to index lifecycle', async () => {
    mock.queueSuccess('Updated');
    const result = await adapter.update();
    expect(result.ok).toBe(true);
  });

  it('delegates ensureCollections to collection manager (4 exportable collections)', async () => {
    mock.queueSuccess(''); // list
    for (let i = 0; i < 4; i++) mock.queueSuccess(''); // adds
    const result = await adapter.ensureCollections();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['kb-curated', 'kb-decisions', 'kb-guides', 'kb-archive']);
    }
    // Sources point at the export tree, not a per-tenant index dir
    const firstAdd = mock.commands.find((c) => c[0] === 'collection' && c[1] === 'add');
    expect(firstAdd?.[2]).toBe(join(exportDir, 'curated'));
  });

  it('enforces curated-only default on query', async () => {
    mock.queueSuccess(
      JSON.stringify([
        { score: 0.9, file: 'qmd://kb-curated/a.md', snippet: 'A' },
        { score: 0.8, file: 'qmd://kb-inbox/b.md', snippet: 'B' },
      ]),
    );
    const result = await adapter.query('test');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should not include inbox results
      expect(result.value.some((r) => r.collection === 'kb-inbox')).toBe(false);
    }
  });
});
