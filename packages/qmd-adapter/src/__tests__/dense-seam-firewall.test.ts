import { describe, expect, it } from 'vitest';

import type { DeterministicScore } from '@qmd-team-intent-kb/policy-engine';

import { denseScore, type DenseScore } from '../dense/embed-client.js';
import { rerankScore, type RerankScore } from '../rerank/rerank-client.js';

/**
 * Seam firewall, retrieval side (blueprint B4 extending B1/B2's proof).
 *
 * B2 proved a RAW number cannot become a govern `DeterministicScore`; B1
 * proved it for the cross-encoder `RerankScore`. B4 introduces the second
 * model-derived score in the codebase — the embedding-similarity `DenseScore`
 * — so this file proves that concrete type cannot cross the seam either, in
 * both directions, and that the two retrieval-side model brands do not
 * silently unify with each other. The @ts-expect-error directives are
 * enforced by tsc: if any two of these brands ever became mutually
 * assignable, the directives would flag as unused and fail typecheck.
 *
 * This test lives in qmd-adapter (retrieval) importing the govern TYPE,
 * because the import barrier (`no-govern-imports-retrieval` in
 * .dependency-cruiser.cjs) forbids the reverse: policy-engine may never
 * import this package, so the cross-package proof must sit on this side of
 * the seam. Note also that policy-engine's package surface exports only the
 * TYPE — the `deterministicScore()` factory is not exported, so retrieval
 * code cannot mint a govern score even deliberately.
 */
describe('seam firewall: DenseScore cannot cross into govern (B4)', () => {
  it('a DenseScore is NOT assignable to a govern DeterministicScore', () => {
    const modelScore: DenseScore = denseScore(0.87);
    // @ts-expect-error a model-derived embedding similarity can never become a govern score
    const forbidden: DeterministicScore = modelScore;
    void forbidden;
  });

  it('a govern DeterministicScore is NOT assignable to a DenseScore (brands are distinct, not aliases)', () => {
    const governScore = 0.5 as DeterministicScore; // cast stands in for the unexported factory
    // @ts-expect-error the brands are nominal — govern and retrieval scores never unify
    const forbidden: DenseScore = governScore;
    void forbidden;
  });

  it('a raw number is NOT assignable to a DenseScore without the dense-side factory', () => {
    const raw = 0.42;
    // @ts-expect-error raw numbers must be branded through denseScore()
    const forbidden: DenseScore = raw;
    void forbidden;
  });

  it('the two retrieval-side model brands do not unify with each other either', () => {
    const dense: DenseScore = denseScore(0.7);
    const rerank: RerankScore = rerankScore(0.7);
    // @ts-expect-error a dense similarity is not a cross-encoder relevance score
    const forbiddenA: RerankScore = dense;
    // @ts-expect-error a cross-encoder relevance score is not a dense similarity
    const forbiddenB: DenseScore = rerank;
    void forbiddenA;
    void forbiddenB;
  });

  it('a DenseScore still reads transparently as a number on the read path', () => {
    const s = denseScore(0.75);
    expect(s).toBeCloseTo(0.75);
    expect(s > 0.5).toBe(true); // ordering comparisons work — that is its whole job
  });
});
