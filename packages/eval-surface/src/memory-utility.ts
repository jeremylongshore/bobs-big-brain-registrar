/**
 * memory-utility evaluator — does the curated store actually retrieve the right
 * memories for a query?
 *
 * For each probe (query + the memory ids that should surface), we run the store's
 * real text search and measure recall@k: of the expected memories, how many
 * appear in the top-k results. The aggregate score is mean recall across probes;
 * the verdict passes iff mean recall >= threshold.
 *
 * Pure: takes a MemoryRepository and probes, returns a verdict. No emit, no sign.
 */

import type { MemoryRepository } from '@qmd-team-intent-kb/store';

import type { EvaluatorResult, RetrievalProbe } from './types.js';

const DEFAULT_K = 5;
const DEFAULT_THRESHOLD = 0.8;

export interface MemoryUtilityOptions {
  /** Mean-recall pass threshold in [0,1]. Default 0.8. */
  readonly threshold?: number;
}

export function evaluateMemoryUtility(
  repo: MemoryRepository,
  probes: readonly RetrievalProbe[],
  options: MemoryUtilityOptions = {},
): EvaluatorResult {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  if (probes.length === 0) {
    return {
      name: 'memory-utility',
      passed: true,
      score: 1,
      threshold,
      details: { probes: 0, note: 'no probes — vacuously passes' },
    };
  }

  let recallSum = 0;
  let probesWithExpectations = 0;

  for (const probe of probes) {
    const k = probe.k ?? DEFAULT_K;
    if (probe.expectedMemoryIds.length === 0) continue;
    probesWithExpectations += 1;

    const hits = repo.searchByText(probe.query, probe.tenantId);
    const topKIds = new Set(hits.slice(0, k).map((m) => m.id));
    const found = probe.expectedMemoryIds.filter((id) => topKIds.has(id)).length;
    recallSum += found / probe.expectedMemoryIds.length;
  }

  const meanRecall = probesWithExpectations === 0 ? 1 : recallSum / probesWithExpectations;

  return {
    name: 'memory-utility',
    passed: meanRecall >= threshold,
    score: meanRecall,
    threshold,
    details: {
      probes: probes.length,
      probes_scored: probesWithExpectations,
      mean_recall_at_k: Number(meanRecall.toFixed(4)),
    },
  };
}
