import type { Result } from '@qmd-team-intent-kb/common';
import type { QmdError } from '../types.js';
import type { QmdExecutor } from '../executor/executor.js';
import { describeQmdFailure } from '../executor/describe-failure.js';

/** Manage qmd index lifecycle operations */
export class IndexLifecycleManager {
  constructor(private readonly executor: QmdExecutor) {}

  /** Update the qmd index (re-index all collections) */
  async update(): Promise<Result<void, QmdError>> {
    const args = ['update'];
    const result = await this.executor.execute(args);
    if (result.exitCode !== 0) {
      // Timeout vs non-zero exit vs missing binary are different operator
      // actions — never one opaque "Failed to update index" (39z.20).
      return { ok: false, error: describeQmdFailure(args, result) };
    }
    return { ok: true, value: undefined };
  }

  /** Generate/refresh vector embeddings */
  async embed(force = false): Promise<Result<void, QmdError>> {
    const args = force ? ['embed', '-f'] : ['embed'];
    const result = await this.executor.execute(args);
    if (result.exitCode !== 0) {
      return { ok: false, error: describeQmdFailure(args, result) };
    }
    return { ok: true, value: undefined };
  }

  /** Clean up caches and vacuum the database */
  async cleanup(): Promise<Result<void, QmdError>> {
    const args = ['cleanup'];
    const result = await this.executor.execute(args);
    if (result.exitCode !== 0) {
      return { ok: false, error: describeQmdFailure(args, result) };
    }
    return { ok: true, value: undefined };
  }

  /** Get index status */
  async status(): Promise<Result<string, QmdError>> {
    const args = ['status'];
    const result = await this.executor.execute(args);
    if (result.exitCode !== 0) {
      return { ok: false, error: describeQmdFailure(args, result) };
    }
    return { ok: true, value: result.stdout };
  }
}
