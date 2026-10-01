import { describe, it, expect } from 'vitest';
import {
  planSupersession,
  detectSupersession,
  AUTHORITATIVE_CATEGORIES,
  DEFAULT_MAX_SUPERSEDES_PER_PROMOTION,
} from '../supersession/supersession-detector.js';
import type { SupersessionMemorySource } from '../supersession/supersession-detector.js';
import { makeCandidate, DEFAULT_TENANT } from './fixtures.js';

interface FakeMemory {
  id: string;
  title: string;
  category: string;
  tenantId?: string;
  lifecycle?: string;
  subjects?: string[];
  promotedAt?: string;
}

/** Records the (tenant, lifecycle) it is asked for, so the active/tenant scoping is asserted. */
function source(memories: FakeMemory[]): SupersessionMemorySource & {
  calls: Array<[string, string]>;
} {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    findByTenantAndLifecycle(tenantId, lifecycle) {
      calls.push([tenantId, lifecycle]);
      return memories
        .filter((m) => (m.tenantId ?? DEFAULT_TENANT) === tenantId)
        .filter((m) => (m.lifecycle ?? 'active') === lifecycle)
        .map((m) => ({
          id: m.id,
          title: m.title,
          category: m.category,
          ...(m.subjects !== undefined ? { metadata: { subjects: m.subjects } } : {}),
          ...(m.promotedAt !== undefined ? { promotedAt: m.promotedAt } : {}),
        }));
    },
  };
}

const cand = (
  category: 'decision' | 'reference' | 'pattern' | 'architecture' | 'convention',
  subjects: string[] | undefined,
  extra: { title?: string; capturedAt?: string; tenantId?: string } = {},
) =>
  makeCandidate({
    category,
    title: extra.title ?? 'Brand new unrelated headline',
    ...(extra.capturedAt !== undefined ? { capturedAt: extra.capturedAt } : {}),
    ...(extra.tenantId !== undefined ? { tenantId: extra.tenantId } : {}),
    metadata: { filePaths: [], tags: [], ...(subjects !== undefined ? { subjects } : {}) },
  });

describe('planSupersession — subject-keyed', () => {
  it('a decision retires a reference sharing its subject (cross-category) with ZERO title overlap', () => {
    const src = source([
      {
        id: 'ref-1',
        title: 'How we deploy on Cloud Run',
        category: 'reference',
        subjects: ['hosting.gcp'],
      },
    ]);
    const plan = planSupersession(
      cand('decision', ['hosting.gcp'], { title: 'Self-host everything on the VPS' }),
      src,
    );
    expect(plan.blocked).toBeUndefined();
    expect(plan.matches).toEqual([
      {
        supersededMemoryId: 'ref-1',
        supersededTitle: 'How we deploy on Cloud Run',
        similarity: 1,
        basis: 'subject',
        subject: 'hosting.gcp',
      },
    ]);
  });

  it('retires EVERY active memory on the subject, ordered by id for determinism', () => {
    const src = source([
      { id: 'b', title: 't1', category: 'reference', subjects: ['x'] },
      { id: 'a', title: 't2', category: 'pattern', subjects: ['x'] },
      { id: 'c', title: 't3', category: 'reference', subjects: ['y'] },
    ]);
    const plan = planSupersession(cand('decision', ['x']), src);
    expect(plan.matches.map((m) => m.supersededMemoryId)).toEqual(['a', 'b']);
  });

  it('a NON-authoritative candidate cannot retire a different category (a reference cannot retire a decision)', () => {
    const src = source([
      { id: 'dec-1', title: 'Use VPS', category: 'decision', subjects: ['hosting.gcp'] },
    ]);
    const plan = planSupersession(cand('reference', ['hosting.gcp']), src);
    expect(plan.matches).toEqual([]);
    expect(plan.blocked).toBeUndefined();
  });

  it('a non-authoritative candidate still retires within its OWN category by subject', () => {
    const src = source([
      { id: 'ref-1', title: 'old', category: 'reference', subjects: ['hosting.gcp'] },
    ]);
    const plan = planSupersession(cand('reference', ['hosting.gcp']), src);
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0]?.basis).toBe('subject');
  });

  it.each(['decision', 'architecture', 'convention'] as const)(
    '%s is authoritative and may retire across categories',
    (category) => {
      expect(AUTHORITATIVE_CATEGORIES.has(category)).toBe(true);
      const src = source([{ id: 'r', title: 'zzz', category: 'troubleshooting', subjects: ['s'] }]);
      expect(planSupersession(cand(category, ['s']), src).matches).toHaveLength(1);
    },
  );

  it('reference and pattern are not authoritative', () => {
    expect(AUTHORITATIVE_CATEGORIES.has('reference')).toBe(false);
    expect(AUTHORITATIVE_CATEGORIES.has('pattern')).toBe(false);
  });

  it('matches on ANY shared subject and reports the lexically first shared one', () => {
    const src = source([
      { id: 'm', title: 'zzz', category: 'reference', subjects: ['b', 'a', 'q'] },
    ]);
    const plan = planSupersession(cand('decision', ['b', 'a', 'other']), src);
    expect(plan.matches[0]?.subject).toBe('a');
  });

  it('does NOT match a memory with no subject keys, or a different subject (exact identity, no prefix match)', () => {
    const src = source([
      { id: 'none', title: 'zzz one', category: 'reference' },
      { id: 'empty', title: 'zzz two', category: 'reference', subjects: [] },
      { id: 'prefix', title: 'zzz three', category: 'reference', subjects: ['hosting.gcp.run'] },
      { id: 'sub', title: 'zzz four', category: 'reference', subjects: ['hosting'] },
    ]);
    expect(planSupersession(cand('decision', ['hosting.gcp']), src).matches).toEqual([]);
  });

  it('is tenant-scoped and active-only (asks the source for exactly that)', () => {
    const src = source([
      {
        id: 'other-tenant',
        title: 'zzz',
        category: 'reference',
        subjects: ['s'],
        tenantId: 'team-beta',
      },
      { id: 'dead', title: 'zzz', category: 'reference', subjects: ['s'], lifecycle: 'superseded' },
    ]);
    const plan = planSupersession(cand('decision', ['s']), src);
    expect(plan.matches).toEqual([]);
    expect(src.calls).toEqual([[DEFAULT_TENANT, 'active']]);
  });

  describe('temporal guard', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    const t1 = '2026-02-01T00:00:00.000Z';
    const t2 = '2026-03-01T00:00:00.000Z';

    it('never retires a memory promoted AFTER the candidate was captured', () => {
      const src = source([
        { id: 'newer', title: 'zzz', category: 'reference', subjects: ['s'], promotedAt: t2 },
      ]);
      expect(planSupersession(cand('decision', ['s'], { capturedAt: t1 }), src).matches).toEqual(
        [],
      );
    });

    it('retires a memory promoted before, or exactly at, the candidate capture time', () => {
      const src = source([
        { id: 'older', title: 'zzz', category: 'reference', subjects: ['s'], promotedAt: t0 },
        { id: 'same', title: 'zzz', category: 'reference', subjects: ['s'], promotedAt: t1 },
      ]);
      const plan = planSupersession(cand('decision', ['s'], { capturedAt: t1 }), src);
      expect(plan.matches.map((m) => m.supersededMemoryId)).toEqual(['older', 'same']);
    });

    it('treats a missing promotedAt as eligible', () => {
      const src = source([{ id: 'u', title: 'zzz', category: 'reference', subjects: ['s'] }]);
      expect(planSupersession(cand('decision', ['s']), src).matches).toHaveLength(1);
    });
  });

  describe('mass-supersede guard', () => {
    const many = (n: number): FakeMemory[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `m${String(i).padStart(4, '0')}`,
        title: `memory ${i}`,
        category: 'reference',
        subjects: ['hosting.gcp'],
      }));

    it('the default cap is 25', () => {
      expect(DEFAULT_MAX_SUPERSEDES_PER_PROMOTION).toBe(25);
    });

    it('allows exactly the cap', () => {
      const plan = planSupersession(cand('decision', ['hosting.gcp']), source(many(25)));
      expect(plan.matches).toHaveLength(25);
      expect(plan.blocked).toBeUndefined();
    });

    it('BLOCKS cap+1: retires nothing and reports how many it would have', () => {
      const plan = planSupersession(cand('decision', ['hosting.gcp']), source(many(26)));
      expect(plan.matches).toEqual([]);
      expect(plan.blocked).toEqual({
        reason: 'cap_exceeded',
        wouldSupersede: 26,
        cap: 25,
        subjects: ['hosting.gcp'],
      });
    });

    it('a blocked subject match does NOT fall through to the title fallback', () => {
      const memories = [
        ...many(30),
        { id: 'dup', title: 'Self host on the VPS', category: 'decision' },
      ];
      const plan = planSupersession(
        cand('decision', ['hosting.gcp'], { title: 'Self host on the VPS' }),
        source(memories),
      );
      expect(plan.matches).toEqual([]);
      expect(plan.blocked?.wouldSupersede).toBe(30);
    });

    it('a larger maxSupersedes is the explicit opt-in', () => {
      const plan = planSupersession(cand('decision', ['hosting.gcp']), source(many(40)), {
        maxSupersedes: 40,
      });
      expect(plan.matches).toHaveLength(40);
      expect(plan.blocked).toBeUndefined();
    });

    it('maxSupersedes: 0 retires nothing on any subject match', () => {
      const plan = planSupersession(cand('decision', ['hosting.gcp']), source(many(1)), {
        maxSupersedes: 0,
      });
      expect(plan.matches).toEqual([]);
      expect(plan.blocked?.wouldSupersede).toBe(1);
    });

    it('lists blocked subjects sorted', () => {
      const memories = many(3).map((m) => ({ ...m, subjects: ['a', 'b'] }));
      const plan = planSupersession(cand('decision', ['b', 'a']), source(memories), {
        maxSupersedes: 1,
      });
      expect(plan.blocked?.subjects).toEqual(['a', 'b']);
    });
  });
});

describe('planSupersession — title fallback (legacy near-duplicate path)', () => {
  it('collapses a same-category near-duplicate when the candidate has no subject', () => {
    const src = source([{ id: 'old', title: 'Error handling convention', category: 'convention' }]);
    const plan = planSupersession(
      cand('convention', undefined, { title: 'Error handling convention' }),
      src,
    );
    expect(plan.matches).toEqual([
      {
        supersededMemoryId: 'old',
        supersededTitle: 'Error handling convention',
        similarity: 1,
        basis: 'title',
      },
    ]);
  });

  it('falls back to title when the candidate HAS subjects but none match', () => {
    const src = source([
      {
        id: 'old',
        title: 'Error handling convention',
        category: 'convention',
        subjects: ['other'],
      },
    ]);
    const plan = planSupersession(
      cand('convention', ['mine'], { title: 'Error handling convention' }),
      src,
    );
    expect(plan.matches[0]?.basis).toBe('title');
  });

  it('title similarity NEVER crosses categories (the same-category rule survives for the fallback)', () => {
    const src = source([{ id: 'old', title: 'Error handling convention', category: 'reference' }]);
    const plan = planSupersession(
      cand('decision', undefined, { title: 'Error handling convention' }),
      src,
    );
    expect(plan.matches).toEqual([]);
  });

  it('picks the highest-similarity memory, first-found on ties', () => {
    const src = source([
      { id: 'low', title: 'alpha beta gamma delta', category: 'pattern' },
      { id: 'high', title: 'alpha beta gamma', category: 'pattern' },
      { id: 'tie', title: 'alpha beta gamma', category: 'pattern' },
    ]);
    const plan = planSupersession(cand('pattern', undefined, { title: 'alpha beta gamma' }), src);
    expect(plan.matches.map((m) => m.supersededMemoryId)).toEqual(['high']);
  });

  it('honours the threshold option (inclusive at the boundary)', () => {
    const src = source([{ id: 'old', title: 'a b c d', category: 'pattern' }]);
    const c = cand('pattern', undefined, { title: 'a b c e' }); // jaccard 3/5 = 0.6
    expect(planSupersession(c, src, { threshold: 0.6 }).matches).toHaveLength(1);
    expect(planSupersession(c, src, { threshold: 0.61 }).matches).toEqual([]);
  });

  it('returns an empty plan for an empty store', () => {
    expect(planSupersession(cand('decision', ['s']), source([]))).toEqual({ matches: [] });
  });
});

describe('detectSupersession (single-match wrapper)', () => {
  it('returns the first planned match, or null', () => {
    const src = source([{ id: 'r', title: 'zzz', category: 'reference', subjects: ['s'] }]);
    expect(detectSupersession(cand('decision', ['s']), src)?.supersededMemoryId).toBe('r');
    expect(detectSupersession(cand('decision', ['nope']), src)).toBeNull();
  });

  it('forwards the threshold to the title fallback', () => {
    const src = source([{ id: 'old', title: 'a b c d', category: 'pattern' }]);
    const c = cand('pattern', undefined, { title: 'a b c e' });
    expect(detectSupersession(c, src, 0.6)).not.toBeNull();
    expect(detectSupersession(c, src, 0.7)).toBeNull();
  });
});
