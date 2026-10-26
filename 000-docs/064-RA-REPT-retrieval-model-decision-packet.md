---
title: Retrieval model decision packet
filing_code: 064-RA-REPT
date: 2026-10-26
status: proposed options; owner decision pending; no supersession
---

# Retrieval model decision packet

**Decision requested:** choose the model-policy direction and authorize its bounded
validation. This report does not adopt a model, supersede a decision record or
accept terms on behalf of intentsolutions.io LLC. Bead:
`compile-then-govern-eqw.11` in the Bob's Big Brain umbrella tracker.

## The conflict and the evidence

Source inspected at Registrar `1b59883748eb53c17984ee7bdf14c1d93f0de6c9`:

| Evidence                                                                                                              | What it establishes                                                                                                                                              | What it does not establish                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Decision 044](044-AT-DECR-wave0-retrieval-reconciliation.md), decision and license sections                          | Binding intent: reranker first, dense conditional on measurement, Apache/MIT weights only; EmbeddingGemma excluded. Supersession requires a later explicit DECR. | A later source implementation does not itself supersede this record.                                      |
| [Default configuration](../packages/qmd-adapter/src/config.ts), `getDefaultDenseConfig`                               | Production callers receive dense enabled unless the documented kill switch disables it. Library callers configure it explicitly.                                 | Installed release identity, host health or owner approval.                                                |
| [Weight manifest](../packages/qmd-adapter/src/weights/weights-manifest.ts), `embedding`                               | Names the EmbeddingGemma GGUF, size and SHA-256 below. Its comment still describes embedding as unshipped and awaiting qmd-version reconciliation.               | That comment is inconsistent with later source/runbook evidence; it is not evidence that dense is absent. |
| [Runbook 051](051-AT-RNBK-embedder-service-and-dense-index-runbook.md), sections 2 and 9                              | Records a July 20 on-disk hash check and a dated 42-query dense measurement; states remaining rollout evidence requirements.                                     | New host verification, full-corpus acceptance, a replacement model's quality or supersession of 044.      |
| [Embed client](../packages/qmd-adapter/src/dense/embed-client.ts) and [service unit](../scripts/bbb-embedder.service) | Model-specific query/document prefixes, mean pooling and normalization are part of the current serving contract.                                                 | Another embedding model being a drop-in replacement.                                                      |

No later superseding DECR was found in the checked-in decision corpus. Keep 038,
044 and the dated measurements intact; a future approved DECR must identify
exactly which model, license and ship-order clauses it supersedes.

## Exact artifact and primary terms

The manifest names `hf_ggml-org_embeddinggemma-300M-Q8_0.gguf`,
**333,590,944 bytes**, SHA-256
`b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63`.
Read-only upstream LFS metadata at conversion revision
`0f741b5a6585bd53aeb15cd1372c56f2a0f65e12` reports that same size and hash for
`embeddinggemma-300M-Q8_0.gguf`. This checks the published identity, not bytes in
an installed cache. No weight download or model invocation was performed.
[Conversion and original-model provenance](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/tree/0f741b5a6585bd53aeb15cd1372c56f2a0f65e12).

The [original Google 300M model card](https://huggingface.co/google/embeddinggemma-300m)
labels its license `gemma` and requires acceptance for original-repository access.
The conversion repository's public accessibility and missing license field in its
API metadata do not establish Apache/MIT permission. A newer model with a similar
name also does not establish the terms for these exact pinned bytes.

[Google's Gemma terms](https://ai.google.dev/gemma/terms/), last modified April 1,
2026, list EmbeddingGemma in their appendix. They cover hosted functionality as
distribution, require recipient terms and use-restriction flow-down, and require
an accompanying notice for non-hosted distribution. They incorporate a separate
[prohibited-use policy](https://ai.google.dev/gemma/prohibited_use_policy).
This identifies the contractual review needed; it does not conclude our current
use complies, that commercial use is categorically forbidden, or that the
repository code license grants weight permissions. Terms inspected October 26,
2026; recheck the exact artifact and terms when making the decision.

## Reviewable options

| Option                                                                  | Decision required                                                                                                                                            | Engineering and acceptance consequences                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Preserve Apache/MIT-only policy; evaluate Qwen3-Embedding-0.6B first | Authorize a bounded candidate evaluation, then choose promotion only from its evidence. This is the proposed evaluation direction, not an adopted migration. | Qwen's original card identifies Apache-2.0. Select an exact conversion/runtime and independent hash pins; implement its prompt/pooling/dimension contract. Rebuild a separate derived index and compare retrieval, latency and memory before production adoption. |
| B. Preserve that policy; evaluate BGE-M3                                | Authorize an alternative candidate evaluation.                                                                                                               | Original card identifies MIT. Its representation/runtime and index contract still need implementation and measurement; no July EmbeddingGemma result transfers to it.                                                                                             |
| C. Retain exact EmbeddingGemma-300M with an explicit policy exception   | Owner approves a later DECR superseding 044's exclusion and completes applicable terms/distribution review.                                                  | Retains the current model contract but still requires artifact provenance, deployment-specific compliance and fresh serving/rollout evidence. An architecture approval alone is not proof those obligations were met.                                             |
| D. Restore a lexical-only production posture                            | Owner explicitly authorizes disabling dense and accepts measured retrieval consequences.                                                                     | Keeps qmd BM25 plus native FTS5. Preserve the dense index for reversible recovery; do not silently stop the service, purge vectors or infer that available lexical fallback meets the dense quality floor.                                                        |

Original candidate cards, inspected October 26, 2026:
[Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3)
(Apache-2.0) and
[BGE-M3](https://huggingface.co/BAAI/bge-m3/tree/5617a9f61b028005a4858fdac845db406aefb181)
(MIT). These are original-repository metadata revisions, not selected GGUF hashes
or verified local-runtime artifacts. No candidate is downloaded or benchmarked.

**Recommendation for review:** option A's bounded evaluation preserves 044's
license intent while testing a dense candidate generator against the gap recorded
in 051. Do not claim it will match or beat the incumbent before measuring it.
Retaining the existing source during this report is an observation, not a new
exception approval; changing or disabling that source also requires the decision.

## Proposed validation and rollout boundary

The owner decision must identify the selected option, permitted corpus/snapshot,
resource and download budget, target host, approver and date. Candidate evaluation
is separate from authorization to rebuild the live index or deploy a service.

For A or B, the implementation must bind model identity, conversion revision,
weight hash/size, runtime hash, tokenizer, prefixes, pooling, normalization and
vector dimensions together. Preserve the current index; use a new isolated index
and verify that incompatible model/index identities cannot mix. Correct the
manifest's stale status/provenance wording using actual evidence, retaining the
historical capture dates.

Validate the changed serving boundary with the existing embed-client,
dense-index/indexer, adapter-dense, scope, config, weights and dense seam-firewall
suites. Exercise refused/malformed responses, absent service/index and mismatched
weights. Weight verification must refuse a mismatch while retrieval retains its
lexical fallback; a fallback pass does not establish candidate quality.
Run the repository's architecture and seam-independence gates unchanged.

Measure incumbent, lexical baseline, reranked-BM25 baseline and selected candidate
against the same frozen
`governed-brain-v1` labels and scope; report stratified Recall@10, nDCG@10 and MRR,
query latency and peak memory. Decision 044 requires comparison against
reranked-BM25; any change to that comparator or ship order needs explicit
supersession before candidate promotion. Separately run the current-answer/estate regression
surface; do not substitute the historical 42-query result for it. Fix acceptance
floors and resource bounds before the run, retaining failures and partial coverage.
051's historical semantic Recall@10 gain of 0.6250 is an incumbent observation,
not a candidate target already met or a current-host benchmark.

Only after decision, artifact review and gates pass may a separately authorized
rollout install its unit/pin file, build its derived index and activate serving.
Record exact source, release, installed artifact and host acceptance. Keep the
previous reviewed runtime/model/index tuple for rollback; restoring a different
model against the candidate index is not a valid rollback. Verify both retrieval
and model-free receipt checks after rollback. Do not alter governance scores,
policy, audit history, tenant isolation or the spool boundary for a model change.

## Current disposition

Owner choice, bounded evaluation authority and any superseding DECR remain
pending. This report changes documentation only. Bead `compile-then-govern-eqw.11`
remains open through the approved implementation, relevant gates and remote-state
verification; publishing this packet does not complete it.
