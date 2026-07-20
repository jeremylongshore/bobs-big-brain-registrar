/**
 * @qmd-team-intent-kb/test-fixtures
 *
 * Shared deterministic factory functions for test suites across the monorepo.
 * Import from this package instead of duplicating factory logic in each
 * package's local `__tests__/fixtures.ts`.
 *
 * @example
 * ```ts
 * import { makeCandidate, makeMemory, makePolicy, makeAuditEvent, FIXED_NOW } from '@qmd-team-intent-kb/test-fixtures';
 * ```
 */

export { FIXED_NOW, DEFAULT_TENANT, HASH_A, HASH_B, DEFAULT_CONTENT } from './constants.js';
export { makeCandidate, makeCandidateWithHash, makeAttestedCandidate } from './make-candidate.js';
export { makeMemory } from './make-memory.js';
export { makePolicy } from './make-policy.js';
export { makeAuditEvent } from './make-audit-event.js';
