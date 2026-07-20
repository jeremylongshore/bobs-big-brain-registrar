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
import { SearchClient, resolveScopeCollections } from './search/search-client.js';
import { fuseReciprocalRank } from './search/rrf-fusion.js';
import { IndexLifecycleManager } from './index-manager/index-lifecycle.js';
import { checkHealth } from './health/health-check.js';
import { getQmdTenantEnv, getQmdTenantIndexPath } from './config.js';
import { getNativeIndexManager, type NativeIndexManager } from './native/native-index-manager.js';
import type { Fts5SearchHit } from './native/fts5-backend.js';

/** How many native FTS5 hits to feed the fusion (pre scope-filter). */
const NATIVE_SEARCH_K = 50;

/** Facade class composing all qmd adapter managers */
export class QmdAdapter {
  readonly executor: QmdExecutor;
  readonly collections: CollectionManager;
  readonly search: SearchClient;
  readonly indexLifecycle: IndexLifecycleManager;
  private readonly native: NativeIndexManager | null;
  private readonly exportDir: string;
  /** The single tenant this adapter's qmd registry + index are bound to. */
  private readonly tenantId: string;
  /** Optional index-freshness probe (D2) — see QmdAdapterConfig.stalenessProbe. */
  private readonly stalenessProbe?: () => number | null;

  /** The tenant this adapter serves (read-only; used by the search canary's fail-closed guard). */
  get boundTenantId(): string {
    return this.tenantId;
  }

  constructor(config: QmdAdapterConfig, executor?: QmdExecutor) {
    this.exportDir = config.exportDir;
    this.tenantId = config.tenantId;
    this.stalenessProbe = config.stalenessProbe;
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
    // Native FTS5 fusion half (vps.2). Failure to open the index (read-only
    // fs, missing native dep) degrades to qmd-only search rather than
    // breaking the adapter.
    if (config.disableNativeFusion === true) {
      this.native = null;
    } else {
      try {
        this.native = getNativeIndexManager({
          exportDir: config.exportDir,
          indexPath:
            config.nativeIndexPath ??
            join(getQmdTenantIndexPath(config.tenantId), 'native-fts5.sqlite'),
        });
      } catch {
        this.native = null;
      }
    }
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

    // Two lexical backends, one deterministic fusion (vps.2): the external
    // qmd binary (keyword-AND tokenizer) and the native FTS5 index over the
    // same export tree (unicode61 tokenizer, catches hyphen/dot-joined terms
    // qmd misses). Their ranked lists join by qmd:// citation and fuse via
    // reciprocal-rank fusion. Either backend failing degrades to the other.
    const effectiveScope: SearchScope = scope ?? 'curated';
    const qmdResult = await this.search.search(queryText, effectiveScope);
    const nativeHits = this.nativeSearch(queryText, effectiveScope);

    if (!qmdResult.ok) {
      // qmd unavailable — native results alone still serve the query (this
      // also makes local search work when the qmd binary is not installed).
      if (nativeHits.length > 0) {
        return { ok: true, value: fuseReciprocalRank([], nativeHits) };
      }
      return qmdResult;
    }
    if (nativeHits.length === 0) return qmdResult;
    return { ok: true, value: fuseReciprocalRank(qmdResult.value, nativeHits) };
  }

  /** Native FTS5 half of the fused query. Any failure degrades to []. */
  private nativeSearch(queryText: string, scope: SearchScope): Fts5SearchHit[] {
    if (this.native === null) return [];
    try {
      return this.native.search(queryText, NATIVE_SEARCH_K, resolveScopeCollections(scope));
    } catch {
      return [];
    }
  }

  /** Check health of qmd and index state (incl. stalenessSeconds when a probe is wired). */
  async health(): Promise<QmdHealthStatus> {
    return checkHealth(this.executor, this.stalenessProbe);
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
