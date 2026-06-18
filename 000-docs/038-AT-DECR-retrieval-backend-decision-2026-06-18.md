---
title: 'Governed Second Brain — Retrieval Backend Decision (Thinker-Canon Council)'
filing_code: 038-AT-DECR
date: 2026-06-18
acting_head_of_board: Jeremy Longshore (Intent Solutions)
council: 'thinker-canon: Ken Thompson, Rich Hickey, DHH, Chip Huyen, Linus Torvalds, Martin Fowler + ml-intern, nils-reimers (ML practitioners)'
parent_bead_intkb: qmd-team-intent-kb-0t9
related_beads: 'qmd-team-intent-kb-0t9.1..0t9.6; compile-then-govern-qy7.13 (folded here)'
github: jeremylongshore/qmd-team-intent-kb#170
plane: INTKB-7
status: binding decision record — supersedes only by explicit later DECR
license: Apache-2.0
---

# Governed Second Brain — Retrieval Backend Decision

## 0. Context

The Governed Second Brain (the public `governed-second-brain` plugin + the ICO/INTKB
engines) turns a user's files into governed, `qmd://`-cited memory: **compile** (ICO, one
LLM call) → **govern** (INTKB, deterministic dedupe/policy/promote + a SHA-256 hash-chained,
externally-anchored audit trail) → **retrieve**. The retrieve layer was the open decision.

Retrieval today: `brain_search` → `qmd search` = **BM25 keyword only** (verified at
`packages/qmd-adapter/src/search/search-client.ts:22`). Zero ML, works end-to-end (cited
hits verified). `qmd` (tobi, MIT) is an external Bun binary on `PATH` — a hard runtime dep.

`qmd`'s richer mode `qmd query` ("hybrid") runs **node-llama-cpp** with **~2.2 GB of GGUF
models** (`embeddinggemma-300M-Q8` 319 MB + `qwen3-reranker-0.6b` 610 MB + a
`query-expansion-1.7B` **1.2 GB**), local, no API key.

## 1. Options considered

- **A — BM25-on-qmd (status quo).** Keyword only; zero ML; qmd binary hard dep.
- **B — qmd hybrid.** Semantic via qmd's 2.2 GB GGUF stack; qmd owns the ML; _not wired in
  the IS adapter today._
- **C — native FTS5 + sqlite-vec** behind the existing adapter seam (in-process, no binary).
- **D — reuse the NEXUS local RAG app** (LangChain + ChromaDB + Ollama, Python, stale).

## 2. Decision

**Sequence: A now → build a retrieval eval → lean-C. Skip B. Reject D. Cut the selector.**

1. **Ship A (BM25-on-qmd) now** — it is the only wired path and it works.
2. **Pin the qmd binary + every GGUF weight by SHA-256, fail closed** — _before any semantic
   path ships_ (`0t9.5`, P1). This is non-negotiable (§4).
3. **Build a 30–50 real-query eval** (Recall@10 + nDCG@10) to gate A-vs-C with measured
   numbers (`0t9.6`).
4. **Then lean-C** — a native **sqlite-vec** semantic backend on **EmbeddingGemma-300M only
   (~320 MB)**, _dropping_ qmd's 1.7 B query-expander and 0.6 B reranker, behind the existing
   adapter seam (`0t9.3`, blocked on `0t9.5` + `0t9.6`). This is leaner than B **and** drops
   the Bun binary dep. `0t9.2` (native FTS5) supplies the model-free keyword half.
5. **Cut the qmd|native config selector** (`0t9.4`) — the mock/real `QmdExecutor` seam already
   provides selection; a config matrix is ceremony for a swap no consumer asked for.
6. **Reject NEXUS (D)** — adopting a 3-month-stale LangChain/Chroma/Ollama stack imports debt.

`compile-then-govern-qy7.13` (the plugin's semantic-recall upgrade) lands via the rescoped
`0t9.3` — **not** by enabling qmd's heavy hybrid.

## 3. Rationale (council synthesis)

Six architecture canons split A-camp (Hickey/Linus/Fowler: ship A, the adapter seam makes
C reversible, defer semantic until a paying user hits BM25's wall) vs B-camp (Ken/DHH/Chip:
semantic _is_ the product, ship qmd hybrid). The **ml-intern** practitioner broke the tie with
verified facts:

- **EmbeddingGemma-300M is the best small open embedder** (MTEB v2 English **69.67**, highest
  under 500 M) — keep it; the bloat is the **1.7 GB expander + reranker**, which embedding-only
  retrieval discards for ~90 % of the value.
- **B is heavier _and_ unwired** — enabling qmd hybrid is real work that drags 2.2 GB onto an
  SMB laptop (cold-start + multi-GB RAM where 16 GB machines swap). Lean-C is **leaner than B**.
- **No eval set** means A-vs-C is faith, not arithmetic. Build the smallest real one first.

This honors the product thesis: keyword retrieval is deterministic and model-free; semantic is
a _different_, probabilistic thing — sequence them behind the seam, never complect the
embedding model into the durable governed-state layer (it stays on the "model proposes" side).

## 4. Non-negotiable — pin the model weights

Verified: INTKB's manifest hashes the **governance spool** but **nothing pins the retrieval
model weights**. A govern-by-receipts product whose retrieval brain is **2.2 GB of unsigned,
unpinned GGUF** has an integrity hole larger than the audit log it protects. Before any semantic
path ships, extend the existing SHA-256 manifest discipline to the qmd binary + every model
weight and **fail closed on mismatch** (`0t9.5`). This is the costliest thing to recover from —
not code, credibility.

## 5. Consequences

| Bead         | State                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `0t9` (epic) | Retitled to this decided direction                                                                |
| `0t9.1`      | This ADR (decision recorded)                                                                      |
| `0t9.2`      | Native FTS5 (keyword, model-free) — keep                                                          |
| `0t9.3`      | **Rescoped** → lean embedding-only sqlite-vec (EmbeddingGemma-300M); blocked on `0t9.5` + `0t9.6` |
| `0t9.4`      | **Cut** (selector ceremony)                                                                       |
| `0t9.5`      | **New (P1)** — pin qmd binary + GGUF weights, fail closed                                         |
| `0t9.6`      | **New** — 30–50 query Recall@10/nDCG@10 eval                                                      |

**Deferral trigger for `0t9.3`:** a paying user's logged query returns zero relevant `qmd://`
hits on a corpus they swear contains the answer, twice — _and_ the eval (`0t9.6`) shows BM25
below ~0.85 Recall@10.

**Reversibility:** the `QmdExecutor` seam makes A↔C an implementation detail; this whole decision
is cheap to revisit. **Forbidden** (consistent with the umbrella's audit-honesty rule):
tamper-proof, immutable, non-repudiation (local mode), blockchain.
