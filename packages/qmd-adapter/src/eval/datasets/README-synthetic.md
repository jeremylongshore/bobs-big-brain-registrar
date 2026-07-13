# `synthetic-v1` — the self-contained, CI-gated retrieval eval

`governed-brain-v1` is the _real_ number, but its gold ids point at the live
`~/.teamkb` corpus, so it can only be produced on a warm dev box and is
`describe.skipIf`-skipped on every cold CI runner — the number is measured but
**never enforced**. `synthetic-v1` closes that gap: it runs against a small
corpus that is **committed to the repo**, so the retrieval quality gate holds on
a cold runner with zero access to the real brain.

| Piece                | Path                                                              |
| -------------------- | ----------------------------------------------------------------- |
| Corpus (16 docs)     | [`../fixtures/synthetic-corpus/`](../fixtures/synthetic-corpus/)  |
| Dataset (20 queries) | [`./synthetic-v1.ts`](./synthetic-v1.ts)                          |
| CI ratchet           | [`../ci-retrieval-ratchet.ts`](../ci-retrieval-ratchet.ts)        |
| Run                  | `pnpm --filter @qmd-team-intent-kb/qmd-adapter eval:retrieval:ci` |

## The corpus

16 tiny governed-brain-style memories under `curated/` (12), `decisions/` (2),
and `guides/` (2) — the three default-searchable collections. Every doc is a
short, self-contained "memory": **no secrets, no real internal data**, so the
corpus is dual-usable as a public showcase. The id space is exactly what
`qmd search` returns for a locally-built index over these files:
`qmd://kb-{curated,decisions,guides}/<file-basename>.md`.

## The queries (stratified, semantic-weighted: 8 lexical, 12 semantic)

The split is the whole point — a blended average hides a semantic collapse.

- **lexical (8)** reuse the target doc's exact headline terms → BM25's home
  turf → all hit.
- **semantic (12)** avoid the headline. Seven are _body-overlap_ paraphrases
  (reuse distinctive body wording — BM25 still finds them); five are
  _synonym / low-overlap_ paraphrases that restate the concept in words the doc
  never uses (the genuine BM25 recall wall → miss). Real misses are **kept**, not
  reworded away — that is the signal.

## The ratchet

`ci-retrieval-ratchet.ts` builds a throwaway qmd index over the corpus in a temp
dir (never `~/.teamkb`), runs the set through the production `adapter.query()`
BM25 path, computes Recall@10 **per stratum separately**, and fails (exit 1) if
either stratum drops below its committed baseline minus a small epsilon.

Baselines are **measured, not guessed** — the numbers this corpus + query set
actually produce against the pinned `@tobilu/qmd` (see `SYNTHETIC_V1_BASELINE`
in `synthetic-v1.ts`):

| Stratum  | Hits  | Recall@10 |
| -------- | ----- | --------- |
| lexical  | 8/8   | 1.0       |
| semantic | 7/12  | ≈ 0.5833  |
| overall  | 15/20 | 0.75      |

The ratchet guards the retrieval we already ship against regression. It does
**not** gate on the absolute 0.85 BM25-sufficiency bar — that is the
build-the-semantic-path decision threshold from
[ADR 038-AT-DECR](../../../../../000-docs/038-AT-DECR-retrieval-backend-decision-2026-06-18.md),
not a ship gate. A retrieval _improvement_ never fails; if a `qmd` bump
legitimately raises a floor, re-measure and bump the baseline in the same PR.

## Reproduce

```bash
pnpm build                                                       # emit dist the script imports
pnpm --filter @qmd-team-intent-kb/qmd-adapter eval:retrieval:ci  # build temp index, run, gate
```
