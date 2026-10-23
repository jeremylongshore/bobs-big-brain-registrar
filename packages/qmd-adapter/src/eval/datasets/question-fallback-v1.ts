import type { EvalDataset } from '../eval-types.js';

/** Synthetic fallback contract; independent of frozen estate questions/labels. */
export const QUESTION_FALLBACK_V1_CORPUS = [
  {
    id: 'tokens',
    collection: 'kb-curated',
    content: 'Access tokens remain in the credential vault.',
  },
  { id: 'alerts', collection: 'kb-curated', content: 'Email onboarding alerts.' },
  { id: 'deployment', collection: 'kb-curated', content: 'Cafe deployment handbook.' },
  { id: 'backups', collection: 'kb-curated', content: 'Database backups recovery runbook.' },
  {
    id: 'cache',
    collection: 'kb-curated',
    content: 'Cache eviction policy uses least recently accessed entries.',
  },
  { id: 'archive', collection: 'kb-archive', content: 'where are access tokens stored' },
];

export const QUESTION_FALLBACK_V1_DATASET: EvalDataset = {
  name: 'question-fallback-v1',
  idSpace: 'synthetic document id',
  queries: [
    { id: 'qf1', kind: 'lexical', query: 'where are access tokens stored', relevant: ['tokens'] },
    {
      id: 'qf2',
      kind: 'lexical',
      query: 'how do we configure email onboarding alerts',
      relevant: ['alerts'],
    },
    {
      id: 'qf3',
      kind: 'tokenization',
      query: 'where are café deployment settings',
      relevant: ['deployment'],
    },
    {
      id: 'qf4',
      kind: 'lexical',
      query: 'how can database backups be recovered',
      relevant: ['backups'],
    },
    { id: 'qf5', kind: 'lexical', query: 'what is our cache eviction policy', relevant: ['cache'] },
    {
      id: 'qf6',
      kind: 'semantic',
      query: 'how can we recover lost credentials',
      relevant: ['tokens'],
      notes:
        'Deliberate synonym miss: topical overlap is insufficient. Do not rewrite to make lexical retrieval pass.',
    },
  ],
};

/** K=10, curated scope. These floors characterize this tiny fixture only. */
export const QUESTION_FALLBACK_V1_BASELINE = {
  strictRecallAtK: 0,
  fallbackRecallAtK: 5 / 6,
  fallbackNdcgAtK: 5 / 6,
  fallbackFamaAtK: 5 / 6,
};
