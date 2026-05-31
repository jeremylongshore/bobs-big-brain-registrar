/**
 * Unit tests for the exporter-cli dispatch (bead `e3q`). qmd-independent —
 * covers argument parsing, error paths, and the export happy path against a
 * file-backed store, so `cli.ts` is covered even on CI runners without qmd
 * (the real-qmd end-to-end proof lives in cli-qmd-integration.test.ts).
 *
 * @module __tests__/cli.test
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateRepository, MemoryRepository, createDatabase } from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type ExporterCliDeps } from '../cli.js';

let workDir: string;
let dbPath: string;
let exportDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'exporter-cli-test-'));
  dbPath = join(workDir, 'teamkb.db');
  exportDir = join(workDir, 'kb-export');
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function stdoutText(): string {
  const calls = stdoutSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}
function stderrText(): string {
  const calls = stderrSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

const deps: ExporterCliDeps = {
  createDb: ({ dbPath: p }) => createDatabase({ path: p ?? ':memory:' }),
};

function seed(memories: ReturnType<typeof makeMemory>[]): void {
  const db = createDatabase({ path: dbPath });
  try {
    new CandidateRepository(db);
    const repo = new MemoryRepository(db);
    for (const m of memories) repo.insert(m);
  } finally {
    (db as unknown as { close: () => void }).close();
  }
}

// ---------------------------------------------------------------------------
// Usage / argument errors
// ---------------------------------------------------------------------------

describe('exporter-cli dispatch — usage errors', () => {
  it('exits 2 with usage on no subcommand', async () => {
    expect(await dispatch([], deps)).toBe(2);
    expect(stderrText()).toMatch(/missing subcommand/);
  });

  it('exits 2 on unknown subcommand', async () => {
    expect(await dispatch(['frobnicate'], deps)).toBe(2);
    expect(stderrText()).toMatch(/unknown subcommand "frobnicate"/);
  });

  it.each(['help', '--help', '-h'])('prints usage on %s', async (flag) => {
    expect(await dispatch([flag], deps)).toBe(0);
    expect(stdoutText()).toMatch(/Usage:/);
    expect(stdoutText()).toMatch(/export --db/);
  });
});

describe('exporter-cli export — argument errors', () => {
  it('exits 2 when --db is missing', async () => {
    expect(await dispatch(['export', '--out', exportDir], deps)).toBe(2);
    expect(stderrText()).toMatch(/missing required flag: --db/);
  });

  it('exits 2 when --out is missing', async () => {
    expect(await dispatch(['export', '--db', dbPath], deps)).toBe(2);
    expect(stderrText()).toMatch(/missing required flag: --out/);
  });

  it('exits 2 on unknown flag', async () => {
    expect(await dispatch(['export', '--db', dbPath, '--out', exportDir, '--bogus'], deps)).toBe(2);
    expect(stderrText()).toMatch(/unknown flag: --bogus/);
  });
});

// ---------------------------------------------------------------------------
// export happy path (qmd-independent)
// ---------------------------------------------------------------------------

describe('exporter-cli export — writes curated memories as markdown', () => {
  it('exports a curated memory and reports written=1 (--json)', async () => {
    seed([makeMemory({ title: 'A pattern', category: 'pattern', tenantId: 'demo-e2e' })]);
    const rc = await dispatch(['export', '--db', dbPath, '--out', exportDir, '--json'], deps);
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['written']).toBe(1);
    expect(parsed['out_dir']).toBe(exportDir);
    // pattern → curated/ per directory-mapper
    expect(existsSync(join(exportDir, 'curated'))).toBe(true);
  });

  it('human output prints the written/archived/skipped summary', async () => {
    seed([makeMemory({ category: 'decision', tenantId: 'demo-e2e' })]);
    const rc = await dispatch(['export', '--db', dbPath, '--out', exportDir], deps);
    expect(rc).toBe(0);
    expect(stdoutText()).toMatch(/Written:\s+1/);
    expect(existsSync(join(exportDir, 'decisions'))).toBe(true);
  });

  it('restricts export to one tenant when --tenant is given', async () => {
    seed([
      makeMemory({ title: 'Keep', category: 'pattern', tenantId: 'alpha' }),
      makeMemory({ title: 'Drop', category: 'pattern', tenantId: 'beta' }),
    ]);
    const rc = await dispatch(
      ['export', '--db', dbPath, '--out', exportDir, '--tenant', 'alpha', '--json'],
      deps,
    );
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['written']).toBe(1);
    expect(parsed['tenant_id']).toBe('alpha');
  });

  it('exports nothing (written=0) from an empty store', async () => {
    seed([]);
    const rc = await dispatch(['export', '--db', dbPath, '--out', exportDir, '--json'], deps);
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['written']).toBe(0);
  });

  it('exits 1 with a JSON error envelope when runExport throws', async () => {
    // Inject a db whose MemoryRepository construction will blow up by handing
    // dispatch a factory that returns a broken object.
    const brokenDeps: ExporterCliDeps = {
      createDb: () =>
        ({
          prepare: () => {
            throw new Error('boom db');
          },
        }) as never,
    };
    const rc = await dispatch(['export', '--db', dbPath, '--out', exportDir, '--json'], brokenDeps);
    expect(rc).toBe(1);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    expect(parsed['code']).toBe('EXPORT_FAILED');
  });

  it('produces files actually on disk (sanity)', async () => {
    seed([makeMemory({ category: 'reference', tenantId: 'demo-e2e' })]);
    await dispatch(['export', '--db', dbPath, '--out', exportDir], deps);
    // reference → guides/
    const guides = await readdir(join(exportDir, 'guides'));
    expect(guides.length).toBeGreaterThanOrEqual(1);
    expect(guides[0]).toMatch(/\.md$/);
  });
});
