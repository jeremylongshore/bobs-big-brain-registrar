import { describe, expect, it } from 'vitest';

import type { DeterministicScore } from '@qmd-team-intent-kb/policy-engine';

import { rerankScore, type RerankScore } from '../rerank/rerank-client.js';

/**
 * Seam firewall, retrieval side (blueprint B1 extending B2's proof).
 *
 * B2 proved a RAW number cannot become a govern `DeterministicScore`. B1
 * introduces the first actual model-derived score in the codebase — the
 * cross-encoder `RerankScore` — so this file proves the concrete type cannot
 * cross the seam either, in both directions. The @ts-expect-error directives
 * are enforced by tsc: if the two brands ever became mutually assignable, the
 * directives would flag as unused and fail typecheck.
 *
 * This test lives in qmd-adapter (retrieval) importing the govern TYPE,
 * because the import barrier (`no-govern-imports-retrieval` in
 * .dependency-cruiser.cjs) forbids the reverse: policy-engine may never import
 * this package, so the cross-package proof must sit on this side of the seam.
 * Note also that policy-engine's package surface exports only the TYPE — the
 * `deterministicScore()` factory is not exported, so retrieval code cannot
 * mint a govern score even deliberately.
 */
describe('seam firewall: RerankScore cannot cross into govern (B1)', () => {
  it('a RerankScore is NOT assignable to a govern DeterministicScore', () => {
    const modelScore: RerankScore = rerankScore(0.99);
    // @ts-expect-error a model-derived rerank score can never become a govern score
    const forbidden: DeterministicScore = modelScore;
    void forbidden;
  });

  it('a govern DeterministicScore is NOT assignable to a RerankScore (brands are distinct, not aliases)', () => {
    const governScore = 0.5 as DeterministicScore; // cast stands in for the unexported factory
    // @ts-expect-error the brands are nominal — govern and retrieval scores never unify
    const forbidden: RerankScore = governScore;
    void forbidden;
  });

  it('a raw number is NOT assignable to a RerankScore without the rerank-side factory', () => {
    const raw = 0.42;
    // @ts-expect-error raw numbers must be branded through rerankScore()
    const forbidden: RerankScore = raw;
    void forbidden;
  });

  it('a RerankScore still reads transparently as a number on the read path', () => {
    const s = rerankScore(0.75);
    expect(s).toBeCloseTo(0.75);
    expect(s > 0.5).toBe(true); // ordering comparisons work — that is its whole job
  });
});
