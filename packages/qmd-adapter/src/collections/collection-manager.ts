import { join } from 'node:path';

import type { Result } from '@qmd-team-intent-kb/common';
import type { QmdError } from '../types.js';
import type { QmdExecutor } from '../executor/executor.js';
import { getExportableCollections } from './collection-registry.js';

/** Manage qmd collections (add, remove, list) */
export class CollectionManager {
  constructor(private readonly executor: QmdExecutor) {}

  /** Add a collection pointing to a directory */
  async addCollection(name: string, path: string): Promise<Result<void, QmdError>> {
    const result = await this.executor.execute(['collection', 'add', path, '--name', name]);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: 'command_failed',
          message: `Failed to add collection "${name}"`,
          command: `qmd collection add ${path} --name ${name}`,
          stderr: result.stderr,
        },
      };
    }
    return { ok: true, value: undefined };
  }

  /** Remove a collection */
  async removeCollection(name: string): Promise<Result<void, QmdError>> {
    const result = await this.executor.execute(['collection', 'remove', name]);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: 'command_failed',
          message: `Failed to remove collection "${name}"`,
          command: `qmd collection remove ${name}`,
          stderr: result.stderr,
        },
      };
    }
    return { ok: true, value: undefined };
  }

  /** List existing collections */
  async listCollections(): Promise<Result<string[], QmdError>> {
    const result = await this.executor.execute(['collection', 'list']);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: 'command_failed',
          message: 'Failed to list collections',
          command: 'qmd collection list',
          stderr: result.stderr,
        },
      };
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
