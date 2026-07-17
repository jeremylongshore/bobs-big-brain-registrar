import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    adapter = new QmdAdapter(
      { tenantId: 'test-tenant', exportDir, nativeIndexPath: ':memory:' },
      mock,
    );
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

// ─── R2: native FTS5 fusion behind query() (qmd-team-intent-kb-vps.2) ────────

describe('QmdAdapter — native FTS5 fusion', () => {
  let mock: MockQmdExecutor;
  let exportDir: string;

  function write(subdir: string, name: string, content: string): void {
    mkdirSync(join(exportDir, subdir), { recursive: true });
    writeFileSync(join(exportDir, subdir, name), content);
  }

  function fusedAdapter(): QmdAdapter {
    return new QmdAdapter(
      { tenantId: 'test-tenant', exportDir, nativeIndexPath: ':memory:' },
      mock,
    );
  }

  beforeEach(() => {
    mock = new MockQmdExecutor();
    exportDir = mkdtempSync(join(tmpdir(), 'qmd-adapter-fusion-test-'));
  });

  afterEach(() => {
    rmSync(exportDir, { recursive: true, force: true });
  });

  it('surfaces a native hit when qmd returns nothing (the 2026-07-16 hyphen miss)', async () => {
    write('curated', 'mcp-dup.md', 'the governed-brain MCP server was registered twice');
    mock.queueSuccess('[]'); // qmd keyword-AND: zero hits for the hyphenated query
    const result = await fusedAdapter().query(
      'governed-brain registered',
      'curated',
      'test-tenant',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.file).toBe('qmd://kb-curated/mcp-dup.md');
      expect(result.value[0]!.collection).toBe('kb-curated');
    }
  });

  it('fuses both lists — a doc found by both backends ranks first', async () => {
    write('curated', 'both.md', 'caddy ingress rules for the brain');
    write('curated', 'native-only.md', 'more caddy notes nobody indexed');
    mock.queueSuccess(
      JSON.stringify([{ score: 2, file: 'qmd://kb-curated/both.md', snippet: 'qmd snip' }]),
    );
    const result = await fusedAdapter().query('caddy', 'curated', 'test-tenant');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      expect(result.value[0]!.file).toBe('qmd://kb-curated/both.md');
      expect(result.value[0]!.snippet).toBe('qmd snip'); // qmd snippet preferred
    }
  });

  it('serves native-only results when the qmd binary fails outright', async () => {
    write('curated', 'a.md', 'resilience content');
    mock.queueFailure('qmd: command not found', 127);
    const result = await fusedAdapter().query('resilience', 'curated', 'test-tenant');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(1);
  });

  it('keeps the qmd error when both backends come up empty', async () => {
    mock.queueFailure('boom', 1);
    const result = await fusedAdapter().query('anything', 'curated', 'test-tenant');
    expect(result.ok).toBe(false);
  });

  it('scope-filters native hits (archive excluded from curated scope)', async () => {
    write('archive', 'old.md', 'unique archived topic');
    mock.queueSuccess('[]');
    const adapter = fusedAdapter();
    const curated = await adapter.query('archived topic', 'curated', 'test-tenant');
    expect(curated.ok).toBe(true);
    if (curated.ok) expect(curated.value).toHaveLength(0);
    mock.queueSuccess('[]');
    const archived = await adapter.query('archived topic', 'archived', 'test-tenant');
    expect(archived.ok).toBe(true);
    if (archived.ok) expect(archived.value).toHaveLength(1);
  });

  it('honours the disableNativeFusion kill switch', async () => {
    write('curated', 'a.md', 'kill switch content');
    mock.queueSuccess('[]');
    const adapter = new QmdAdapter(
      {
        tenantId: 'test-tenant',
        exportDir,
        nativeIndexPath: ':memory:',
        disableNativeFusion: true,
      },
      mock,
    );
    const result = await adapter.query('kill switch', 'curated', 'test-tenant');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(0);
  });

  it('still refuses a mismatched tenant before touching either backend', async () => {
    write('curated', 'a.md', 'tenant guard content');
    const result = await fusedAdapter().query('tenant guard', 'curated', 'other-tenant');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});
