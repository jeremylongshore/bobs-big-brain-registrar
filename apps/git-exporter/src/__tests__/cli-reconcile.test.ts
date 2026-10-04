/**
 * exporter-cli `export --reconcile` / `--max-orphan-removals` — argument
 * validation, stale-file removal, idempotence and the mass-delete guard.
 *
 * @module __tests__/cli-reconcile.test
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryRepository, createDatabase } from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type ExporterCliDeps } from '../cli.js';

let workDir: string;
let dbPath: string;
let exportDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'exporter-cli-reconcile-'));
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

const text = (spy: ReturnType<typeof vi.spyOn>): string =>
  (spy.mock.calls as unknown as Array<[unknown]>).map((c) => String(c[0])).join('');

const deps: ExporterCliDeps = {
  createDb: ({ dbPath: p }) => createDatabase({ path: p ?? ':memory:' }),
};

function seed(memories: ReturnType<typeof makeMemory>[]): void {
  const db = createDatabase({ path: dbPath });
  try {
    const repo = new MemoryRepository(db);
    for (const m of memories) repo.insert(m);
  } finally {
    (db as unknown as { close: () => void }).close();
  }
}

function plantOrphan(id: string, tenant: string): string {
  mkdirSync(join(exportDir, 'curated'), { recursive: true });
  const p = join(exportDir, 'curated', `${id}.md`);
  writeFileSync(p, `---\nid: "${id}"\ntenant_id: "${tenant}"\n---\nx`);
  return p;
}

const base = (): string[] => [
  'export',
  '--db',
  dbPath,
  '--out',
  exportDir,
  '--tenant',
  'demo-e2e',
  '--json',
];

describe('exporter-cli export --reconcile', () => {
  it('rejects a bad --max-orphan-removals value with exit 2', async () => {
    for (const bad of ['-1', 'abc', '1.5', '']) {
      stderrSpy.mockClear();
      const rc = await dispatch([...base(), '--reconcile', '--max-orphan-removals', bad], deps);
      expect(rc).toBe(2);
      expect(text(stderrSpy)).toMatch(/non-negative integer/);
    }
    expect(await dispatch([...base(), '--max-orphan-removals'], deps)).toBe(2);
  });

  it('removes an orphan the incremental export leaves, then is idempotent', async () => {
    seed([makeMemory({ category: 'decision', tenantId: 'demo-e2e' })]);
    expect(await dispatch(base(), deps)).toBe(0);
    const orphan = plantOrphan('11111111-1111-4111-8111-111111111111', 'demo-e2e');

    expect(await dispatch(base(), deps)).toBe(0); // incremental: orphan survives
    expect(existsSync(orphan)).toBe(true);

    stdoutSpy.mockClear();
    expect(await dispatch([...base(), '--reconcile'], deps)).toBe(0);
    expect((JSON.parse(text(stdoutSpy).trim()) as Record<string, unknown>)['removed']).toBe(1);
    expect(existsSync(orphan)).toBe(false);

    stdoutSpy.mockClear();
    expect(await dispatch([...base(), '--reconcile'], deps)).toBe(0);
    const again = JSON.parse(text(stdoutSpy).trim()) as Record<string, unknown>;
    expect([again['written'], again['archived'], again['removed']]).toEqual([0, 0, 0]);
  });

  it('surfaces removal_blocked and warns on stderr when the cap is exceeded', async () => {
    seed([makeMemory({ category: 'pattern', tenantId: 'demo-e2e' })]);
    const a = plantOrphan('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'demo-e2e');
    const b = plantOrphan('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'demo-e2e');

    const rc = await dispatch([...base(), '--reconcile', '--max-orphan-removals', '1'], deps);
    expect(rc).toBe(0);
    const parsed = JSON.parse(text(stdoutSpy).trim()) as Record<string, unknown>;
    expect(parsed['removal_blocked']).toEqual({ orphans: 2, limit: 1 });
    expect(text(stderrSpy)).toMatch(/refused to remove 2 orphan/);
    expect(existsSync(a) && existsSync(b)).toBe(true);
  });
});
