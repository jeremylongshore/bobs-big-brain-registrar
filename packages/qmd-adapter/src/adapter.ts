import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Result } from '@qmd-team-intent-kb/common';
import type { SearchScope } from '@qmd-team-intent-kb/schema';
import type { QmdError, QmdHealthStatus, QmdSearchResult } from './types.js';
import type { QmdExecutor } from './executor/executor.js';
import type { QmdAdapterConfig } from './config.js';
import { RealQmdExecutor } from './executor/real-executor.js';
import { CollectionManager } from './collections/collection-manager.js';
import { getExportableCollections } from './collections/collection-registry.js';
import { SearchClient } from './search/search-client.js';
import { IndexLifecycleManager } from './index-manager/index-lifecycle.js';
import { checkHealth } from './health/health-check.js';
import { getQmdTenantEnv } from './config.js';

/** Facade class composing all qmd adapter managers */
export class QmdAdapter {
  readonly executor: QmdExecutor;
  readonly collections: CollectionManager;
  readonly search: SearchClient;
  readonly indexLifecycle: IndexLifecycleManager;
  private readonly exportDir: string;

  constructor(config: QmdAdapterConfig, executor?: QmdExecutor) {
    this.exportDir = config.exportDir;
    this.executor =
      executor ??
      new RealQmdExecutor({
        binary: config.qmdBinary,
        timeout: config.timeout,
        // Per-tenant isolation via XDG_* env, not the nonexistent --data-dir.
        env: getQmdTenantEnv(config.tenantId),
      });
    this.collections = new CollectionManager(this.executor);
    this.search = new SearchClient(this.executor);
    this.indexLifecycle = new IndexLifecycleManager(this.executor);
  }

  /** Run a search with curated-only default scope */
  async query(
    queryText: string,
    scope?: SearchScope,
  ): Promise<Result<QmdSearchResult[], QmdError>> {
    return this.search.search(queryText, scope);
  }

  /** Check health of qmd and index state */
  async health(): Promise<QmdHealthStatus> {
    return checkHealth(this.executor);
  }

  /** Update the index */
  async update(): Promise<Result<void, QmdError>> {
    return this.indexLifecycle.update();
  }

  /**
   * Ensure all exportable collections are registered against the git-exporter
   * output tree. Creates each collection's source subdir first so empty
   * categories (e.g. no archived memories yet) still register cleanly —
   * `qmd collection add` against a missing dir would fail.
   */
  async ensureCollections(): Promise<Result<string[], QmdError>> {
    for (const def of getExportableCollections()) {
      mkdirSync(join(this.exportDir, def.sourceSubdir), { recursive: true });
    }
    return this.collections.ensureCollections(this.exportDir);
  }
}
