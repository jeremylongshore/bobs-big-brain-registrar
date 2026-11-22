import { isAudienceVisibleToRole, isSearchVisibleSensitivity } from '@qmd-team-intent-kb/common';
import type { ReaderRole } from '@qmd-team-intent-kb/common';
import { Uuid } from '@qmd-team-intent-kb/schema';
import type { CuratedMemory, SearchScope } from '@qmd-team-intent-kb/schema';
import type { MemoryRepository } from './repositories/memory-repository.js';

export interface IndexedSearchLocator {
  file: string;
  score: number;
}
export interface CurrentSearchHit {
  file: string;
  collection: string;
  snippet: string;
  score: number;
  memory: CuratedMemory;
}
export interface CurrentSearchScope {
  tenantId?: string;
  readerRole: ReaderRole;
  scope: SearchScope;
}

/** Mirrors the export layout; the current row, never a cached label, owns scope. */
function currentCollection(memory: CuratedMemory): string {
  if (memory.lifecycle !== 'active') return 'kb-archive';
  if (memory.source === 'bulk_import') return 'kb-bulk';
  if (memory.category === 'decision') return 'kb-decisions';
  if (['reference', 'troubleshooting', 'onboarding'].includes(memory.category)) return 'kb-guides';
  return 'kb-curated';
}
function inScope(collection: string, scope: SearchScope): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'curated':
      return ['kb-curated', 'kb-decisions', 'kb-guides'].includes(collection);
    case 'archived':
      return collection === 'kb-archive';
    case 'bulk':
      return collection === 'kb-bulk';
    default:
      return false;
  }
}

/**
 * Index results are locators, not content or access authority. Read one SQLite
 * snapshot and project only current, schema-validated, authorized rows. Unknown
 * legacy filenames and any store failure yield no indexed content. No writes.
 */
export function readCurrentSearchHits(
  repo: MemoryRepository,
  hits: readonly IndexedSearchLocator[],
  scope: CurrentSearchScope,
): CurrentSearchHit[] {
  try {
    return repo.connection
      .transaction(() => {
        const visible: CurrentSearchHit[] = [];
        const seen = new Set<string>();
        for (const hit of hits) {
          const match = /^qmd:\/\/kb-(?:curated|decisions|guides|archive|bulk)\/([^/]+)\.md$/.exec(
            hit.file,
          );
          const id = Uuid.safeParse(match?.[1]);
          if (!id.success || !Number.isFinite(hit.score) || seen.has(id.data)) continue;
          const memory = repo.findById(id.data);
          if (
            memory === null ||
            (scope.tenantId !== undefined && memory.tenantId !== scope.tenantId) ||
            !isAudienceVisibleToRole(memory.metadata.audience, scope.readerRole) ||
            !isSearchVisibleSensitivity(memory.sensitivity)
          )
            continue;
          const collection = currentCollection(memory);
          if (!inScope(collection, scope.scope)) continue;
          seen.add(memory.id);
          visible.push({
            file: `qmd://${collection}/${memory.id}.md`,
            collection,
            snippet: memory.content.slice(0, 200),
            score: hit.score,
            memory,
          });
        }
        return visible;
      })
      .deferred();
  } catch {
    // Never echo storage errors or fall back to unverified cached text.
    return [];
  }
}
