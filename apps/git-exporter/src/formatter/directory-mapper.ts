import type { CuratedMemory } from '@qmd-team-intent-kb/schema';

/**
 * Thrown when a category has no export-directory mapping (5bm.5). A memory that
 * reaches the exporter with an off-vocabulary category is schema drift or a
 * bypassed write path — failing loud is correct, because the previous silent
 * fallback filed it under `curated/` (the governance-approved, default-searched
 * collection), laundering an unknown value into the most-trusted bucket.
 */
export class UnknownCategoryError extends Error {
  constructor(readonly category: string) {
    super(`No export-directory mapping for category "${category}"`);
    this.name = 'UnknownCategoryError';
  }
}

/**
 * Resolve the export subdirectory for a memory.
 *
 * Lifecycle takes precedence over everything:
 * - `archived` or `superseded` → `archive/`
 *
 * Source takes precedence over category (active / deprecated):
 * - `bulk_import` → `bulk/` (5bm.8 — a whole-machine digestion routes to the
 *   non-default `kb-bulk` collection so it cannot flood the default search
 *   surface, regardless of what category the compiler assigned it)
 *
 * Category mapping (active / deprecated, non-bulk):
 * - `decision`                                → `decisions/`
 * - `pattern`, `convention`, `architecture`  → `curated/`
 * - `troubleshooting`, `reference`, `onboarding` → `guides/`
 * - unknown                                   → throws {@link UnknownCategoryError}
 */
export function getDirectory(memory: CuratedMemory): string {
  if (memory.lifecycle === 'archived' || memory.lifecycle === 'superseded') {
    return 'archive';
  }
  return getActiveDirectory(memory);
}

/**
 * The directory a memory occupies while active/deprecated — i.e. ignoring the
 * lifecycle→archive override. Bulk-imported memories live in `bulk/` (5bm.8);
 * everything else lives in its category directory. The change-detector also
 * uses this to compute the FROM path when archiving, so a bulk memory is moved
 * out of `bulk/`, not looked for in its category directory.
 */
export function getActiveDirectory(memory: Pick<CuratedMemory, 'source' | 'category'>): string {
  if (memory.source === 'bulk_import') {
    return 'bulk';
  }
  return getCategoryDirectory(memory.category);
}

/**
 * Map a category to its export subdirectory name. Does not consider lifecycle —
 * use {@link getDirectory} for that. FAIL-CLOSED: an unmapped category throws
 * {@link UnknownCategoryError} rather than silently landing in `curated/`.
 */
export function getCategoryDirectory(category: string): string {
  switch (category) {
    case 'decision':
      return 'decisions';
    case 'pattern':
    case 'convention':
    case 'architecture':
      return 'curated';
    case 'troubleshooting':
    case 'reference':
    case 'onboarding':
      return 'guides';
    default:
      throw new UnknownCategoryError(category);
  }
}

/**
 * Get the full relative path for a memory file within the export directory.
 * Format: `{directory}/{id}.md`
 */
export function getRelativePath(memory: CuratedMemory): string {
  return `${getDirectory(memory)}/${memory.id}.md`;
}
