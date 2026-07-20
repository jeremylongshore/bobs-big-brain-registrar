import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import {
  DEFAULT_BRAINIGNORE_RULESET,
  evaluateBrainignore,
  type BrainignoreMatch,
  type BrainignoreRuleset,
} from './brainignore.js';

/**
 * Import exclusion gate (bead qmd-team-intent-kb-5kw.1) — the intake-time
 * check that an IMPORT-SOURCE candidate does not match the brainignore
 * exclusion ruleset (vendored paths, lockfiles, boilerplate names, minified /
 * generated / license-boilerplate content).
 *
 * STRUCTURAL, not policy-configured — the same shape as the origin
 * attestation gate (`origin/origin-gate.ts`, GSB Wave-2 H1 / PR #302): it
 * runs on every govern path that processes candidates, regardless of tenant
 * policy. Making it a `governance_policies.rules_json` rule would leave it
 * dormant on every pre-5kw policy — the exact silent-dormancy failure the
 * 2026-07-16 digestion exposed (recommended-policy.ts tells that story).
 * Configurability lives in the RULESET (committed defaults + the per-brain
 * override file), not in policy plumbing.
 *
 * Scope: ONLY candidates with source `import` or `bulk_import`. A
 * `claude_session` / `manual` / `mcp` candidate is never brainignore-checked —
 * a human or session deliberately capturing a note about node_modules
 * internals is knowledge, not vendored junk; only bulk import lacks that
 * per-item human intent.
 *
 * Rejections are POLICY-PIPELINE-SHAPED (`PipelineResult` with
 * `outcome:'rejected'`) so they flow through the existing receipted rejection
 * path (`reject()` → audit event), never a crash. The receipt carries the
 * stable code in `rejectedBy` and the deterministic evidence (matched
 * pattern + path, or measured heuristic values) in the evaluation reason.
 */

/** `ruleType` stamped on import-exclusion rule results (a structural pseudo-rule). */
export const IMPORT_EXCLUSION_RULE_TYPE = 'import_exclusion';

/** Candidate sources the gate applies to. */
const IMPORT_SOURCES: ReadonlySet<MemoryCandidate['source']> = new Set(['import', 'bulk_import']);

/** Outcome of the import exclusion gate for one candidate. */
export type ImportExclusionResult =
  /** Candidate is not import-sourced — the gate does not apply. */
  | { verdict: 'not_applicable' }
  /** Import-sourced and matched no exclusion rule. */
  | { verdict: 'clear' }
  /** Matched an exclusion rule — receipted rejection. */
  | { verdict: 'rejected'; match: BrainignoreMatch; pipelineResult: PipelineResult };

/**
 * Evaluate the import exclusion gate for a candidate. Pure — no I/O; the
 * caller resolves the ruleset (defaults, or defaults + the per-brain override
 * file via `loadBrainignoreRuleset`). Omitting `ruleset` applies the
 * committed defaults, so every govern path is protected without wiring.
 */
export function checkImportExclusion(
  candidate: MemoryCandidate,
  ruleset: BrainignoreRuleset = DEFAULT_BRAINIGNORE_RULESET,
): ImportExclusionResult {
  if (!IMPORT_SOURCES.has(candidate.source)) {
    return { verdict: 'not_applicable' };
  }

  const match = evaluateBrainignore(
    candidate.metadata.filePaths,
    candidate.content,
    candidate.title,
    ruleset,
  );
  if (match === null) {
    return { verdict: 'clear' };
  }

  return {
    verdict: 'rejected',
    match,
    pipelineResult: {
      candidateId: candidate.id,
      outcome: 'rejected',
      evaluations: [
        {
          ruleId: match.code,
          ruleType: IMPORT_EXCLUSION_RULE_TYPE,
          outcome: 'fail',
          reason: `Import exclusion (brainignore): ${match.evidence}`,
        },
      ],
      rejectedBy: match.code,
    },
  };
}
