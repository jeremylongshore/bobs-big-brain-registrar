# Retrieval eval datasets

Hand-labeled query sets that gate the retrieval-backend decision in
[ADR 038-AT-DECR](../../../../../000-docs/038-AT-DECR-retrieval-backend-decision-2026-06-18.md):
**does BM25-on-qmd clear Recall@10 ≥ 0.85, or is the deferred sqlite-vec semantic
backend (bead `qmd-team-intent-kb-0t9.3`) justified?**

| Dataset                      | File                                                   | Corpus                                                 | Purpose                                                                                               |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `governed-second-brain-seed` | [`seed-queries.ts`](./seed-queries.ts)                 | _(none — placeholder ids)_                             | SHAPE/starter only. Runnable against a mock backend in unit tests. **Not a real benchmark.**          |
| `governed-brain-v1`          | [`governed-brain-v1.ts`](./governed-brain-v1.ts)       | live `~/.teamkb` (tenant `intent-solutions`)           | The **first real number** (bead `compile-then-govern-e06.4` / umbrella #27).                          |
| `estate-onboarding-v1`       | [`estate-onboarding-v1.ts`](./estate-onboarding-v1.ts) | local retrieval core, snapshots of `~/.teamkb` indexes | **FAMA@10**: does the brain serve obsolete answers to a new hire? (bead `compile-then-govern-39z.5`). |

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
noise and docs framed as history are not obsolete. 45 questions are scored; 21
carry obsolete labels (54 in all after the 2026-10-23 audit).

**Gaps are an output, not a failure.** Five questions have no current doc in the
brain (`ESTATE_ONBOARDING_V1_GAPS`): merging through `safe-merge`, the tailnet
Netdata URL, the Jitsi meeting tool, the business mailing address, and where the
LLM provider keys live. They are listed for curation instead of being scored.

**Run** (source data read-only; index refresh is isolated as described below):

    pnpm eval:estate             # report
    pnpm eval:estate --json      # machine-readable
    pnpm eval:estate --probe "q" # top 10 with lifecycle/category/date, for labeling

The launcher backs up the selected tenant's qmd, native FTS5 and dense SQLite
indexes and the memory store into a private temporary directory, then runs a
worker against those copies. Native refresh and dense model invalidation do not
alter source index data. The original export tree is read for current markdown;
there is no reindex of the source qmd/dense index and no document embedding pass.
The configured loopback query embedder is still used when dense is enabled.

Each SQLite backup includes committed WAL frames. Source read-only connections
may create empty WAL/SHM files or update SHM reader coordination; database and
committed WAL data are not rewritten. Separate database backups plus the live
export tree are **not one atomic snapshot**, so concurrent activity can affect
comparability. JSON reports include snapshot timestamps and source-index presence;
probes also print retrieval mode and sanitized degradation categories.
This runs the local QmdAdapter/SearchService core, not the deployed HTTP API. Missing, empty, incompatible
or unavailable dense state is reported rather than silently scored as healthy.
Temporary files are removed after worker exit, including error and normal signal
paths; a forced OS kill can leave a private temporary directory behind.

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

**After the first cleanup (2026-10-14, bead `compile-then-govern-39z.26`).** 34
wholly obsolete docs archived through `curator batch-transition` (one receipt each),
then export + reindex; five missing facts captured and governed. Partly stale docs that
are also the correct answer elsewhere were left for a corrected rewrite (bead
`compile-then-govern-39z.28`), since archiving them would cost recall.

| Run (dense + lexical)    | Recall@10 | nDCG@10 | FAMA@10 | Obsolete exposure |
| ------------------------ | --------- | ------- | ------- | ----------------- |
| before cleanup, same day | 0.4741    | 0.3609  | 0.4503  | 0.1556 (7 of 45)  |
| after cleanup + reindex  | 0.4333    | 0.2912  | 0.4296  | 0.0222 (1 of 45)  |

Obsolete exposure fell from 7 questions to 1 (the remaining one, `d92c5eea`, is in
39z.28). Recall fell because three questions (e02, e31, e36) lost their answer to recent
short notes; no archived doc was a relevant one. The reindex embedded 141 docs the
dense index had been missing, and those recent, narrow notes now outrank the canonical
docs, so the "before" row was measured against a stale dense index. Gaps are reported
by rank, not scored: all five filled holes rank 1 or 2.

**Bounded freshness (2026-10-16, bead `compile-then-govern-39z.29`).** The three lost answers
were in the fused top 10 before the rerank: an unbounded 90-day decay of `updatedAt` (import
time for every doc bulk-imported 2026-07-15/16) halved their score against last week's notes.
Freshness now multiplies by at most [0.8, 1]. To avoid tuning on these 45 questions, the
candidates (no freshness, 365-day half-life, floors 0.5–0.9) were also scored on the held-out
`governed-brain-v1` set through the same rerank; both sets were flat for floors 0.8–1.0, and
0.8 keeps freshness as a tiebreaker.

| Run (dense + lexical)            | Recall@10 | nDCG@10 | FAMA@10 | Obsolete exposure |
| -------------------------------- | --------- | ------- | ------- | ----------------- |
| unbounded freshness, same day    | 0.4259    | 0.2882  | 0.4222  | 0.0222 (1 of 45)  |
| freshness floor 0.8              | 0.5370    | 0.3884  | 0.5302  | 0.0444 (2 of 45)  |
| held-out governed-brain-v1, then | 0.8214    | 0.5768  | —       | —                 |
| held-out governed-brain-v1, now  | 0.9881    | 0.8570  | —       | —                 |

Per question: 15 estate questions gained recall and 4 lost some (e22, e30, e48, e49); on the
hold-out 7 gained and none lost. The second obsolete doc served (`7a25e42e`, rank 10 for e41)
is, like `d92c5eea`, a partly stale doc queued for rewrite in 39z.28. e02 "where is production
hosted" still misses: its canonical doc ranks just outside the top 10, behind generic "production" reference docs with a higher fused score and Catalyst production notes.

**Corrected rewrites (2026-10-16, bead `compile-then-govern-39z.28`).** The eleven docs that
were mostly current but carried one stale claim (Slack alerting, `secrets: inherit`, off-site
backup "still pending", Google Workspace still used, a Workspace login for Tailscale, brain_search as
`qmd search --json`, plaintext API tokens, Cloud Run) were each recaptured through
`brain_capture` + `brain_govern` with the claim corrected, and the originals archived (nine by
`curator batch-transition`, two auto-superseded by title). The admin-bypass merge note
(`5c22589c`) was archived by owner decision: merges go through `safe-merge` only. Labels moved
with the docs: the rewrite replaces its original wherever it was relevant, obsolete labels on
the archived originals are gone, and a rewrite that now answers a question it used to answer
wrongly (alerts, offsite backup, email host, tailnet join, access token, search stack) is
relevant there. Measured on a quiet box; under Catalyst CI load (load 23 on 8 cores) the 5 s
dense timeout fails on every query and the run reports `DEGRADED`.

| Run (dense + lexical)    | Recall@10 | nDCG@10 | FAMA@10 | Obsolete exposure |
| ------------------------ | --------- | ------- | ------- | ----------------- |
| before rewrites (39z.29) | 0.5370    | 0.3884  | 0.5302  | 0.0444 (2 of 45)  |
| after rewrites + relabel | 0.5389    | 0.3981  | 0.5389  | 0.0000 (0 of 45)  |

Nine questions still miss (e01, e03, e09, e14, e17, e25, e38, e43, e48); e02 "where is
production hosted" now hits. The two numbers are not strictly comparable because the labels
changed with the corpus; the obsolete-exposure column is the one this bead was for.

**Dense top-10 audit (2026-10-23, bead `compile-then-govern-39z.27`).**
An isolated local QmdAdapter/SearchService run at registrar
`06a960a219928a9e2ca0e8309a08509f842fc4c6` captured all 45 unchanged questions
with dense enabled, all three source indexes present and zero observed dense
query failures. Backups ran 19:37:04–19:37:09UTC. All45 literal probes returned
the same 450 result slots / 329 unique citations; their content was screened
against current owning authorities. See the compact
[observation and relabel receipt](./estate-onboarding-audit-2026-10-23.json).
No private source content is included in that receipt.

Seven query-specific obsolete labels were added after reading their actionable,
current-tense claims and checking the authorities below. Historical records,
contradiction proposals and off-topic cloud examples were not labeled solely for
mentioning an old platform. Labels apply to these questions, not universally to
every appearance of the document.

| Query | Citation prefix / observed rank | Stale instruction                                                          | Current authority                                                                                                                                                                                                                                                                           |
| ----- | ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| e21   | `dd3f92bc` /10                  | Point Hustle www at Google hosting                                         | [VPS deployment target](https://github.com/jeremylongshore/hustle/blob/3aca65905492da30c7cd2eeb3042767280039fb1/.github/workflows/deploy.yml#L54); observed apex/www both 167.86.106.29, no www CNAME                                                                                       |
| e22   | `2a1df12b` /2, `0d239fc3` /6    | Build Linkyee/static `_output/`                                            | [Next.js/Docker deployment](https://github.com/jeremylongshore/jeremylongshore.com/blob/36a8da81dace59c1e5d0718b7f5647984921c073/CLAUDE.md#L10), [content/deploy rules](https://github.com/jeremylongshore/jeremylongshore.com/blob/36a8da81dace59c1e5d0718b7f5647984921c073/CLAUDE.md#L51) |
| e28   | `83567b00` /1, `41f458f7` /7    | Persist through `bd sync`, JSONL flush or SQLite/`beads-sync` branch       | [Umbrella task authority and passive JSONL rule](https://github.com/intent-solutions-io/bobs-big-brain-umbrella/blob/db924dd3289df03841a5a5b9a3c8bff4d9e8e592/AGENTS.md#L56)                                                                                                                |
| e38   | `174b389f` /7                   | Current repo is qmd-team-intent-kb, currently Phase 0                      | [Current registrar repository identity](https://github.com/intent-solutions-io/bobs-big-brain-umbrella/blob/db924dd3289df03841a5a5b9a3c8bff4d9e8e592/CLAUDE.md#L75); package/image/Bead aliases remain valid                                                                                |
| e42   | `3c865bbb` /4                   | deployment-docs, four-digit numbering, feature folders/camelCase filenames | [Public umbrella naming/layout rule](https://github.com/intent-solutions-io/bobs-big-brain-umbrella/blob/db924dd3289df03841a5a5b9a3c8bff4d9e8e592/AGENTS.md#L41); local v4.4 authority also inspected                                                                                       |

The audit also inspected private estate guidance for persistence and filing;
its contents are not published here. Public links above support the task-authority
and filename/layout distinctions, rather than pretending private source URLs are
publicly inspectable evidence.

Replaying the **same captured retrieval lists** through `runEval` after adding
only these seven obsolete labels gives:

| Labels on identical captured results | Recall@10 | nDCG@10 | FAMA@10 | Obsolete exposure |
| ------------------------------------ | --------- | ------- | ------- | ----------------- |
| Previous labels                      | 0.5389    | 0.4001  | 0.5389  | 0/45              |
| Seven additional obsolete labels     | 0.5389    | 0.4001  | 0.5151  | 5/45 (0.1111)     |

This exposes a measurement gap; no ranking or source-memory improvement occurred.
Recall/nDCG are identical because relevant labels and result lists are unchanged.
The capture's original backend string said `team-api search`; that was an
incorrect label for this local service invocation, narrowed in registrar PR 382.
It never exercised the deployed HTTP endpoint, authentication or middleware.

To take a new observation (requires the local brain, built indexes, working
loopback embedder and temporary space proportional to the selected store/indexes):

```sh
TEAMKB_BASE_PATH="$HOME/.teamkb" TEAMKB_TENANT=intent-solutions \
  TEAMKB_DENSE_ENABLED=1 TEAMKB_QMD_BIN="$PWD/node_modules/.bin/qmd" \
  TMPDIR=/dev/shm pnpm eval:estate --json > /tmp/estate-current.json
```

`/dev/shm` was chosen for available space on this host, not as a requirement.
A new capture can differ because the store, separate indexes and original export
tree are not an atomic ensemble. The receipt fingerprints the original ordered
query-id/retrieved-id projection with SHA-256, not the private corpus itself.
Private full reports/probes were retained locally for this audit; they are not
included as a public reproducible corpus or an external attestation.

**Known limit.** All 329 observed unique citations were screened, but mixed-current
**gold remains unresolved** under `compile-then-govern-39z.33`: calendar layout
(e19), personal-site deployment (e22), Beads persistence (e28/e29), retrieval
(e33/e41) and intake deduplication (e44), among other clauses. Gold citations are
retained pending bounded corrected admission/replacement; this keeps the present
score optimistic. No citation is both relevant and obsolete for one question.
No capture, lifecycle transition, export refresh or source reindex was performed
by this audit. The five exposed questions are a verified lower bound, not a claim
that the remaining answers or future dense results are current.
