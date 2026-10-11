import { join } from 'node:path';

import type { Result } from '@qmd-team-intent-kb/common';
import type { QmdError } from '../types.js';
import type { QmdExecutor } from '../executor/executor.js';
import { describeQmdFailure } from '../executor/describe-failure.js';
import { getExportableCollections } from './collection-registry.js';

/** Manage qmd collections (add, remove, list) */
export class CollectionManager {
  constructor(private readonly executor: QmdExecutor) {}

  /** Add a collection pointing to a directory */
  async addCollection(name: string, path: string): Promise<Result<void, QmdError>> {
    const args = ['collection', 'add', path, '--name', name];
    const result = await this.executor.execute(args);
    if (result.exitCode !== 0) {
      return { ok: false, error: describeQmdFailure(args, result) };
    }
    return { ok: true, value: undefined };
  }

  /** Remove a collection */
  async removeCollection(name: string): Promise<Result<void, QmdError>> {
    const args = ['collection', 'remove', name];
    const result = await this.executor.execute(args);
    if (result.exitCode !== 0) {
      return { ok: false, error: describeQmdFailure(args, result) };
    }
    return { ok: true, value: undefined };
  }

  /** List existing collections */
  async listCollections(): Promise<Result<string[], QmdError>> {
    const args = ['collection', 'list'];
    const result = await this.executor.execute(args);
    if (result.exitCode !== 0) {
      // A missing binary maps to `not_available`, which ensureCollections treats as fatal.
      return { ok: false, error: describeQmdFailure(args, result) };
    }
    const collections = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim());
    return { ok: true, value: collections };
  }

  /**
   * Ensure every exportable collection exists, creating missing ones.
   *
   * Each collection's source is `<exportBaseDir>/<sourceSubdir>` — the
   * git-exporter output tree — so `qmd update` indexes the markdown the
   * exporter actually writes. Collections with no exported source (e.g.
   * `kb-inbox`) are skipped. Callers must ensure the source subdirs exist
   * before this runs (the adapter facade does this); `qmd collection add`
   * against a missing dir would fail.
   */
  async ensureCollections(exportBaseDir: string): Promise<Result<string[], QmdError>> {
    const listResult = await this.listCollections();
    // A missing binary is fatal and must surface as itself; any other list
    // failure is tolerated (treated as "no collections yet") as before.
    if (!listResult.ok && listResult.error.code === 'not_available') {
      return { ok: false, error: listResult.error };
    }
    const existing = listResult.ok ? listResult.value : [];

    const created: string[] = [];
    for (const def of getExportableCollections()) {
      if (!existing.some((e) => e.includes(def.name))) {
        const path = join(exportBaseDir, def.sourceSubdir);
        const addResult = await this.addCollection(def.name, path);
        if (!addResult.ok) return { ok: false, error: addResult.error };
        created.push(def.name);
      }
    }
    return { ok: true, value: created };
  }
}
