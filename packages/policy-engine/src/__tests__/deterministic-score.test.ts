import { describe, it, expect } from 'vitest';
import { deterministicScore, type DeterministicScore } from '../deterministic-score.js';
import type { RuleResult } from '../types.js';

/**
 * Seam firewall (blueprint 019-PP-PLAN bead B2). These tests prove, at the type
 * level, that a retrieval-side score (a plain number, e.g. a cross-encoder rerank
 * output) cannot cross into a govern decision. The @ts-expect-error directives are
 * enforced by tsc (the typecheck / validate step): if a raw number ever became
 * assignable to a govern score, the directive would report an unused-directive error
 * and fail the build. Runtime expectations confirm the brand is transparent to reads.
 */
describe('seam firewall: DeterministicScore (B2)', () => {
  it('the factory mints a govern score that is usable as a number', () => {
    const s = deterministicScore(0.42);
    expect(s).toBeCloseTo(0.42);
    expect(s + 1).toBeCloseTo(1.42); // a branded score reads transparently as a number
  });

  it('a raw number (a rerank / embedding score) is NOT assignable to a govern score', () => {
    const rerankScore = 0.99; // a plain number: exactly what a cross-encoder produces above the spool
    // @ts-expect-error a raw number cannot become a DeterministicScore without the sanctioned factory
    const forbidden: DeterministicScore = rerankScore;
    void forbidden;
  });

  it('a raw number cannot be placed in RuleResult.score (the govern seam)', () => {
    const rerankScore = 0.99;
    const result: RuleResult = {
      ruleId: 'x',
      ruleType: 'relevance_score',
      outcome: 'pass',
      reason: 'test',
      // @ts-expect-error a govern RuleResult.score must be a DeterministicScore, not a raw model score
      score: rerankScore,
    };
    void result;
  });

  it('a factory-minted deterministic score IS accepted in RuleResult.score', () => {
    const result: RuleResult = {
      ruleId: 'x',
      ruleType: 'relevance_score',
      outcome: 'pass',
      reason: 'test',
      score: deterministicScore(0.5),
    };
    expect(result.score).toBeCloseTo(0.5);
  });
});
