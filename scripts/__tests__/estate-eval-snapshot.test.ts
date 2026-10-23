import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../packages/store/src/index.js';
import { DenseVecIndex } from '../../packages/qmd-adapter/src/dense/dense-index.js';
import { withEstateEvalSnapshot } from '../lib/estate-eval-snapshot.js';

function files(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.endsWith('-shm'))
      .filter(
        (entry) =>
          !entry.name.endsWith('-wal') ||
          readFileSync(join(entry.parentPath, entry.name)).length > 0,
      )
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, createHash('sha256').update(readFileSync(path)).digest('hex')];
      }),
  );
}

describe('estate eval snapshot', () => {
  let base: string;
  const tenant = 'fixture';
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'estate-snapshot-test-'));
    createDatabase({ path: join(base, 'teamkb.db') }).close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('preserves committed WAL state and sqlite-vec data without changing source files', async () => {
    const sourceIndex = join(base, 'qmd-index', tenant);
    const source = createDatabase({ path: join(base, 'teamkb.db') });
    source.exec('CREATE TABLE receipt (id INTEGER); INSERT INTO receipt VALUES (42)');
    const registry = join(sourceIndex, 'config', 'qmd', 'index.yml');
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, 'collections: {}\n');
    for (const path of ['native-fts5.sqlite', 'cache/qmd/index.sqlite']) {
      const db = createDatabase({ path: join(sourceIndex, path) });
      db.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('original')");
      db.close();
    }
    const model = { modelId: 'fixture', modelVersion: 'fixture-v1' };
    const dense = new DenseVecIndex({ path: join(sourceIndex, 'dense-vec.sqlite'), ...model });
    dense.upsert({
      docId: 'qmd://kb-curated/test.md',
      collection: 'kb-curated',
      contentHash: 'h',
      snippet: 'fixture',
      embedding: new Float32Array([1, 0, 0]),
    });
    dense.close();
    const before = files(base);
    let temporary = '';
    try {
      await withEstateEvalSnapshot(base, tenant, async (snapshot) => {
        temporary = snapshot.base;
        expect(snapshot.indexes).toEqual({ qmd: true, native: true, dense: true });
        expect(snapshot.exportDir).toBe(join(base, 'kb-export'));
        const copy = createDatabase({ path: join(snapshot.base, 'teamkb.db'), readonly: true });
        expect(copy.prepare('SELECT id FROM receipt').get()).toEqual({ id: 42 });
        copy.close();
        const copiedIndex = join(snapshot.base, 'qmd-index', tenant);
        const copiedDense = new DenseVecIndex({
          path: join(copiedIndex, 'dense-vec.sqlite'),
          ...model,
        });
        expect(copiedDense.search(new Float32Array([1, 0, 0]), 1)[0]?.id).toBe(
          'qmd://kb-curated/test.md',
        );
        copiedDense.remove(['qmd://kb-curated/test.md']);
        copiedDense.close();
        for (const path of ['native-fts5.sqlite', 'cache/qmd/index.sqlite']) {
          const db = createDatabase({ path: join(copiedIndex, path), readonly: true });
          expect(db.prepare('SELECT value FROM marker').get()).toEqual({ value: 'original' });
          db.close();
          writeFileSync(join(copiedIndex, path), 'changed copy');
        }
      });
      expect(files(base)).toEqual(before);
      expect(existsSync(temporary)).toBe(false);
    } finally {
      source.close();
    }
  });

  it('reports absent indexes and cleans up after a failing worker action', async () => {
    let temporary = '';
    await expect(
      withEstateEvalSnapshot(base, tenant, async (snapshot) => {
        temporary = snapshot.base;
        expect(snapshot.indexes).toEqual({ qmd: false, native: false, dense: false });
        throw new Error('worker failed');
      }),
    ).rejects.toThrow('worker failed');
    expect(existsSync(temporary)).toBe(false);
    expect(Object.keys(files(base))).toEqual([join(base, 'teamkb.db')]);
    expect(
      readdirSync(base).every((name) =>
        ['teamkb.db', 'teamkb.db-shm', 'teamkb.db-wal'].includes(name),
      ),
    ).toBe(true);
  });

  it('waits for an active backup before cleaning up cancellation', async () => {
    const scratch = join(base, 'scratch');
    mkdirSync(scratch);
    vi.stubEnv('TMPDIR', scratch);
    const controller = new AbortController();
    let called = false;
    const pending = withEstateEvalSnapshot(
      base,
      tenant,
      async () => {
        called = true;
      },
      controller.signal,
    );
    // The helper is suspended in its first asynchronous SQLite backup here.
    controller.abort(new Error('cancelled during backup'));
    await expect(pending).rejects.toThrow('cancelled during backup');
    expect(called).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('does not invoke evaluation after a corrupt index backup', async () => {
    const index = join(base, 'qmd-index', tenant, 'native-fts5.sqlite');
    mkdirSync(dirname(index), { recursive: true });
    writeFileSync(index, 'not a database');
    const before = files(base);
    let called = false;
    await expect(
      withEstateEvalSnapshot(base, tenant, async () => {
        called = true;
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
    expect(files(base)).toEqual(before);
  });

  it.each(['../escape', '/absolute', '.', 'tenant/nested'])(
    'rejects unsafe tenant %s before evaluation',
    async (value) => {
      await expect(withEstateEvalSnapshot(base, value, async () => undefined)).rejects.toThrow(
        'tenant',
      );
    },
  );
});
