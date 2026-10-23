import type { EvalDataset } from '../eval-types.js';

/** Synthetic strict-scope contract, separate from question fallback and estate labels. */
export const STRICT_SCOPED_V1_CORPUS = [
  { id: 'archive', collection: 'kb-archive', content: 'tokens '.repeat(10) },
  {
    id: 'current-guide',
    collection: 'kb-curated',
    content: 'tokens ' + 'padding '.repeat(1000),
  },
];

export const STRICT_SCOPED_V1_DATASET: EvalDataset = {
  name: 'strict-scoped-v1',
  idSpace: 'synthetic document id',
  queries: [{ id: 'ss1', kind: 'lexical', query: 'tokens', relevant: ['current-guide'] }],
};

/** K=1, curated scope; these values characterize this one-query fixture only. */
export const STRICT_SCOPED_V1_BASELINE = {
  legacyRecallAtK: 0,
  scopedRecallAtK: 1,
  scopedNdcgAtK: 1,
  scopedFamaAtK: 1,
};
