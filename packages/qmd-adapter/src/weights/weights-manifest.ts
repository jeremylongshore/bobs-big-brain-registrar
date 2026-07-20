import type { WeightsManifest } from './verify-weights.js';

/**
 * Pinned SHA-256 hashes of qmd's GGUF retrieval-model weights — the integrity
 * "receipts" for the retrieval brain. `assertWeightsVerified` checks the on-disk
 * weights against these before any semantic path uses them, failing closed on a
 * mismatch.
 *
 * Hashes were captured from the qmd model cache (`~/.cache/qmd/models`). Hugging
 * Face artifacts are immutable, so the SHA-256 is the canonical pin.
 *
 * CAVEAT (embedding + query-expansion): captured under qmd 2.0.1's downloads,
 * while the canonical pin is `@tobilu/qmd` 2.5.3 (see `gsb.lock.json` + this
 * package). Re-confirm those two against 2.5.3's model set when the semantic
 * backend (bead 0t9.3) ships — they remain UNSHIPPED and unexercised. The
 * verification primitive is correct regardless of which values are pinned;
 * only the pinned values need confirming.
 *
 * The 'reranker' entry does NOT carry that caveat: its on-disk GGUF was
 * re-hashed on 2026-07-19 during the B1 build and matches this pin exactly
 * (sha256 22c9979c…, 639153184 bytes). The same pin gates the serving path
 * twice — `bbb-reranker.service` ExecStartPre (sha256sum -c before llama-server
 * loads the model) and this manifest via assertWeightsVerified.
 */
export const QMD_WEIGHTS_MANIFEST: WeightsManifest = {
  schemaVersion: 1,
  qmd: { npmPackage: '@tobilu/qmd', version: '2.5.3' },
  note: 'Embedding + query-expansion hashes captured under qmd 2.0.1; re-confirm against the canonical 2.5.3 model set before the semantic path ships (bead 0t9.3). The reranker hash was re-verified against the on-disk GGUF on 2026-07-19 (B1) and is actively served by bbb-reranker.service.',
  models: [
    {
      id: 'embedding',
      role: 'embedding',
      file: 'hf_ggml-org_embeddinggemma-300M-Q8_0.gguf',
      sha256: 'b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63',
      size: 333590944,
      hfRepo: 'ggml-org/embeddinggemma-300M-GGUF',
    },
    {
      id: 'reranker',
      role: 'reranker',
      file: 'hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf',
      sha256: '22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48',
      size: 639153184,
      hfRepo: 'ggml-org/qwen3-reranker-0.6B-GGUF',
    },
    {
      id: 'query-expansion',
      role: 'query-expansion',
      file: 'hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf',
      sha256: '000dfb1c06efa6a049e9f64ba921c3740e2454f62abab6fa10e77bd30bb2bcc0',
      size: 1282438912,
      hfRepo: 'tobil/qmd-query-expansion-1.7B-GGUF',
    },
  ],
};
