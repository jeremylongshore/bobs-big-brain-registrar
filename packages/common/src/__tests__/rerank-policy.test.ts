import { describe, it, expect } from 'vitest';
import {
  HISTORICAL_RECORD_FACTOR,
  LIFECYCLE_ARCHIVED_FACTOR,
  LIFECYCLE_DEPRECATED_FACTOR,
  computeRerankPolicyFactors,
  hasHistoryIntent,
  isHistoricalRecordTitle,
  lifecycleFactor,
} from '../rerank-policy.js';
import { rerankCitedHits, rerankSearchHits } from '../freshness.js';
import type { CitedHitMetadata } from '../freshness.js';

const NOW = '2026-10-04T00:00:00.000Z';

function daysAgo(days: number): string {
  return new Date(new Date(NOW).getTime() - days * 86_400_000).toISOString();
}

describe('lifecycleFactor', () => {
  it('demotes deprecated by 0.5', () => {
    expect(lifecycleFactor('deprecated')).toBe(LIFECYCLE_DEPRECATED_FACTOR);
    expect(LIFECYCLE_DEPRECATED_FACTOR).toBe(0.5);
  });
  it('demotes archived and superseded by 0.2', () => {
    expect(lifecycleFactor('archived')).toBe(LIFECYCLE_ARCHIVED_FACTOR);
    expect(lifecycleFactor('superseded')).toBe(0.2);
  });
  it('treats active, unknown and missing lifecycle as 1 (fail-open)', () => {
    expect(lifecycleFactor('active')).toBe(1);
    expect(lifecycleFactor('something-new')).toBe(1);
    expect(lifecycleFactor(undefined)).toBe(1);
  });
});

describe('isHistoricalRecordTitle', () => {
  it.each([
    'GCP Exodus AAR',
    'After-Action Report: VPS cutover',
    'after action review',
    'Backup incident post-mortem',
    'Postmortem of the OOM cascade',
    'Phase 3 retrospective',
    'Infra audit 2026-07',
    'Terraform Verification Report',
    'Weekly status report',
    'Session handoff',
    'Session hand-off notes',
    'Session summary 2026-08-01',
    'Changelog for v1.2',
    'Phase 4 report',
  ])('flags %s', (title) => {
    expect(isHistoricalRecordTitle(title)).toBe(true);
  });

  it.each([
    'GCP fully exited: estate torn down 2026-07-09',
    'Deploy to production via GitHub Actions',
    'Audit log hash chain design',
    'Audit trail format',
    'Terraform conventions',
    'Haar wavelet notes', // "aar" only matches on a word boundary
    'Shared handoffs protocol', // plural is not the bare word
    undefined,
    '',
  ])('does not flag %s', (title) => {
    expect(isHistoricalRecordTitle(title)).toBe(false);
  });
});

describe('hasHistoryIntent', () => {
  it.each([
    'gcp exodus history',
    'GCP exodus AAR',
    'vps postmortem',
    'vps post-mortem',
    'what happened to the backup',
    'changelog',
    'lessons learned',
    'lesson from outage',
    'retrospective',
    'why did we leave gcp',
    'deploy timeline',
  ])('detects %s', (q) => {
    expect(hasHistoryIntent(q)).toBe(true);
  });
  it.each(['GCP exodus', 'terraform setup gcp resources', 'deploy to production', '', undefined])(
    'does not detect %s',
    (q) => {
      expect(hasHistoryIntent(q)).toBe(false);
    },
  );
});

describe('computeRerankPolicyFactors', () => {
  it('explains each factor and the product', () => {
    const f = computeRerankPolicyFactors({ title: 'Infra audit', lifecycle: 'deprecated' }, 'gcp');
    expect(f).toEqual({
      lifecycle: 0.5,
      historical: HISTORICAL_RECORD_FACTOR,
      product: 0.5 * HISTORICAL_RECORD_FACTOR,
    });
  });
  it('skips the historical factor with no query', () => {
    expect(computeRerankPolicyFactors({ title: 'Infra audit' }).product).toBe(1);
  });
  it('skips the historical factor on history intent but keeps lifecycle', () => {
    const f = computeRerankPolicyFactors({ title: 'Infra audit', lifecycle: 'deprecated' }, 'aar');
    expect(f.historical).toBe(1);
    expect(f.lifecycle).toBe(0.5);
  });
});

// ── The real scenario, via the cited path the production API uses ──────────
interface Doc {
  id: string;
  file: string;
  score: number;
  meta: CitedHitMetadata;
}

function doc(id: string, score: number, meta: CitedHitMetadata): Doc {
  return { id, file: `qmd://kb-curated/${id}.md`, score, meta };
}

/** Imported AAR/audit docs carry import-time updatedAt (recent) and a strong lexical match. */
const DECISION = doc('decision', 0.9, {
  category: 'decision',
  updatedAt: daysAgo(30),
  title: 'GCP fully exited: estate torn down 2026-07-09, all hosting on the Contabo VPS',
  lifecycle: 'active',
});
const AAR = doc('aar', 1.0, {
  category: 'troubleshooting',
  updatedAt: daysAgo(10),
  title: 'GCP exodus AAR and Terraform teardown audit',
  lifecycle: 'active',
});
const STATUS = doc('status', 0.95, {
  category: 'troubleshooting',
  updatedAt: daysAgo(10),
  title: 'Deploy status report: Terraform GCP resources phase 2 report',
  lifecycle: 'active',
});
const DEPRECATED_REF = doc('depref', 1.0, {
  category: 'reference',
  updatedAt: daysAgo(5),
  title: 'Terraform GCP resource reference',
  lifecycle: 'deprecated',
});

function rank(docs: Doc[], query: string | undefined): string[] {
  const byId = new Map(docs.map((d) => [d.id, d.meta]));
  const hits = docs.map(({ file, score }) => ({ file, score }));
  const opts = query === undefined ? {} : { query };
  return rerankCitedHits(hits, (id) => byId.get(id) ?? null, NOW, 90, opts).map(
    (h) => h.memoryId ?? '?',
  );
}

describe('real scenario: current decision vs historical AAR vs deprecated reference', () => {
  const docs = [AAR, STATUS, DEPRECATED_REF, DECISION];

  it('baseline (no query = pre-policy ranking): the AAR beats the decision', () => {
    // This is the bug being fixed; also proves no-query callers are unchanged.
    // depref's lifecycle still applies without a query (always-on factor).
    const order = rank(docs, undefined);
    expect(order.indexOf('aar')).toBeLessThan(order.indexOf('decision'));
  });

  it.each(['GCP exodus', 'terraform setup gcp resources', 'deploy to production'])(
    'puts the decision first for "%s"',
    (query) => {
      const order = rank(docs, query);
      expect(order[0]).toBe('decision');
      expect(order.indexOf('decision')).toBeLessThan(order.indexOf('aar'));
      expect(order.indexOf('decision')).toBeLessThan(order.indexOf('status'));
      // deprecated reference (raw 1.0, fresh) falls below the active decision
      expect(order.indexOf('decision')).toBeLessThan(order.indexOf('depref'));
    },
  );

  it('does not demote the AAR when the query signals history', () => {
    for (const query of ['GCP exodus AAR', 'what happened with the gcp exodus', 'gcp lessons']) {
      const order = rank(docs, query);
      expect(order.indexOf('aar')).toBeLessThan(order.indexOf('decision'));
    }
  });

  it('still demotes a deprecated memory even on a history query', () => {
    const active = { ...DEPRECATED_REF, id: 'active-ref', file: 'qmd://kb-curated/active-ref.md' };
    active.meta = { ...DEPRECATED_REF.meta, lifecycle: 'active' };
    const order = rank([DEPRECATED_REF, active], 'gcp history');
    expect(order).toEqual(['active-ref', 'depref']);
  });
});

describe('fail-open and unchanged behavior', () => {
  it('resolver without title/lifecycle behaves like before the policy', () => {
    const bare: CitedHitMetadata = { category: 'decision', updatedAt: daysAgo(30) };
    const withQuery = rerankCitedHits([{ file: 'qmd://c/x.md', score: 0.7 }], () => bare, NOW, 90, {
      query: 'deploy to production',
    });
    const without = rerankCitedHits([{ file: 'qmd://c/x.md', score: 0.7 }], () => bare, NOW);
    expect(withQuery[0]!.finalScore).toBe(without[0]!.finalScore);
  });

  it('unresolvable citations are unaffected by the policy', () => {
    const [h] = rerankCitedHits([{ file: 'qmd://c/gone.md', score: 0.5 }], () => null, NOW, 90, {
      query: 'audit',
    });
    expect(h!.finalScore).toBe(0.5);
  });

  it('rerankSearchHits without title/lifecycle/query is numerically identical to the old formula', () => {
    const hits = [
      { score: 0.9, category: 'decision', updatedAt: daysAgo(30) },
      { score: 0.6, category: 'reference', updatedAt: daysAgo(200) },
    ];
    const out = rerankSearchHits(hits, NOW);
    const expected = hits.map(
      (h) =>
        Math.round(
          h.score *
            Math.exp((-Math.LN2 / 90) * (h.category === 'decision' ? 30 : 200)) *
            (h.category === 'decision' ? 1.2 : 0.9) *
            1000,
        ) / 1000,
    );
    expect(out.map((h) => h.finalScore)).toEqual(expected);
  });

  it('a history-titled hit with no query is not demoted by the title rule', () => {
    const hit = { score: 0.8, category: 'troubleshooting', updatedAt: NOW, title: 'Infra AAR' };
    expect(rerankSearchHits([hit], NOW)[0]!.finalScore).toBe(0.8);
    expect(rerankSearchHits([hit], NOW, 90, { query: 'deploy' })[0]!.finalScore).toBe(0.56);
  });

  it('keeps input order for equal final scores (stable) and is deterministic', () => {
    const mk = (id: string) => ({
      id,
      score: 0.5,
      category: 'pattern',
      updatedAt: NOW,
      title: 'Plain title',
    });
    const hits = ['a', 'b', 'c', 'd'].map(mk);
    const once = rerankSearchHits(hits, NOW, 90, { query: 'q' }).map((h) => h.id);
    const twice = rerankSearchHits(hits, NOW, 90, { query: 'q' }).map((h) => h.id);
    expect(once).toEqual(['a', 'b', 'c', 'd']);
    expect(twice).toEqual(once);
  });

  it('applies lifecycle multipliers numerically', () => {
    const base = { score: 1, category: 'troubleshooting', updatedAt: NOW };
    const out = rerankSearchHits(
      [
        { ...base, lifecycle: 'deprecated' },
        { ...base, lifecycle: 'archived' },
        { ...base, lifecycle: 'superseded' },
        { ...base, lifecycle: 'active' },
      ],
      NOW,
    );
    expect(out.map((h) => h.finalScore)).toEqual([1, 0.5, 0.2, 0.2]);
    expect(out.map((h) => h.lifecycle)).toEqual(['active', 'deprecated', 'archived', 'superseded']);
  });
});

describe('documented limit of the 0.7 weight', () => {
  it('a historical hit with a much stronger match and a far fresher date can still win', () => {
    // The policy is a nudge, not a ban: decision 0.6 raw / 90d old vs AAR 1.0 raw / 5d old.
    const old = doc('old-decision', 0.6, {
      category: 'decision',
      updatedAt: daysAgo(90),
      title: 'Hosting decision',
    });
    const aar = doc('late-aar', 1.0, {
      category: 'troubleshooting',
      updatedAt: daysAgo(5),
      title: 'Hosting AAR',
    });
    expect(rank([old, aar], 'hosting')[0]).toBe('late-aar');
  });
});
