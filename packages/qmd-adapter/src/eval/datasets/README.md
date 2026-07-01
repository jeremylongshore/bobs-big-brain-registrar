# Retrieval eval datasets

Hand-labeled query sets that gate the retrieval-backend decision in
[ADR 038-AT-DECR](../../../../../000-docs/038-AT-DECR-retrieval-backend-decision-2026-06-18.md):
**does BM25-on-qmd clear Recall@10 ≥ 0.85, or is the deferred sqlite-vec semantic
backend (bead `qmd-team-intent-kb-0t9.3`) justified?**

| Dataset                      | File                                             | Corpus                                       | Purpose                                                                                      |
| ---------------------------- | ------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `governed-second-brain-seed` | [`seed-queries.ts`](./seed-queries.ts)           | _(none — placeholder ids)_                   | SHAPE/starter only. Runnable against a mock backend in unit tests. **Not a real benchmark.** |
| `governed-brain-v1`          | [`governed-brain-v1.ts`](./governed-brain-v1.ts) | live `~/.teamkb` (tenant `intent-solutions`) | The **first real number** (bead `compile-then-govern-e06.4` / umbrella #27).                 |

## `governed-brain-v1` — how it was built (methodology)

The number is only as honest as the labels. This set was constructed to _avoid_
the two ways a retrieval benchmark lies (cherry-picking easy queries; rewording
queries until the keyword index hits):

1. **Real corpus, real id space.** Gold citations are exact `qmd://kb-{curated,
decisions,guides}/<uuid>.md` strings drawn from the live export tree — the
   same id space `brain_search` / `QmdSearchResult.file` returns. Only the three
   default-searchable collections are targeted (inbox/archive are out of default
   scope).

2. **Labeled from the corpus, not from search.** Each query's gold doc was chosen
   by reading the doc's title + body summary in the export tree and deciding it
   genuinely answers the query — _before_ running any search. Search was then run
   only to confirm the gold doc exists and is reachable in principle, and to
   record whether BM25 finds it and at what rank.

3. **Stratified, weighted toward semantic.** Each query is tagged `lexical`
   (exact term/name/title — BM25's home turf) or `semantic` (paraphrase / concept
   / plain-language question that deliberately avoids the target's headline
   keywords). The set is weighted toward `semantic` because that is the stratum
   where the recall wall shows up and where ADR 038 weights the decision.

4. **No cherry-picking, no gate-chasing.** A BM25 _miss_ on a valid semantic
   query is kept, not discarded — that miss is the signal the ADR gate measures.
   Queries were never reworded to make BM25 succeed.

## Reproduce the number

```bash
# 1. warm the live index (read-only search needs a built index)
pnpm reindex

# 2. run the eval against the live index — prints overall + lexical/semantic
#    Recall@10 / nDCG@10 / MRR and the ADR 038 verdict
pnpm eval:retrieval
```

The CI-runnable reproduction lives in
[`../../__tests__/eval-retrieval-live.test.ts`](../../__tests__/eval-retrieval-live.test.ts)
— it runs the same dataset through the production `adapter.query()` BM25 path
against the live index and asserts the pipeline reproduces, skipping cleanly when
qmd or a built `~/.teamkb` index is absent.
