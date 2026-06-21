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
  /** The single tenant this adapter's qmd registry + index are bound to. */
  private readonly tenantId: string;

  constructor(config: QmdAdapterConfig, executor?: QmdExecutor) {
    this.exportDir = config.exportDir;
    this.tenantId = config.tenantId;
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

  /**
   * Run a search with curated-only default scope.
   *
   * This adapter instance is bound to a single tenant at construction (its qmd
   * registry + index are XDG-isolated to `config.tenantId`). The requested
   * tenant MUST equal the bound tenant for the index to be served; anything
   * else (a different tenant OR an unscoped/omitted tenant) returns an empty
   * result rather than serving the bound tenant's index unlabelled.
   *
   * The guard is fail-closed and NOT inert when tenantId is undefined (c5k.2):
   * the prior `tenantId !== undefined && tenantId !== this.tenantId` form
   * short-circuited the whole check on `undefined`, so an unscoped call fell
   * through to `this.search.search()` with no tenant assertion at all — the
   * exact path the API-layer omission bug fed. The API tenancy guard now
   * resolves the effective tenant from the token before the service calls
   * `query()`, so every legitimate call arrives with a defined, matching
   * tenantId; a missing tenantId is a contract violation and is refused here
   * as the last line of defense rather than served.
   */
  async query(
    queryText: string,
    scope?: SearchScope,
    tenantId?: string,
  ): Promise<Result<QmdSearchResult[], QmdError>> {
    if (tenantId !== this.tenantId) {
      // Requested tenant is undefined or not the one this adapter serves —
      // refuse rather than serve the bound tenant's index unscoped/mislabelled.
      return { ok: true, value: [] };
    }
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
