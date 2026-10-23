import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { createDatabase } from '../../packages/store/src/index.js';

export interface EstateEvalSnapshot {
  base: string;
  exportDir: string;
  startedAt: string;
  completedAt: string;
  indexes: { qmd: boolean; native: boolean; dense: boolean };
}

/**
 * Copies only the selected tenant's derived state and the source store into a
 * private temporary directory. SQLite backup includes committed WAL frames;
 * copying a live .sqlite file alone would miss them. Readonly SQLite may still
 * create empty WAL/SHM files and update SHM reader coordination at source;
 * source database and committed WAL data are not rewritten. Each DB is consistent
 * independently, not an atomic snapshot of the corpus/index/export ensemble.
 * The callback must close its handles (the CLI uses a child process) before
 * returning so cleanup cannot leave cached adapters holding deleted databases.
 */
export async function withEstateEvalSnapshot<T>(
  sourceBase: string,
  tenant: string,
  action: (snapshot: EstateEvalSnapshot) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const sourceIndex = resolve(sourceBase, 'qmd-index', tenant);
  const indexRoot = resolve(sourceBase, 'qmd-index');
  const tenantRelative = relative(indexRoot, sourceIndex);
  if (!tenantRelative || tenantRelative.startsWith('..') || tenantRelative.includes('/')) {
    throw new Error('Evaluation tenant must name one index directory');
  }
  const startedAt = new Date().toISOString();
  const base = mkdtempSync(join(tmpdir(), 'teamkb-estate-eval-'));
  const targetIndex = join(base, 'qmd-index', tenant);
  async function backup(source: string, target: string, required = false): Promise<boolean> {
    signal?.throwIfAborted();
    if (!existsSync(source)) {
      if (required) throw new Error(`Missing evaluation store: ${source}`);
      return false;
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const db = createDatabase({ path: source, readonly: true });
    try {
      await db.backup(target);
      return true;
    } finally {
      db.close();
    }
  }
  try {
    mkdirSync(join(targetIndex, 'cache', 'qmd'), { recursive: true, mode: 0o700 });
    mkdirSync(join(targetIndex, 'config', 'qmd'), { recursive: true, mode: 0o700 });
    await backup(join(sourceBase, 'teamkb.db'), join(base, 'teamkb.db'), true);
    const registry = join('config', 'qmd', 'index.yml');
    if (existsSync(join(sourceIndex, registry))) {
      mkdirSync(dirname(join(targetIndex, registry)), { recursive: true, mode: 0o700 });
      copyFileSync(join(sourceIndex, registry), join(targetIndex, registry));
    }
    const qmd = await backup(
      join(sourceIndex, 'cache', 'qmd', 'index.sqlite'),
      join(targetIndex, 'cache', 'qmd', 'index.sqlite'),
    );
    const native = await backup(
      join(sourceIndex, 'native-fts5.sqlite'),
      join(targetIndex, 'native-fts5.sqlite'),
    );
    const dense = await backup(
      join(sourceIndex, 'dense-vec.sqlite'),
      join(targetIndex, 'dense-vec.sqlite'),
    );
    signal?.throwIfAborted();
    return await action({
      base,
      exportDir: join(sourceBase, 'kb-export'),
      indexes: { qmd, native, dense },
      startedAt,
      completedAt: new Date().toISOString(),
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
