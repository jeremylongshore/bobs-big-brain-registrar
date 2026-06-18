import type { EvalDataset } from '../eval-types.js';

/**
 * SEED / TEMPLATE eval dataset (bead 0t9.6).
 *
 * This is a SHAPE + starter, not the real benchmark. To gate BM25 vs the native
 * semantic backend (0t9.3) you need 30–50 real queries over an ACTUAL corpus with
 * hand-labeled gold `qmd://` citations — drawn from real second-brain usage, not
 * invented. Replace `relevant` with the true citations from your corpus and grow
 * the set, then run `runEval(dataset, retrieve, { k: 10 })` against each backend.
 *
 * The queries below deliberately span the two classes that decide the verdict
 * (Nils Reimers' point): `lexical` queries (exact terms / names / code) where BM25
 * is strong, and `semantic` queries (paraphrase / concept) where keyword search
 * silently misses and dense retrieval earns its footprint. A useful real set is
 * weighted toward the semantic class — that's where the recall wall shows up.
 *
 * The `relevant` ids here are placeholders (`qmd://example/...`) so the harness is
 * runnable end-to-end against a mock backend in tests; they are NOT real corpus docs.
 */
export const SEED_EVAL_DATASET: EvalDataset = {
  name: 'governed-second-brain-seed',
  idSpace: 'qmd:// citation',
  queries: [
    {
      id: 'q1',
      kind: 'lexical',
      query: 'EmbeddingGemma-300M MTEB score',
      relevant: ['qmd://example/embeddinggemma.md'],
      notes: 'exact model name + metric — BM25 should nail this',
    },
    {
      id: 'q2',
      kind: 'semantic',
      query: 'how do I make the brain forget something outdated',
      relevant: ['qmd://example/lifecycle-transitions.md'],
      notes: 'paraphrase of "retire/deprecate a memory" — BM25 likely misses',
    },
    {
      id: 'q3',
      kind: 'semantic',
      query: 'proving nobody tampered with the record after the fact',
      relevant: ['qmd://example/audit-anchor.md', 'qmd://example/hash-chain.md'],
      notes: 'concept query → the tamper-evidence docs; two gold docs',
    },
    {
      id: 'q4',
      kind: 'lexical',
      query: 'qmd query hybrid reranking',
      relevant: ['qmd://example/qmd-retrieval.md'],
      notes: 'exact qmd terms',
    },
    {
      id: 'q5',
      kind: 'semantic',
      query: 'why is the model not allowed to write to durable storage directly',
      relevant: ['qmd://example/compile-then-govern-thesis.md'],
      notes: 'the propose-vs-dispose thesis, asked in plain language',
    },
  ],
};
