import type { Result } from '@qmd-team-intent-kb/common';
import type { SearchScope } from '@qmd-team-intent-kb/schema';
import type { QmdError, QmdSearchResult } from '../types.js';
import type { QmdExecutor } from '../executor/executor.js';
import { getDefaultSearchCollections } from '../collections/collection-registry.js';
import { parseQueryOutput } from './result-parser.js';

/** Search client with curated-only default scope enforcement */
export class SearchClient {
  constructor(private readonly executor: QmdExecutor) {}

  /** Execute a search query, enforcing curated-only scope by default */
  async search(
    query: string,
    scope: SearchScope = 'curated',
  ): Promise<Result<QmdSearchResult[], QmdError>> {
    const collections = this.resolveCollections(scope);

    // `--json` gives machine-parseable output (qmd's default output is a
    // human-readable block). `--` terminates option parsing so a query like
    // '--version' is treated as a search term, not a flag.
    const args = ['search', '--json', '--', query];
    const result = await this.executor.execute(args);

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: 'command_failed',
          message: `Search failed for query "${query}"`,
          command: `qmd search ${query}`,
          stderr: result.stderr,
        },
      };
    }

    const parsed = parseQueryOutput(result.stdout);
    // Filter to only allowed collections based on scope
    const filtered =
      scope === 'all' ? parsed : parsed.filter((r) => collections.includes(r.collection));

    return { ok: true, value: filtered };
  }

  /** Resolve which collections to include based on scope */
  private resolveCollections(scope: SearchScope): string[] {
    return resolveScopeCollections(scope);
  }
}

/**
 * Map a search scope to the collections it may return (empty = no filter).
 * Shared by the qmd path and the native FTS5 fusion path so both halves of a
 * fused result honour the same scope contract.
 */
export function resolveScopeCollections(scope: SearchScope): string[] {
  switch (scope) {
    case 'curated':
      return getDefaultSearchCollections();
    case 'inbox':
      return ['kb-inbox'];
    case 'archived':
      return ['kb-archive'];
    case 'all':
      return []; // No filtering
    default:
      return getDefaultSearchCollections();
  }
}
