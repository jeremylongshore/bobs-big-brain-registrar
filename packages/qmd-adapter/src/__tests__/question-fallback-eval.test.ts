import { describe, expect, it } from 'vitest';
import { Fts5Backend } from '../native/fts5-backend.js';
import { runEval } from '../eval/run-eval.js';
import {
  QUESTION_FALLBACK_V1_CORPUS,
  QUESTION_FALLBACK_V1_DATASET,
  QUESTION_FALLBACK_V1_BASELINE,
} from '../eval/datasets/question-fallback-v1.js';

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
