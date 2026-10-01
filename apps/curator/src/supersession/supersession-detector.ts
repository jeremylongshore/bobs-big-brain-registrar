/**
 * Re-export shim — the supersession detector moved to
 * `@qmd-team-intent-kb/policy-engine` (Wave-2 C3) so the govern-decision eval
 * (a package) can score the REAL detector without a package→app import
 * (dependency-cruiser `no-package-depends-on-app`). Every curator call site and
 * the public `@qmd-team-intent-kb/curator` surface keep working unchanged; the
 * implementation is owned by the govern
 * package layer.
 */
export {
  detectSupersession,
  planSupersession,
  DEFAULT_MAX_SUPERSEDES_PER_PROMOTION,
  AUTHORITATIVE_CATEGORIES,
  computeTitleSimilarity,
  DEFAULT_SUPERSESSION_THRESHOLD,
} from '@qmd-team-intent-kb/policy-engine';
export type {
  SupersessionMatch,
  SupersessionPlan,
  SupersessionOptions,
  SupersessionBlock,
  SupersessionMemorySource,
} from '@qmd-team-intent-kb/policy-engine';
