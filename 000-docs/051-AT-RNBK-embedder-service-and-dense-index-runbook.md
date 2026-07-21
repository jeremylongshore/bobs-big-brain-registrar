# Embedder Service + Dense Index Runbook — `bbb-embedder` (B4)

**Doc:** 051-AT-RNBK · **Status:** Active · **Date:** 2026-07-20
**Scope:** the local embedding runtime (llama.cpp `llama-server` + EmbeddingGemma-300M), the sqlite-vec sidecar index, and the adapter dense arm that consumes them.
**Decision records:** [`038-AT-DECR`](038-AT-DECR-retrieval-backend-decision-2026-06-18.md) (sqlite-vec + EmbeddingGemma-300M only; skip qmd's 2.2 GB hybrid) · [`044-AT-DECR`](044-AT-DECR-wave0-retrieval-reconciliation.md) (Wave-0 ship order). Gate evidence that pulled B4 forward: [`050-AT-RNBK §9`](050-AT-RNBK-reranker-service-runbook.md) (20/28 semantic queries retrieve ≤1 fused candidate — the wall is candidate GENERATION, which a reranker cannot fix). Seam firewall: B2 (`packages/policy-engine/src/deterministic-score.ts`) extended by `dense-seam-firewall.test.ts`.

## 1. What this is

An OPT-IN dense retrieval arm. The deterministic RRF fusion in
`QmdAdapter.query()` gains a THIRD ranked list — top-50 nearest neighbours
from a sqlite-vec index of EmbeddingGemma-300M document embeddings — joining
qmd BM25 and native FTS5 by `qmd://` citation. The model runs as a
loopback-only systemd **user** service (the SAME SHA-256-pinned llama.cpp
runtime the reranker uses); nothing external is ever in the serving path.

**The one invariant to remember: dense FAILS OPEN.** Embedder down, timeout,
non-200, bad JSON, sqlite-vec extension unloadable, empty/stale index — every
failure serves the lexical fusion with no dense list. Killing this service
degrades semantic recall; it can never break search. The model proposes
candidates via list RANK only — the fused score stays pure rank arithmetic,
and the embedding similarity is type-branded `DenseScore`, which cannot be
assigned into govern's `DeterministicScore` (enforced by tsc + a
dependency-cruiser rule).

**Two correctness properties that are load-bearing, not incidental:**

- **Mean pooling + L2 normalization are PINNED** on the service
  (`--pooling mean --embd-normalize 2`), not left to GGUF auto-detect. The
  cosine score and the raw-L2 KNN ordering are only valid for mean-pooled,
  L2-normalized vectors; a silent fallback to last-token/CLS pooling would
  return well-formed but wrongly-ordered hits that the fail-open path cannot
  catch. Verified 2026-07-20 (mean is also this GGUF's default: relevant vs
  irrelevant cosine 0.63 vs 0.00), so the pin changes nothing observable — it
  removes the silent-misconfig failure mode.
- **Scope filtering happens INSIDE the KNN** via a vec0 `collection` partition
  key, not after it. Under the default `curated` scope, the embedded-but-
  out-of-scope `kb-archive` collection (~38% of this corpus) would otherwise
  fill the k nearest slots and starve curated recall — the very recall this
  arm exists to buy. `WHERE collection IN (...)` inside the vec0 query returns
  the k nearest _within scope_.

## 2. Components

| Piece          | Where                                                                                            | Pinned by                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Runtime binary | `~/.local/lib/bbb/llama-server/current/llama-server` (llama.cpp release `b10068` — shared w/ B1) | SHA-256 in `scripts/install-llama-server.sh` (`6bf3d20d…4be4eb2`), verified fail-closed before install                       |
| Model weights  | `~/.cache/qmd/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf` (333,590,944 bytes)              | SHA-256 `b5ce9d77…490d63` in `weights-manifest.ts` (id `embedding`); re-verified on disk 2026-07-20                          |
| Service unit   | `~/.config/systemd/user/bbb-embedder.service` (source of truth: `scripts/bbb-embedder.service`)  | ExecStartPre `sha256sum -c ~/.local/lib/bbb/embedder-weights.sha256` — the manifest pin restated where systemd can check it  |
| Endpoint       | `http://127.0.0.1:8098/v1/embeddings` (+ `/health`)                                              | loopback only; port 8098 chosen free in the 8090–8199 range, ≠ 8097 (bbb-reranker) and avoiding 8090/8091 (forms/scott APIs) |
| Adapter arm    | `packages/qmd-adapter/src/dense/`                                                                | opt-in via `QmdAdapterConfig.dense`                                                                                          |
| Sidecar index  | `<qmd-index>/<tenant>/dense-vec.sqlite` (sqlite-vec vec0 + bookkeeping tables)                   | derived data — rebuildable from kb-export + this service; deletable at any time; outside backup scope                        |

Weight-gate design choice: identical to B1 — the unit uses a `sha256sum -c`
pin file rather than invoking the compiled `assertWeightsVerified` from a repo
checkout, because a service must not depend on a checkout's build state. The
pin file's hash IS the manifest constant for id `embedding` — keep the two in
lock-step on any weight bump (nothing asserts their equality automatically;
the upgrade checklist in §8 is the guard).

## 3. Install / start

```bash
# 1. Install the pinned runtime (idempotent; fail-closed on hash mismatch;
#    already present if bbb-reranker was installed — same binary)
bash scripts/install-llama-server.sh

# 2. Install the weight-gate pin file + unit
mkdir -p ~/.local/lib/bbb
printf '%s  %s\n' \
  b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63 \
  "$HOME/.cache/qmd/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf" \
  > ~/.local/lib/bbb/embedder-weights.sha256
cp scripts/bbb-embedder.service ~/.config/systemd/user/bbb-embedder.service
systemctl --user daemon-reload
systemctl --user enable --now bbb-embedder

# 3. Verify (model load takes a few seconds)
curl -s http://127.0.0.1:8098/health          # {"status":"ok"}
curl -s http://127.0.0.1:8098/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"embedding","input":["task: search result | query: hello"]}'
# → {"data":[{"index":0,"embedding":[…768 floats…]}], …}
```

Memory: `MemoryMax=3G` guards the unit (measured peak ~1.1G with
`--ubatch-size 2048`; ~2.1G headroom, bounded — see §5). Embedding output is
768-dim, L2-normalized (so cosine ordering == vec0 L2 ordering). `--parallel 1`
runs a single 2048-token sequence slot; `--ubatch-size 2048` must equal the
context so no single doc exceeds the physical batch (see §5 — this is a
correctness requirement, not a tuning choice).

**Prompt contract:** EmbeddingGemma is asymmetric. The adapter's `EmbedClient`
prefixes every query with `task: search result | query:` and every document
with `title: none | text:` (each prefix ends with a trailing space — see
`EMBEDDINGGEMMA_QUERY_PREFIX` / `EMBEDDINGGEMMA_DOCUMENT_PREFIX`). Send raw
un-prefixed text and similarity quality silently degrades. Never bypass the
client.

## 4. Enabling dense in the adapter

Dense is OFF unless a caller passes explicit config — no env magic:

```ts
const adapter = new QmdAdapter({
  tenantId,
  exportDir,
  dense: {
    enabled: true,
    url: 'http://127.0.0.1:8098',
    // optional: timeoutMs (5000), indexPath, searchK (50),
    //           maxDocChars (2000), indexTimeoutMs (120000), batchSize (16)
  },
});
```

With `dense` absent or `enabled: false` the query path is byte-identical to
the lexical-only deterministic fusion (unit-tested).

## 5. The sidecar index — build, rebuild, staleness

- **What builds it:** `reindex(adapter)` (the CLI / canary / edge-daemon
  reindex primitive) now ends with `adapter.denseSync()` when the adapter has
  a dense arm — an incremental sweep of `kb-export` that embeds NEW/CHANGED
  docs only (keyed by content hash of the exact truncated text embedded, not
  mtime) and removes vanished ones.
- **Cost:** docs are truncated to `maxDocChars` (default **2000** — up to
  ~600+ tokens, inside the 2048-token context and the single `--parallel 1`
  slot); 93% of this corpus's docs exceed 1200 chars and the median is 2778
  bytes, so a 1200 cap would truncate away most of the body while 2000 captures
  the bulk of the median doc. Throughput ~0.53 s/doc (batched, `--parallel 1`);
  full-build wall-clock (17,295 docs): see the measured verdict in §9.
  Incremental syncs after a normal governance cycle embed only the handful of
  promoted/changed docs — seconds.
- **`--ubatch-size` is a CORRECTNESS knob, not a memory knob (load-bearing,
  learned the hard way):** llama-server refuses any single embedding input
  longer than the physical batch — `input (586 tokens) is too large to process`.
  Real 2000-char docs tokenize to ~600+ tokens (token-dense docs approach the
  2048 context), so `--ubatch-size` MUST be ≥ the largest input. A `512` ubatch
  (tried as a memory saving) turned every long doc into a hard error that
  retry-stormed and aborted a full build after only 32 docs. `--ubatch-size
2048` (= the model context) guarantees any acceptable doc fits one physical
  batch. Do NOT shrink it to save memory.
- **Memory (measured):** `--ubatch-size 2048` under `--parallel 1` peaks the
  cgroup at **~1.1G**; `MemoryMax` is **3G** (~2.1G headroom, bounded). The
  earlier 1.5G OOM was ubatch 2048 under `--parallel 2` (two slots) against the
  old 1.5G cap — the fix was raising the CAP to 3G and running one slot, not
  shrinking the ubatch. A full build never needs more than one batch's buffer at
  a time, so the peak is flat regardless of corpus size.
- **Resilience (load-bearing):** the indexer survives two failure classes so a
  multi-hour unattended build completes. (1) A failed batch is RETRIED with
  bounded exponential backoff (~45 s window), bridging a transient embedder
  crash + `Restart=on-failure` auto-restart. (2) When retries are exhausted, a
  health probe decides: service down → durable outage → abort the remainder as a
  stale index (fail-open); service UP → the batch is DATA-POISON (an input the
  server rejects) → skip just those docs and keep building. One bad doc can never
  strand the whole index — the exact failure that aborted the 32-doc build.
- **Embedder down during sync:** the sweep no-ops with `serviceDown: true` in
  the reindex report and the index stays stale. Stale means: dense keeps
  answering from yesterday's vectors (or none at all on a first build) while
  the lexical arms stay current — searches never fail, recall just loses the
  dense boost for un-embedded docs. The next successful sync picks up exactly
  the missing docs.
- **Rebuild from scratch:** delete `<qmd-index>/<tenant>/dense-vec.sqlite`
  and run a reindex. Safe at any time (derived data, outside backup scope).
- **Model bump auto-invalidation:** the index stores the pinned model file +
  weights hash; opening it under different weights wipes every vector
  automatically (embeddings from different models are not comparable).

## 6. Fail-open semantics (operator view)

- **Service down / crashed:** searches keep working on the lexical fusion.
  Fix at leisure; nothing pages.
- **Slow query-embed (timeout):** each affected query pays up to `timeoutMs`
  (default 5 s) and then serves the lexical fusion. A single query embed is
  ~50 ms warm, so a timeout means the service is wedged — restart it.
- **Weight-gate failure at start:** `systemctl --user status bbb-embedder`
  shows ExecStartPre failing on `sha256sum -c`. The GGUF on disk no longer
  matches the pin — do NOT bypass the gate; re-download the weight or
  investigate the mismatch. The service refusing to start is fail-closed by
  design; serving continues fail-open without it.
- **sqlite-vec extension cannot load** (e.g. missing platform package): the
  adapter constructs with no dense arm at all — lexical-only, no errors.

## 7. Disable / remove

```bash
systemctl --user disable --now bbb-embedder     # stop + no start at login
# optional full removal:
rm ~/.config/systemd/user/bbb-embedder.service && systemctl --user daemon-reload
# (leave ~/.local/lib/bbb/llama-server alone if bbb-reranker still uses it)
```

Callers with `dense.enabled: true` fail open to the lexical fusion the moment
the service stops — no config change is required to keep search up.

## 8. Upgrade

- **Runtime bump:** shared with the reranker — edit the three `PIN_` values in
  `scripts/install-llama-server.sh`, re-run it, restart BOTH services.
- **Weight bump:** update the `embedding` entry in `weights-manifest.ts` AND
  the pin file `~/.local/lib/bbb/embedder-weights.sha256` (same value, two
  gates), restart. The sidecar index self-invalidates via its stored weights
  hash and re-embeds on the next sync.

## 9. Measured verdict (2026-07-20, B4 ship gate) — PASS

The B4 ship order requires dense to be judged on the `governed-brain-v1`
frozen anchor BEFORE any default wiring (same discipline as the reranker's
044-AT-DECR gate). Measured on the dev box (dense A/B arm of
`GOVERNED_EVAL_DENSE=1 eval:governed:local`, searchK 50, 2000-char docs,
curated scope, k=10; artifact `eval-results/governed-brain-v1-dense.json`).
Fused baseline = the shipping lexical RRF fusion (qmd BM25 + native FTS5);
dense = the same fusion with the EmbeddingGemma dense list joined as a third arm.

| stratum         | Recall@10 (fused → dense) | ΔRecall@10  | nDCG@10 (fused → dense) | ΔnDCG@10 | MRR (fused → dense) | ΔMRR    |
| --------------- | ------------------------- | ----------- | ----------------------- | -------- | ------------------- | ------- |
| lexical (n=14)  | 1.0000 → 1.0000           | +0.0000     | 0.9411 → 0.9265         | −0.0146  | 0.9286 → 0.9167     | −0.0119 |
| semantic (n=28) | 0.3393 → **0.9643**       | **+0.6250** | 0.3433 → 0.7704         | +0.4271  | 0.3571 → 0.7076     | +0.3504 |
| overall (n=42)  | 0.5595 → 0.9762           | +0.4167     | 0.5426 → 0.8224         | +0.2798  | 0.5476 → 0.7773     | +0.2297 |

**Gate verdict: PASS.** The gate asked for a material semantic-slice gain with
no lexical regression. Semantic Recall@10 nearly **tripled** (0.3393 → 0.9643,
+0.6250) — dense retrieves the paraphrase-matched gold documents that neither
lexical backend can surface, which is exactly the structural wall the reranker
could not move (050-AT-RNBK §9: 20/28 semantic queries retrieved ≤1 lexical
candidate — a reranker can only reorder what fusion found). Lexical Recall@10
held at 1.0000; the tiny lexical nDCG/MRR dips (−0.0146 / −0.0119) are
within-top-10 reordering as dense joins the fusion, not a recall loss, and are
below the epsilon that governs the gate.

### Corpus-coverage honesty (how this number was produced)

This verdict was measured against a **preserved dense index of 12,645 / 17,295
docs (73% overall)**. That is complete for what the eval actually measures: the
governed-brain-v1 queries run in the **default `curated` scope** (curated +
decisions + guides), and those collections were essentially fully embedded —
`kb-curated` 659, `kb-decisions` 38, `kb-guides` 10,086 — while only the
`kb-archive` tail (1,862 / 6,512) was partial. Archive is **out of the default
scope** (excluded inside the KNN by the vec0 collection partition key), and every
semantic gold document lives in the searched collections, so the partial archive
does not affect this measurement. The full-corpus embed was ~73% complete when
it was stopped; a full-corpus rebuild is expected to reproduce these numbers and
is now a cheap follow-up (see the index-reuse note below).

### Repeatability — index reuse

Embedding the full corpus takes ~2.5–3 h. `GOVERNED_EVAL_DENSE_PREBUILT=<path to
dense-vec.sqlite>` makes the anchor **reuse** a prebuilt index (copied into the
temp tenant dir, never mutated) and run only the ~minute-long 42-query verdict
phase — this verdict was produced that way against the preserved index at
`~/.teamkb/eval-anchor/dense-prebuilt/dense-vec.sqlite`. The verdict phase also
emits a per-query progress line (`[verdict] query i/42  N ms  top=…`) so a slow
or hung query phase is observable, never a silent black box.

### Posture (this PR) + recommendation

Dense EARNED default wiring on the semantic slice — unlike the reranker (a MISS,
kept opt-in). For THIS PR it nonetheless stays behind the explicit `dense` config
(fail-open, read-path-only, seam-firewalled: a `DenseScore` cannot become a
govern `DeterministicScore`), and the plugin does NOT wire it — a conservative
first landing. **Recommendation (tracked as a B4 follow-up):** the serving/plugin
path SHOULD enable dense-by-default given the measured **+0.63 semantic Recall@10**,
pending (a) a full-corpus rebuild that confirms these numbers over 17,295 docs
and (b) an embedder resource/latency check for the interactive path (a query
embed is ~0.4 s; the service is `MemoryMax`-bounded and loopback-only). Do not
flip the default silently — flip it on that evidence.
