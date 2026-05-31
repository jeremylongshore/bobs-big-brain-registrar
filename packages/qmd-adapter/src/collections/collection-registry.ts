/** Definition of a known collection */
export interface CollectionDef {
  name: string;
  description: string;
  includeInDefaultSearch: boolean;
  /**
   * Subdirectory under the git-exporter output dir that this collection's
   * source markdown lives in, or `null` if the collection has no exported
   * source (e.g. `kb-inbox` — unreviewed candidates stay in SQLite pre-
   * governance and are never written to the export tree).
   *
   * These subdir names are the git-exporter output contract — they MUST stay
   * in lock-step with `getCategoryDirectory` / `getDirectory` in
   * `apps/git-exporter/src/formatter/directory-mapper.ts`. The qmd-adapter
   * registers each collection's source at `<exportDir>/<sourceSubdir>` so
   * `qmd update` indexes the files git-exporter actually writes. See ADR
   * `000-docs/037-AT-DSGN-qmd-adapter-source-index-separation.md`.
   */
  sourceSubdir: string | null;
}

/** The 5 known collections with their default search inclusion */
export const KNOWN_COLLECTIONS: CollectionDef[] = [
  {
    name: 'kb-curated',
    description: 'Curated, governance-approved team knowledge',
    includeInDefaultSearch: true,
    sourceSubdir: 'curated',
  },
  {
    name: 'kb-decisions',
    description: 'Architectural and design decisions',
    includeInDefaultSearch: true,
    sourceSubdir: 'decisions',
  },
  {
    name: 'kb-guides',
    description: 'How-to guides and onboarding documentation',
    includeInDefaultSearch: true,
    sourceSubdir: 'guides',
  },
  {
    name: 'kb-inbox',
    description: 'Unreviewed memory candidates awaiting governance',
    includeInDefaultSearch: false,
    sourceSubdir: null,
  },
  {
    name: 'kb-archive',
    description: 'Deprecated, superseded, or archived memories',
    includeInDefaultSearch: false,
    sourceSubdir: 'archive',
  },
];

/** Get collection names included in default (curated) search */
export function getDefaultSearchCollections(): string[] {
  return KNOWN_COLLECTIONS.filter((c) => c.includeInDefaultSearch).map((c) => c.name);
}

/** Get all known collection names */
export function getAllCollectionNames(): string[] {
  return KNOWN_COLLECTIONS.map((c) => c.name);
}

/** A collection that has a non-null exported source subdirectory. */
export type ExportableCollectionDef = CollectionDef & { sourceSubdir: string };

/**
 * Get the collections that have an exported source directory, i.e. those the
 * qmd-adapter can register against the git-exporter output tree. Excludes
 * collections with a null `sourceSubdir` (e.g. `kb-inbox`).
 */
export function getExportableCollections(): ExportableCollectionDef[] {
  return KNOWN_COLLECTIONS.filter((c): c is ExportableCollectionDef => c.sourceSubdir !== null);
}

/** Check if a collection name is known */
export function isKnownCollection(name: string): boolean {
  return KNOWN_COLLECTIONS.some((c) => c.name === name);
}

/** Check if a collection is included in default search */
export function isDefaultSearchCollection(name: string): boolean {
  return KNOWN_COLLECTIONS.some((c) => c.name === name && c.includeInDefaultSearch);
}
