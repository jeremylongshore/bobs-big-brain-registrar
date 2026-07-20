/**
 * Curator test fixtures.
 *
 * Shared factories are re-exported from @qmd-team-intent-kb/test-fixtures.
 * makeCuratedMemory is an alias for makeMemory, kept for backward compatibility
 * with existing curator test imports.
 */
export {
  makeCandidate,
  makeAttestedCandidate,
  makeMemory,
  makeMemory as makeCuratedMemory,
  makePolicy,
  FIXED_NOW as NOW,
  DEFAULT_TENANT as TENANT,
} from '@qmd-team-intent-kb/test-fixtures';
