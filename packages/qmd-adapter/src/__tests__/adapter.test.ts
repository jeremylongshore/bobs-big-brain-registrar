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
    // Pass the bound tenant — the adapter is fail-closed on an omitted
    // tenantId (c5k.2), so a delegation test must name the tenant it serves.
    const result = await adapter.query('test query', 'curated', 'test-tenant');
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
    const result = await adapter.query('test', 'curated', 'test-tenant');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should not include inbox results
      expect(result.value.some((r) => r.collection === 'kb-inbox')).toBe(false);
    }
  });

  // ---- tenant-isolation guard (EPIC 0, compile-then-govern-c5k) -----------

  it('serves the query when the requested tenant matches the bound tenant', async () => {
    mock.queueSuccess(
      JSON.stringify([{ score: 0.9, file: 'qmd://kb-curated/doc.md', snippet: 'Result' }]),
    );
    const result = await adapter.query('test', 'curated', 'test-tenant');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
    }
  });

  it('returns empty (does NOT leak the bound tenant) on a tenant mismatch', async () => {
    // The adapter is bound to `test-tenant`. A request for another tenant must
    // not be served this adapter's index — defense-in-depth for the API-layer
    // token→tenant binding.
    const result = await adapter.query('test', 'curated', 'other-tenant');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
    // The executor was never invoked — nothing reached qmd.
    expect(mock.commands).toHaveLength(0);
  });
});
