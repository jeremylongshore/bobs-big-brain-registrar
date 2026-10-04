import type { Result } from '@qmd-team-intent-kb/common';
import type { QmdError } from '../types.js';
import type { QmdExecutor } from '../executor/executor.js';
import { QMD_NOT_FOUND_EXIT_CODE } from '../executor/resolve-binary.js';

/** Manage qmd index lifecycle operations */
export class IndexLifecycleManager {
  constructor(private readonly executor: QmdExecutor) {}

  /** Update the qmd index (re-index all collections) */
  async update(): Promise<Result<void, QmdError>> {
    const result = await this.executor.execute(['update']);
    if (result.exitCode === QMD_NOT_FOUND_EXIT_CODE) {
      // No qmd binary at all: surface the executor's actionable message
      // (what was searched, how to fix) rather than an opaque "Failed to update".
      return {
        ok: false,
        error: { code: 'not_available', message: result.stderr, command: 'qmd update' },
      };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: 'command_failed',
          message: 'Failed to update index',
          command: 'qmd update',
          stderr: result.stderr,
        },
      };
    }
    return { ok: true, value: undefined };
  }

  /** Generate/refresh vector embeddings */
  async embed(force = false): Promise<Result<void, QmdError>> {
    const args = force ? ['embed', '-f'] : ['embed'];
    const result = await this.executor.execute(args);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: 'command_failed',
          message: 'Failed to generate embeddings',
          command: `qmd embed${force ? ' -f' : ''}`,
          stderr: result.stderr,
        },
      };
    }
    return { ok: true, value: undefined };
  }

  /** Clean up caches and vacuum the database */
  async cleanup(): Promise<Result<void, QmdError>> {
    const result = await this.executor.execute(['cleanup']);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: 'command_failed',
          message: 'Failed to cleanup index',
          command: 'qmd cleanup',
          stderr: result.stderr,
        },
      };
    }
    return { ok: true, value: undefined };
  }

  /** Get index status */
  async status(): Promise<Result<string, QmdError>> {
    const result = await this.executor.execute(['status']);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: 'command_failed',
          message: 'Failed to get index status',
          command: 'qmd status',
          stderr: result.stderr,
        },
      };
    }
    return { ok: true, value: result.stdout };
  }
}
