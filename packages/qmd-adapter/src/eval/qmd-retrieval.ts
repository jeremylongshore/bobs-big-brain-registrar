import type { SearchScope } from '@qmd-team-intent-kb/schema';
import type { QmdAdapter } from '../adapter.js';
import type { RetrievalFn } from './eval-types.js';

/**
 * Adapt a live {@link QmdAdapter} to the eval harness's {@link RetrievalFn}
 * (bead compile-then-govern-e06.4 / umbrella #27).
 *
 * This is the ONE honest retrieval path: it drives the exact same
 * `adapter.query()` the MCP `brain_search` tool uses in production — scope
 * enforcement, tenant guard, qmd `search --json`, and `qmd://` citation parsing
 * all included — and returns the ranked `qmd://` citation ids (the `.file`
 * field). Because it is the production path, the number the harness computes is
 * the number `brain_search` actually delivers, not a re-implementation of it.
 *
 * `scope` defaults to `'curated'` (curated + decisions + guides — the default
 * search surface); pass `'all'` to include inbox/archive. `tenantId` MUST match
 * the tenant the adapter is bound to, or the adapter's fail-closed guard returns
 * an empty list.
 */
export function qmdRetrievalFn(
  adapter: QmdAdapter,
  tenantId: string,
  scope: SearchScope = 'curated',
): RetrievalFn {
  return async (query: string, _k: number): Promise<string[]> => {
    const result = await adapter.query(query, scope, tenantId);
    if (!result.ok) return [];
    // qmd already returns hits ranked best-first; the harness applies the top-k
    // cutoff itself, so we hand back the full ranked citation list.
    return result.value.map((hit) => hit.file);
  };
}
