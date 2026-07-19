/**
 * The seam firewall (blueprint 019-PP-PLAN bead B2; Hickey's constraint in 016-AT-PLAN).
 *
 * A govern decision may only ever consume a DETERMINISTIC score. A retrieval-side
 * score (a cross-encoder rerank score, an embedding similarity, any model-derived
 * number) must never be able to influence what becomes durable. That rule is the
 * model-proposes / code-owns-durable-state seam, and it is enforced here at the TYPE
 * level, not by code-review discipline.
 *
 * `RuleResult.score` is typed as `DeterministicScore`, a branded number. A plain
 * `number` (which is what a rerank/embedding score is) is NOT assignable to
 * `DeterministicScore` — the compiler rejects it. The ONLY way to mint one is the
 * `deterministicScore()` factory below, which lives in the policy-engine package.
 *
 * That type barrier is paired with an architectural barrier: a dependency-cruiser
 * rule (`.dependency-cruiser.cjs`, "no-govern-imports-retrieval") forbids
 * `packages/policy-engine` and the promotion path from importing the retrieval
 * adapter at all, so a rerank score cannot even be imported into a position where it
 * could reach this factory. Type barrier + import barrier = the score cannot cross
 * the seam.
 *
 * Do NOT export a way to brand an arbitrary externally-sourced number. The point is
 * that only code inside this deterministic-govern boundary produces a govern score.
 */

/** A score produced by deterministic govern-side code. Not interchangeable with a raw number. */
export type DeterministicScore = number & {
  readonly __brand: 'deterministic-govern-score';
};

/**
 * The sole sanctioned producer of a DeterministicScore. Call this only from
 * deterministic policy rules (relevance, trust). Never wrap a retrieval/rerank/
 * embedding score with it — those live above the spool and must stay there.
 */
export function deterministicScore(value: number): DeterministicScore {
  return value as DeterministicScore;
}
