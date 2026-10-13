# Retrieval eval datasets

Hand-labeled query sets that gate the retrieval-backend decision in
[ADR 038-AT-DECR](../../../../../000-docs/038-AT-DECR-retrieval-backend-decision-2026-06-18.md):
**does BM25-on-qmd clear Recall@10 ≥ 0.85, or is the deferred sqlite-vec semantic
backend (bead `qmd-team-intent-kb-0t9.3`) justified?**

| Dataset                      | File                                                   | Corpus                                             | Purpose                                                                                               |
| ---------------------------- | ------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `governed-second-brain-seed` | [`seed-queries.ts`](./seed-queries.ts)                 | _(none — placeholder ids)_                         | SHAPE/starter only. Runnable against a mock backend in unit tests. **Not a real benchmark.**          |
| `governed-brain-v1`          | [`governed-brain-v1.ts`](./governed-brain-v1.ts)       | live `~/.teamkb` (tenant `intent-solutions`)       | The **first real number** (bead `compile-then-govern-e06.4` / umbrella #27).                          |
| `estate-onboarding-v1`       | [`estate-onboarding-v1.ts`](./estate-onboarding-v1.ts) | live `~/.teamkb`, through the team-API search path | **FAMA@10**: does the brain serve obsolete answers to a new hire? (bead `compile-then-govern-39z.5`). |

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

## `estate-onboarding-v1` — forgetting-aware accuracy (FAMA@10)

Recall@10 scores a brain fine while it ranks a torn-down platform's runbook next
to the current one. `estate-onboarding-v1` asks 50 questions a new hire asks
(deploy, secrets, alerts, backups, commit standard, beads, how to use the brain)
and scores **FAMA@10**, Memora's Forgetting-Aware Memory Accuracy
([arXiv:2604.20006](https://arxiv.org/abs/2604.20006)) applied to a ranked list:

    FAMA = max(0, MPA − λ·(1 − FAA)),   λ = |obsolete| / (|relevant| + |obsolete|)

MPA is Recall@10 over the current docs; FAA is the fraction of the query's
labeled-obsolete docs kept out of the top 10. With no obsolete labels FAMA equals
Recall@10. Code: `famaAtK` in [`../metrics.ts`](../metrics.ts).

**Labels.** Current truth came from estate authority first (the CLAUDE.md files,
intent-os `ops/`, the umbrella `000-docs`), then the docs stating it were found in
`kb-export` by reading them. `obsolete` holds only active, default-scope docs a
new hire could act on wrongly (GCP or Netlify deploys, Slack alerts, "B2 not
provisioned", pre-rename repo maps, the retired private marketplace); off-topic
noise and docs framed as history are not obsolete. 45 questions are scored; 23
carry obsolete labels (60 in all).

**Gaps are an output, not a failure.** Five questions have no current doc in the
brain (`ESTATE_ONBOARDING_V1_GAPS`): merging through `safe-merge`, the tailnet
Netdata URL, the Jitsi meeting tool, the business mailing address, and where the
LLM provider keys live. They are listed for curation instead of being scored.

**Run** (live, read-only — the store opens `readonly`, nothing reindexes):

    pnpm eval:estate             # report
    pnpm eval:estate --json      # machine-readable
    pnpm eval:estate --probe "q" # top 10 with lifecycle/category/date, for labeling

The report names the retrieval mode it measured. Production search fails open to
lexical-only when the embedder is down, so the runner counts dense-arm failures
and prints `DEGRADED` instead of passing a lexical-only number off as the real one.

**First measurement (2026-10-13, live brain):**

| Retrieval               | Recall@10 | nDCG@10 | FAMA@10 | Obsolete exposure |
| ----------------------- | --------- | ------- | ------- | ----------------- |
| dense + lexical         | 0.4815    | 0.3655  | 0.4577  | 0.1556 (7 of 45)  |
| lexical only (degraded) | 0.0815    | 0.0843  | 0.0783  | 0.0444            |

The lexical-only row is what teammates got while the embedder was stopped
2026-10-10..13. Not frozen and not a gate: the corpus changes daily, and this set
exists to show whether retiring stale knowledge moves the number.

**Known limit.** Labels were drawn while the embedder was down, so an obsolete doc
that only dense retrieval surfaces may still be unlabeled; review the dense top-10
before treating obsolete exposure as complete.
