# Reranker Service Runbook — `bbb-reranker` (B1)

**Doc:** 046-AT-RNBK · **Status:** Active · **Date:** 2026-07-19
**Scope:** the local cross-encoder rerank runtime (llama.cpp `llama-server` + Qwen3-Reranker-0.6B) and the adapter stage that consumes it.
**Decision record:** [`044-AT-DECR`](044-AT-DECR-wave0-retrieval-reconciliation.md) (Wave-0, reranker-first). Seam firewall: B2 (`packages/policy-engine/src/deterministic-score.ts`).

## 1. What this is

An OPT-IN retrieval-quality stage. After the deterministic RRF fusion in
`QmdAdapter.query()`, the top-50 fused hits can be re-ordered by a local
cross-encoder (Qwen3-Reranker-0.6B, Apache-2.0, GGUF q8_0) and truncated to the
top-8. The model runs as a loopback-only systemd **user** service; nothing
external is ever in the serving path.

**The one invariant to remember: rerank FAILS OPEN.** Service down, timeout,
non-200, bad JSON, unreadable export file, corrupt cache — every failure serves
the original fused deterministic order. Killing this service degrades ranking
quality; it can never break search. The model proposes an ordering; it never
owns durable state (rerank scores are type-branded `RerankScore` and cannot be
assigned into govern's `DeterministicScore` — enforced by tsc + a
dependency-cruiser rule).

## 2. Components

| Piece          | Where                                                                                           | Pinned by                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Runtime binary | `~/.local/lib/bbb/llama-server/current/llama-server` (llama.cpp release `b10068`)               | SHA-256 in `scripts/install-llama-server.sh` (`6bf3d20d…4be4eb2`), verified fail-closed before install                      |
| Model weights  | `~/.cache/qmd/models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf` (639,153,184 bytes)             | SHA-256 `22c9979c…429a48` in `weights-manifest.ts` (id `reranker`); re-verified on disk 2026-07-19                          |
| Service unit   | `~/.config/systemd/user/bbb-reranker.service` (source of truth: `scripts/bbb-reranker.service`) | ExecStartPre `sha256sum -c ~/.local/lib/bbb/reranker-weights.sha256` — the manifest pin restated where systemd can check it |
| Endpoint       | `http://127.0.0.1:8097/v1/rerank` (+ `/health`)                                                 | loopback only; port 8097 chosen free in the 8090–8199 range, avoiding 8090/8091/8787 (forms-api / scott-note-api / mandy)   |
| Adapter stage  | `packages/qmd-adapter/src/rerank/`                                                              | opt-in via `QmdAdapterConfig.rerank`                                                                                        |
| Score cache    | `<qmd-index>/<tenant>/rerank-cache.sqlite`                                                      | derived data — deletable at any time                                                                                        |

Weight-gate design choice: the unit uses a `sha256sum -c` pin file rather than
invoking the compiled `assertWeightsVerified` from a repo checkout, because a
service must not depend on a checkout's build state (`dist/` may be stale or
absent). The pin file's hash IS the manifest constant — keep the two in
lock-step on any weight bump (nothing asserts their equality automatically;
the upgrade checklist in §8 is the guard).

## 3. Install / start

```bash
# 1. Install the pinned runtime (idempotent; fail-closed on hash mismatch)
bash scripts/install-llama-server.sh

# 2. Install the weight-gate pin file + unit
mkdir -p ~/.local/lib/bbb
printf '%s  %s\n' \
  22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48 \
  "$HOME/.cache/qmd/models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf" \
  > ~/.local/lib/bbb/reranker-weights.sha256
cp scripts/bbb-reranker.service ~/.config/systemd/user/bbb-reranker.service
systemctl --user daemon-reload
systemctl --user enable --now bbb-reranker

# 3. Verify (model load takes a few seconds)
curl -s http://127.0.0.1:8097/health          # {"status":"ok"}
curl -s http://127.0.0.1:8097/v1/rerank \
  -H 'Content-Type: application/json' \
  -d '{"model":"q","query":"capital of France","documents":["Paris is the capital of France.","Bananas are yellow."]}'
# → {"results":[{"index":0,"relevance_score":0.99…},{"index":1,"relevance_score":…}]}
```

Memory: `MemoryMax=2G` guards the unit (model ~640 MB + buffers; typical RSS
well under 1 GiB). `--threads 4` keeps it polite on the shared dev box.

## 4. Enabling rerank in the adapter

Rerank is OFF unless a caller passes explicit config — no env magic:

```ts
const adapter = new QmdAdapter({
  tenantId,
  exportDir,
  rerank: {
    enabled: true,
    url: 'http://127.0.0.1:8097',
    // optional: timeoutMs (3000), candidateWindow (50), topN (8), cachePath
  },
});
```

With `rerank` absent or `enabled: false` the query path is byte-identical to
the pre-B1 deterministic fusion.

## 5. Fail-open semantics (operator view)

- **Service down / crashed:** searches keep working on the fused order. Fix at
  leisure; nothing pages.
- **Slow model (timeout):** each affected query pays up to `timeoutMs` (default
  3 s) and then serves the fused order. If that latency is unacceptable,
  disable (below) rather than tuning under pressure.
- **Weight-gate failure at start:** `systemctl --user status bbb-reranker`
  shows ExecStartPre failing on `sha256sum -c`. That means the GGUF on disk no
  longer matches the pin — do NOT bypass the gate; re-download the weight or
  investigate the mismatch. The service refusing to start is fail-closed by
  design; serving continues fail-open without it.

## 6. Score cache

Content-addressed sidecar at `<qmd-index>/<tenant>/rerank-cache.sqlite`:
`key = sha256(query + '\0' + sha256(docText))`, namespaced by model file +
pinned weights hash — so a model bump auto-invalidates every prior score.

- **Rebuild:** delete the file; it repopulates on cache misses. Safe at any
  time (it is derived data, never authoritative, outside backup scope).
- **Corruption:** the adapter degrades to uncached calls automatically; delete
  the file when convenient.

## 7. Disable / remove

```bash
systemctl --user disable --now bbb-reranker     # stop + no start at login
# optional full removal:
rm ~/.config/systemd/user/bbb-reranker.service && systemctl --user daemon-reload
rm -rf ~/.local/lib/bbb/llama-server            # pinned runtime versions
```

Callers with `rerank.enabled: true` fail open to fused order the moment the
service stops — no config change is required to keep search up.

## 8. Upgrade

- **Runtime bump:** edit the three `PIN_` values in
  `scripts/install-llama-server.sh` (new tag, asset, sha256 computed from a
  download you verified), re-run it, `systemctl --user restart bbb-reranker`.
- **Weight bump:** update the `reranker` entry in `weights-manifest.ts` AND the
  pin file `~/.local/lib/bbb/reranker-weights.sha256` (same value, two gates),
  restart. The score cache self-invalidates via the model_version column.
