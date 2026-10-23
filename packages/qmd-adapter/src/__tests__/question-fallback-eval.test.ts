import { describe, expect, it } from 'vitest';
import { Fts5Backend } from '../native/fts5-backend.js';
import { runEval } from '../eval/run-eval.js';
import {
  QUESTION_FALLBACK_V1_CORPUS,
  QUESTION_FALLBACK_V1_DATASET,
  QUESTION_FALLBACK_V1_BASELINE,
} from '../eval/datasets/question-fallback-v1.js';
import {
  STRICT_SCOPED_V1_CORPUS,
  STRICT_SCOPED_V1_DATASET,
  STRICT_SCOPED_V1_BASELINE,
} from '../eval/datasets/strict-scoped-v1.js';

describe('question-fallback-v1 synthetic retrieval baseline', () => {
  it('measures coverage recovery and retains the synonym miss without changing historical labels', async () => {
    const backend = new Fts5Backend();
    try {
      backend.index(QUESTION_FALLBACK_V1_CORPUS);
      const strict = await runEval(
        QUESTION_FALLBACK_V1_DATASET,
        async (query, k) => backend.search(query, k, ['kb-curated']).map((hit) => hit.id),
        { k: 10 },
      );
      const fallback = await runEval(
        QUESTION_FALLBACK_V1_DATASET,
        async (query, k) =>
          backend.searchQuestionFallback(query, k, ['kb-curated']).map((hit) => hit.id),
        { k: 10 },
      );
      expect(strict.meanRecallAtK).toBe(QUESTION_FALLBACK_V1_BASELINE.strictRecallAtK);
      expect(fallback.meanRecallAtK).toBeCloseTo(
        QUESTION_FALLBACK_V1_BASELINE.fallbackRecallAtK,
        12,
      );
      expect(fallback.meanNdcgAtK).toBeCloseTo(QUESTION_FALLBACK_V1_BASELINE.fallbackNdcgAtK, 12);
      expect(fallback.meanFamaAtK).toBeCloseTo(QUESTION_FALLBACK_V1_BASELINE.fallbackFamaAtK, 12);
      expect(fallback.perQuery.map((query) => query.retrieved)).toEqual([
        ['tokens'],
        ['alerts'],
        ['deployment'],
        ['backups'],
        ['cache'],
        [],
      ]);
    } finally {
      backend.close();
    }
  });
});

describe('strict-scoped-v1 synthetic retrieval baseline', () => {
  it('contrasts legacy global cutoff then filtering with scope before the strict cutoff', async () => {
    const backend = new Fts5Backend();
    try {
      backend.index(STRICT_SCOPED_V1_CORPUS);
      // Reproduce the previous NativeIndexManager order of operations.
      expect(backend.search('tokens', 1).map((hit) => hit.id)).toEqual(['archive']);
      const legacy = await runEval(
        STRICT_SCOPED_V1_DATASET,
        async (query, k) =>
          backend
            .search(query, k)
            .filter((hit) => hit.collection === 'kb-curated')
            .map((hit) => hit.id),
        { k: 1 },
      );
      const scoped = await runEval(
        STRICT_SCOPED_V1_DATASET,
        async (query, k) => backend.search(query, k, ['kb-curated']).map((hit) => hit.id),
        { k: 1 },
      );
      expect(legacy.meanRecallAtK).toBe(STRICT_SCOPED_V1_BASELINE.legacyRecallAtK);
      expect(scoped.meanRecallAtK).toBe(STRICT_SCOPED_V1_BASELINE.scopedRecallAtK);
      expect(scoped.meanNdcgAtK).toBe(STRICT_SCOPED_V1_BASELINE.scopedNdcgAtK);
      expect(scoped.meanFamaAtK).toBe(STRICT_SCOPED_V1_BASELINE.scopedFamaAtK);
      expect(legacy.perQuery[0]!.retrieved).toEqual([]);
      expect(scoped.perQuery[0]!.retrieved).toEqual(['current-guide']);
    } finally {
      backend.close();
    }
  });
});
