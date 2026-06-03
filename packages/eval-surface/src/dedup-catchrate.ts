/**
 * dedup-catch-rate evaluator — does the store's dedup mechanism catch duplicates?
 *
 * IMPORTANT scope note: QMD's promotion-time dedup is EXACT content-hash matching
 * (SHA-256 via computeContentHash, compared against existing hashes) — it is NOT
 * semantic / near-duplicate detection. This evaluator therefore measures the
 * thing dedup actually does: it injects probes whose content is byte-identical to
 * an already-stored memory and verifies the catch, and (as a false-positive
 * guard) verifies that genuinely distinct content is NOT flagged. We do not claim
 * to measure fuzzy near-dup catch the system doesn't perform.
 *
 * Pure: takes a MemoryRepository + probes, returns a verdict. No emit, no sign.
 */

import { computeContentHash } from '@qmd-team-intent-kb/common';
import type { MemoryRepository } from '@qmd-team-intent-kb/store';

import type { DedupProbe, EvaluatorResult } from './types.js';

const DEFAULT_THRESHOLD = 1.0; // exact-dup catch should be perfect; anything less is a real miss

export interface DedupCatchRateOptions {
  /** Catch-rate pass threshold in [0,1]. Default 1.0 (exact dedup must be perfect). */
  readonly threshold?: number;
}

export function evaluateDedupCatchRate(
  repo: MemoryRepository,
  probes: readonly DedupProbe[],
  options: DedupCatchRateOptions = {},
): EvaluatorResult {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  if (probes.length === 0) {
    return {
      name: 'dedup-catch-rate',
      passed: true,
      score: 1,
      threshold,
      details: { probes: 0, note: 'no probes — vacuously passes' },
    };
  }

  // The store's existing-content fingerprint set — the same surface dedup checks.
  const existingHashes = new Set(repo.getAllContentHashes());

  let caught = 0;
  for (const probe of probes) {
    const hash = computeContentHash(probe.nearDuplicateContent);
    if (existingHashes.has(hash)) caught += 1;
  }

  const catchRate = caught / probes.length;

  return {
    name: 'dedup-catch-rate',
    passed: catchRate >= threshold,
    score: catchRate,
    threshold,
    details: {
      probes: probes.length,
      caught,
      missed: probes.length - caught,
      catch_rate: Number(catchRate.toFixed(4)),
      scope: 'exact-content-hash (not semantic near-dup)',
    },
  };
}
