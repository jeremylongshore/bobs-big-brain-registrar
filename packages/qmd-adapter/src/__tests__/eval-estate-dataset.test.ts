import { describe, it, expect } from 'vitest';
import {
  ESTATE_ONBOARDING_V1_DATASET,
  ESTATE_ONBOARDING_V1_GAPS,
} from '../eval/datasets/estate-onboarding-v1.js';

const CITATION = /^qmd:\/\/kb-(curated|decisions|guides)\/[0-9a-f-]{36}\.md$/;

describe('estate-onboarding-v1 dataset', () => {
  const queries = ESTATE_ONBOARDING_V1_DATASET.queries;

  it('has unique ids across queries and gaps', () => {
    const ids = [...queries.map((q) => q.id), ...ESTATE_ONBOARDING_V1_GAPS.map((g) => g.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('labels every scored query with at least one current doc', () => {
    for (const q of queries) expect(q.relevant.length, q.id).toBeGreaterThan(0);
  });

  it('uses only default-scope qmd:// citations', () => {
    for (const q of queries) {
      for (const id of [...q.relevant, ...(q.obsolete ?? [])]) expect(id, q.id).toMatch(CITATION);
    }
  });

  it('never labels one doc both current and obsolete for the same query', () => {
    for (const q of queries) {
      const valid = new Set(q.relevant);
      for (const id of q.obsolete ?? []) expect(valid.has(id), `${q.id} ${id}`).toBe(false);
    }
  });

  it('gives every gap a note saying what is missing', () => {
    for (const g of ESTATE_ONBOARDING_V1_GAPS) expect(g.notes.length, g.id).toBeGreaterThan(10);
  });

  it('cites gap answers as qmd:// docs and never as one of its own obsolete docs', () => {
    for (const g of ESTATE_ONBOARDING_V1_GAPS) {
      for (const c of g.answeredBy ?? []) {
        expect(c, g.id).toMatch(/^qmd:\/\/kb-[a-z]+\/[0-9a-f-]{36}\.md$/);
        expect(g.obsoleteSeen ?? [], g.id).not.toContain(c);
      }
    }
  });
});
