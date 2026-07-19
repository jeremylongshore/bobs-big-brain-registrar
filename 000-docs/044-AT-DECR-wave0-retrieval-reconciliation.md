---
title: 'Governed Second Brain: Wave-0 Retrieval Reconciliation (Reranker-First, Apache/MIT, Dense Deferred to Measurement)'
filing_code: 044-AT-DECR
date: 2026-07-19
deciding_authority: Jeremy Longshore (Intent Solutions), acting head of board
reconciles: 016-AT-PLAN (Axis 1, reranker-first) vs 038-AT-DECR (dense-only, EmbeddingGemma, reranker rejected)
supersedes: the retrieval-arm and embedder-model elements of 038-AT-DECR only; all other 038 decisions stand
serves: O1 (retrieval measured), O4 (seam holds); unblocks Epic B (019-PP-PLAN bead A1)
status: binding decision record: supersedes only by explicit later DECR
license: Apache-2.0
---

# Governed Second Brain: Wave-0 Retrieval Reconciliation

## What this is

The Wave-0 decision that unblocks all retrieval work in `019-PP-PLAN` (bead A1). Two prior
binding documents give opposite orders. `038-AT-DECR` (2026-06-18, binding) rejected the
cross-encoder reranker and picked a dense-only backend on EmbeddingGemma-300M. `016-AT-PLAN`
(Axis 1) prioritizes the reranker P0, makes dense a conditional measure-before-ship add, and
flags EmbeddingGemma's license as a product trap. Nothing in Epic B ships until this conflict
is settled by an explicit later decision record. This is that record. Three advocates argued
reranker-first, dense-only, and both; their briefs are the input to this decision.

The estate rule is explicit: architectural changes need approval first, and `038` supersedes
only by a later DECR. This document is that later DECR. It changes one thing (the retrieval
arm and its model), and it preserves everything else `038` decided.

## The conflict, stated

- `038-AT-DECR` §2: ship BM25 now, build an eval, then lean-C = a native sqlite-vec semantic
  backend on **EmbeddingGemma-300M only (~320 MB)**, dropping qmd's reranker and query
  expander. Its own rationale (§3) concedes the load-bearing number is unmeasured: embedding-only
  "discards ~90% of the value" of the reranker and expander, and "no eval set means A-vs-C is
  faith, not arithmetic."
- `016-AT-PLAN` Axis 1: add the cross-encoder reranker FIRST (the measured primary driver),
  keep the dense arm CONDITIONAL and P2 (measure before ship), and use an Apache/MIT model,
  never EmbeddingGemma (gated Gemma license) or Jina rerankers (CC-BY-NC, non-commercial).
- The `019-PP-PLAN` audit correction sharpens both: the two-lexical-arm hybrid (qmd BM25 plus
  native FTS5, RRF-fused) already exists, the reranker bolts onto its fused top-k with no new
  vector store, and the 42-query real gold set (`eval/datasets/governed-brain-v1.ts`, 14
  lexical plus 28 semantic, real `qmd://` labels) already exists but is orphaned from CI.

So the decision is not "build retrieval from zero." It is: which arm goes on the existing
lexical hybrid first, on which license, and behind which measurement gate.

## Options considered

### Option 1: reranker-first (016 Axis 1)

Ship a local cross-encoder that rescores the fused lexical top-50 to top-8. Dense is a later,
measured, conditional add.

- **Pro.** The reranker is the most-replicated measured win in the corpus. `[ret-scifact]`
  names cross-encoder rerank the "primary driver" of final performance. `[ret-clinical]` (the
  one peer-reviewed ANOVA) finds rerank significantly beats standalone BM25 AND standalone
  dense. `[ret-bm25crag]` reaches Recall@5 0.816 with two-stage hybrid plus rerank, beating
  every single-stage method. It bolts onto the existing fused top-50 with no vector store, no
  sqlite-vec index, no embed-at-promotion pipeline, and no new persistent state that grows with
  the corpus. It sits read-path-only above the spool, behind the seam firewall.
- **Con.** A reranker can only reorder what the lexical arms already surfaced. It improves
  precision and ordering, not semantic recall: a pure vocabulary-mismatch query that BM25 and
  FTS5 never surface into the top-50 cannot be recovered by rescoring. On single-model footprint
  it is not the lightest: Qwen3-Reranker-0.6B (~610 MB) is larger than EmbeddingGemma-300M
  (~320 MB).

### Option 2: dense-only (038 line)

Add one dense embedding arm to the existing lexical RRF, no reranker.

- **Pro.** It closes exactly the named gap (missing dense/semantic signal, one signal not an
  architecture) and nothing more. It is the smallest single-model RAM footprint. `[eval-groupmem]`
  says the bottleneck is admission not retrieval, which argues against over-investing in the
  read path.
- **Con.** Its central "~90% of the value" claim is admitted faith with no benchmark behind it
  (038 §3). The cited evidence cuts against a bare dense arm: `[ret-scifact]` warns RRF hybrid
  did NOT consistently beat the best dense retriever and can dilute strong rankings on harder
  queries; `[ret-bm25crag]` found BM25 beat dense on precise numeric text. GSB's corpus is
  dense with exact identifiers (bead IDs, filing codes, `qmd://` URIs), the terrain where dense
  underperforms. It forgoes the single most-defensible measured retrieval gain in the corpus.

### Option 3: both (reranker plus dense, built together)

- **Pro.** `[ret-clinical]` and `[ret-bm25crag]` measure their top configs as two-arm two-stage
  systems, and a reranker is starved on conceptual queries without a dense candidate arm feeding
  it. Building both pays the seam-integration tax and the RAM re-budget once, not twice.
- **Con.** It is the maximum investment in the thing `016`'s own strategy says is not the moat
  ("lead with the seam, not the reranker"; retrieval mechanics are commodity). It is the heaviest
  local footprint (embedder plus reranker both resident) on the exact constraint `038` optimized
  hardest against (OOM-sensitive box). It commits to the riskier dense arm before any eval exists
  to justify it, collapsing the measure-before-ship safety valve `016` built for exactly that arm.

### Option 4: neither (stay BM25 plus FTS5 only)

- **Pro.** Zero new machinery, zero new RAM, `[ret-piserini]` and `[eval-groupmem]` both defend
  a tuned lexical floor.
- **Con.** The conceptual-query recall gap is real and named, and the reranker is a cheap,
  measured, license-clean lift on the fused top-50 that leaves it on the table. `[ret-piserini]`
  used a frontier model (gpt-5.5), so it licenses KEEPING and TUNING BM25 but does NOT license
  skipping rerank on a local commodity model. Neither under-ships.

## The decision

**Ship reranker-first. Defer the dense arm to a measured P2 gate. Use Apache/MIT weights only.
EmbeddingGemma is out.**

Concretely:

1. Add a local Apache-2.0 cross-encoder reranker that rescores the existing fused BM25/FTS5
   top-50 to top-8, called from `brain_search` only, read-path-only, content-addressed by
   (content-hash, model-id, version). This is `019` bead B1.
2. Land the type-level seam firewall (bead B2) in the SAME PR: a rerank or embedding score can
   never type-check as a govern or promotion input.
3. The reranker still has to clear the real gold set. It ships first because it is the
   most-replicated measured win, not because it is exempt from measurement.
4. The dense plus RRF arm (bead B4) stays P2, conditional, and ships only on a positive
   measured delta against reranked-BM25 (see gates below). It is deferred, not denied.

**Chose reranker-first over dense-only because** the reranker is the measured primary driver
across three independent 2026 results (`[ret-scifact]`, `[ret-clinical]`, `[ret-bm25crag]`)
while dense-only rests on `038`'s own admitted faith ("no eval set means A-vs-C is faith"), and
because a bare dense arm carries a cited dilution and numeric-precision downside
(`[ret-scifact]`, `[ret-bm25crag]`) on exactly GSB's identifier-heavy corpus. `038` kept the
signal the papers call inconsistent and cut the stage the papers call primary; this reverses
that.

**Chose reranker-first over both because** `[eval-groupmem]` places the bottleneck at admission,
not retrieval, so building the heaviest two-model footprint on an OOM-sensitive box, before any
eval exists to justify the second arm, is maximum investment in the commodity `016`'s strategy
says is not the moat. Both remains the correct next buy IF and ONLY IF measurement shows the
reranker alone leaves a conceptual-slice recall gap (see gates).

**Chose reranker-first over neither because** the conceptual-recall gap is real and the reranker
is the cheapest license-clean lift that bolts onto the hybrid GSB already runs, and `[ret-piserini]`'s
lexical-sufficiency result used a frontier model, so it does not license skipping rerank locally.

## Embedder and reranker license resolution

License is a hard gate, above MTEB score. Apache-2.0 or MIT only.

- **Reranker (ships now, bead B1): Qwen3-Reranker-0.6B (Apache-2.0)**, CPU, no external API.
  Alternate: **bge-reranker-v2-m3 (Apache-2.0)**.
- **Embedder (deferred to bead B4, only if measured to help): Qwen3-Embedding-0.6B (Apache-2.0)**,
  32K context, GGUF ~400 MB, MRL-truncatable to 512-dim to claw back RAM. Fallback: **BGE-M3
  (MIT)**, 1024-dim, 8192 context.
- **Forbidden.** EmbeddingGemma-300M (gated Gemma license, `016` names it a trap that "does not
  ship in a product"). Jina rerankers (CC-BY-NC, non-commercial). `038`'s specific EmbeddingGemma
  pick is overridden here regardless of its MTEB score, because a gated license is disqualifying
  for a commercial plugin and marketplace product.

Every weight is SHA-256 pinned and fails closed on mismatch before it goes anywhere near a
semantic path. This is `038` §4, unchanged and still non-negotiable: pinning now covers the
reranker weight instead of the EmbeddingGemma weight.

## Relationship to 038-AT-DECR

This record **supersedes two elements of `038` and preserves the rest.**

Superseded:

- `038` §2 item 4 (lean-C dense-only on EmbeddingGemma-300M as the next semantic step) becomes
  reranker-first with dense deferred to a measured P2 gate.
- `038`'s rejection of the reranker is reversed: the reranker is the P0 arm.
- `038`'s embedder pick (EmbeddingGemma-300M) is overridden on license grounds; if and when a
  dense arm ships, it is Qwen3-Embedding-0.6B (Apache-2.0) or BGE-M3 (MIT).

Preserved (still binding):

- Ship BM25-on-qmd now as the wired path; BM25 plus FTS5 stay defended co-equal arms under the
  reranker, never an apology (`038` §2 item 1, `016` Axis 1).
- Pin the qmd binary and every model weight by SHA-256, fail closed, before any semantic path
  ships (`038` §4).
- Build/wire the real-query eval before gating an arm (`038` §2 item 3). The `019` audit found
  this set largely already exists (`governed-brain-v1`, orphaned from CI); wiring it is bead C1.
- Reject NEXUS (D), cut the qmd|native selector, keep the QmdExecutor seam as the reversibility
  mechanism (`038` §2 items 5 and 6, §5).
- The seam firewall and the forbidden-words honesty rail (`038` §5, `016` §4).

Because the change is to the binding retrieval arm and model, this is a supersession of those
specific elements, executed as a later DECR per `038`'s own supersession clause, not an informal
amendment.

## Ship order and measurement gates

Ordered, each gate blocking the next:

1. **Wire the real gold set into CI first (bead C1).** Restore a snapshotted brain export,
   run `governed-brain-v1` through `adapter.query()`, report stratified Recall@10 and nDCG@10
   against a committed floor. This is the anchor. No retrieval arm is judged on synthetic
   fixtures.
2. **Pin the reranker weight, SHA-256, fail closed (bead from `038` §4 discipline)** before B1
   loads any model.
3. **Land B1 (reranker) plus B2 (seam firewall) in one PR.** Acceptance: `adapter.query()`
   gains an optional rerank stage, `brain_search` calls it before truncation, a dependency-cruiser
   rule fails the build if the policy engine imports a retrieval package, and a unit test asserts
   a compile-derived score cannot type-check as a govern input.
4. **Reranker ship gate (KR1.3).** The reranker must beat the tuned-BM25 baseline on the
   conceptual slice with a verified non-regression on the exact-term slice, measured on
   `governed-brain-v1`, segmented exact-term vs conceptual per `016` Axis 6. Working target is
   +3 to +8 nDCG@10 on the conceptual slice and roughly 0 on exact-term. The number we publish
   is the number the eval produces, no borrowed figures.
5. **Add the three seam-independence CI gates (bead B3):** delete-Compile, swap-model,
   verify-receipts-model-free. Scaffold now, exercise for real once B1 lands.
6. **Dense arm (bead B4), conditional, P2.** Build a bi-encoder candidate generator behind a
   flag, embeddings content-addressed, A/B measured against reranked-BM25 on `governed-brain-v1`.
   Ship ONLY on a positive semantic-stratum delta with no exact-term regression, and only on an
   Apache/MIT embedder. Deferral trigger inherited from `038` §5: a logged real query returns
   zero relevant `qmd://` hits on a corpus that contains the answer, twice, AND the eval shows
   reranked-BM25 below the conceptual-recall floor.

## Honest residual

- **We have zero GSB-measured retrieval numbers today.** Every figure cited above (0.816, 83.1%,
  the ANOVA significance) is on other corpora. The GSB delta is
  **[PENDING WAVE 1: nDCG@10 and Recall@10 of reranked-BM25 vs BM25-plus-FTS5 only on the real
  `governed-brain-v1` 42-query gold set, segmented exact-term vs conceptual]**.
- **RAM and latency on the target box are unmeasured.**
  **[PENDING WAVE 1: resident RAM plus p50/p95 query latency for Qwen3-Reranker-0.6B on the
  target CPU]**. The reranker adds a second model load and a second latency term; it adds no
  vector index and no promotion-time embedding compute.
- **The reranker does not close semantic recall holes.** It reorders what the lexical arms
  surfaced. The conceptual-recall gap is the honest reason the dense arm is a real deferred add,
  not a strawman. If the reranker ship gate (step 4) shows a residual conceptual gap, B4 is the
  correct next buy and this decision yields to that measurement.
- **`[ret-piserini]` used a frontier model, not a local one.** It defends keeping and tuning
  BM25 as a co-equal arm under the reranker. It does not license a lexical-only or a
  skip-the-reranker posture on GSB's local commodity models.
- **Retrieval is not the moat.** Per `016` and `017`, the durable differentiators are
  deterministic policy admission, receipt completeness, and federation. This decision deliberately
  buys the smallest license-clean retrieval win that clears the real gold set, and spends no
  further complexity budget on the read path until measurement demands it. Receipts attest
  integrity, provenance, and ordering, never truth; nothing in this retrieval decision touches
  that boundary.
