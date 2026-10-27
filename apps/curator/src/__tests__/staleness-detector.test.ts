import { describe, expect, it } from 'vitest';

import {
  detectStaleness,
  ESTATE_STALENESS_RULES,
  mentions,
  readsAsHistorical,
  type StalenessRule,
} from '../staleness/staleness-detector.js';

/**
 * Tests for evidence-linked staleness detection (bead `compile-then-govern-39z.2`).
 *
 * The central risk this suite guards is NOT "does it find gcloud". It is the
 * prescriptive-vs-historical distinction: a sweep that deprecates the memory
 * recording "GCP was torn down, never use it" would delete the estate's own
 * explanation of why GCP is gone — the exact answer the sweep exists to protect.
 */

type Subject = Parameters<typeof detectStaleness>[0];

function memory(overrides: Partial<Subject> = {}): Subject {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'A memory',
    content: 'Some content.',
    metadata: { filePaths: [], tags: [] },
    ...overrides,
  } as Subject;
}

describe('mentions — word-boundary token matching', () => {
  it('matches a token surrounded by non-word characters', () => {
    expect(mentions('run `gcloud run deploy` first', 'gcloud')).toBe(true);
    expect(mentions('deploy to Cloud Run today', 'cloud run')).toBe(true);
  });

  it('does NOT match a token embedded in a longer word', () => {
    // The short-token false-positive risk that motivated boundary checking:
    // `bq` must not fire inside unrelated identifiers.
    expect(mentions('the bqueue consumer lagged', 'bq')).toBe(false);
    expect(mentions('sbq is not bq', 'bq')).toBe(true); // present standalone too
    expect(mentions('ntfyd is a different daemon', 'ntfy')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(mentions('Use BigQuery for this', 'bigquery')).toBe(true);
    expect(mentions('VERTEX AI is gone', 'vertex ai')).toBe(true);
  });

  it('treats regex metacharacters in tokens literally', () => {
    // Tokens carry `/` and `-`; a naive RegExp build would need escaping.
    expect(
      mentions('see jeremylongshore/qmd-team-intent-kb#12', 'jeremylongshore/qmd-team-intent-kb'),
    ).toBe(true);
  });

  it('returns false for an empty token rather than matching everything', () => {
    expect(mentions('anything at all', '')).toBe(false);
  });
});

describe('readsAsHistorical', () => {
  it('recognizes teardown framing', () => {
    expect(readsAsHistorical('The GCP estate was torn down on 2026-07-09.')).toBe(true);
    expect(readsAsHistorical('We fully exited GCP; never use gcloud.')).toBe(true);
  });

  it('does not fire on plain prescriptive instructions', () => {
    expect(readsAsHistorical('Deploy the service with gcloud run deploy.')).toBe(false);
  });
});

describe('detectStaleness — prescriptive vs historical (the load-bearing case)', () => {
  it('FLAGS a memory that tells you to USE a torn-down platform', () => {
    const findings = detectStaleness(
      memory({
        title: 'Deploying Hustle',
        content:
          'Hustle should use a single GCP project with Firebase and Firestore, ' +
          'and run inference on Vertex AI.',
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe('gcp-torn-down-2026-07-09');
    // The evidence string is what lands in the audit event — it must name both
    // the dead fact and what matched, so a retirement can be explained later.
    expect(findings[0]!.evidence).toContain('torn down on 2026-07-09');
    expect(findings[0]!.matched).toEqual(expect.arrayContaining(['firebase', 'firestore']));
  });

  it('KEEPS the memory that RECORDS the teardown — deleting it would erase the answer', () => {
    const findings = detectStaleness(
      memory({
        title: 'GCP exodus complete',
        content:
          'The GCP estate was torn down on 2026-07-09: 0 billing-enabled projects, ' +
          'BigQuery and Vertex AI and Firebase all gone. Never use gcloud or bq for ' +
          'these projects.',
      }),
    );

    // This memory mentions MORE dead-platform tokens than the prescriptive one
    // above. Token counting alone would rank it as the MOST stale row in the
    // brain, when it is in fact the correct answer to "why no GCP?".
    expect(findings).toHaveLength(0);
  });

  it('still flags a rename even when framed historically', () => {
    // Renames are not exempt: the old repo URL does not resolve regardless of
    // how the sentence is framed, so a reader following it still gets a 404.
    const findings = detectStaleness(
      memory({
        title: 'Old engine link',
        content: 'Formerly at https://github.com/jeremylongshore/qmd-team-intent-kb (legacy).',
      }),
    );

    expect(findings.map((f) => f.ruleId)).toContain('repo-renamed-2026-07-19-registrar');
  });
});

describe('detectStaleness — provenance and scope', () => {
  it('detects a renamed repo via metadata provenance alone', () => {
    // The prose never names the repo; only the provenance does.
    const findings = detectStaleness(
      memory({
        title: 'Spool config',
        content: 'The spool path is resolved at startup.',
        metadata: {
          filePaths: ['packages/kernel/src/spool.ts'],
          tags: [],
          repoUrl: 'https://github.com/jeremylongshore/intentional-cognition-os',
        },
      }),
    );

    expect(findings.map((f) => f.ruleId)).toContain('repo-renamed-2026-07-19-compiler');
  });

  it('does not let an inert provenance path vote on historical framing', () => {
    // A file path cannot narrate a teardown. If provenance were allowed into the
    // historical check, an incidental path component could exempt a genuinely
    // prescriptive memory and silently defeat the sweep.
    const findings = detectStaleness(
      memory({
        title: 'Deploy steps',
        content: 'Run gcloud run deploy to ship the service.',
        metadata: {
          filePaths: ['docs/legacy/retired/old-notes.md'],
          tags: [],
        },
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe('gcp-torn-down-2026-07-09');
  });

  it('returns an empty array for a memory with nothing stale', () => {
    expect(
      detectStaleness(
        memory({
          title: 'Commit and PR standard',
          content: 'Branch from origin/main, never commit to main, wait for required checks.',
        }),
      ),
    ).toEqual([]);
  });

  it('reports one finding per matching rule', () => {
    const findings = detectStaleness(
      memory({
        title: 'Old stack',
        content: 'Deploy with gcloud, and publish alerts to the ntfy topic prod-alerts.',
      }),
    );

    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      'gcp-torn-down-2026-07-09',
      'ntfy-removed-2026-06-13',
    ]);
  });

  it('accepts an injected rule set so tests never depend on the live estate', () => {
    const rules: StalenessRule[] = [
      {
        id: 'test-only',
        because: 'Widgets were discontinued.',
        tokens: ['widget'],
        exemptIfHistorical: false,
      },
    ];

    expect(detectStaleness(memory({ content: 'use a widget' }), rules)).toHaveLength(1);
    expect(detectStaleness(memory({ content: 'use a gadget' }), rules)).toHaveLength(0);
  });
});

describe('ESTATE_STALENESS_RULES — rule hygiene', () => {
  it('has unique rule ids', () => {
    const ids = ESTATE_STALENESS_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('states a date in every `because`, so a retirement is always explainable', () => {
    for (const rule of ESTATE_STALENESS_RULES) {
      expect(rule.because, `rule ${rule.id} must cite a date`).toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it('declares at least one token per rule', () => {
    for (const rule of ESTATE_STALENESS_RULES) {
      expect(rule.tokens.length, `rule ${rule.id} must have tokens`).toBeGreaterThan(0);
    }
  });
});

describe('dry-run precision — candidates are distinct from review', () => {
  it.each([
    'Use BigQuery for the production warehouse.',
    'Hustle should use Firestore.',
    'Run `gcloud run deploy` to ship this service.',
    'Publish alerts to the ntfy topic.',
  ])('identifies an affirmative prescription: %s', (content) => {
    const findings = detectStaleness(memory({ content }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ disposition: 'retirement-candidate' });
  });

  it.each([
    'We built a BigQuery schema in 72 hours.',
    'The incident involved Firestore.',
    'Building a 254-table BigQuery schema in 72 hours',
    'The old instruction was "Use BigQuery for reporting."',
    'Historical quote: "Use Firestore."',
    '"We should use Firestore. That was the recommendation."',
    "'We should use Firestore. That was the recommendation.'",
    '"Old recommendation. We should use Firestore. End quotation."',
    '"Old recommendation.\nWe should use Firestore.\nEnd quotation."',
    '```sh\n```not-a-close\nRun gcloud run deploy\n```',
    '~~~sh\n~~~not-a-close\nRun gcloud run deploy\n~~~',
    'Nobody should use Firestore.',
    'No one should use Firestore.',
    'No services should use Firestore.',
    'None of our services should use Firestore.',
    'Firestore was retired; the old note says "Use Firestore."',
    '> Run gcloud run deploy',
    '> Prior recommendation:\nWe should use Firestore.',
    '```sh\nRun gcloud run deploy\n```',
    '~~~sh\nUse BigQuery\n~~~',
    '    Run gcloud run deploy',
    'Should we use Firestore?',
    'If needed, use BigQuery.',
    'We could use Firestore.',
    'Use Redis instead of Firestore.',
    'We were told we should use Firestore.',
    'We retired Firebase. Deploy the service with gcloud.',
    'The legacy configuration was removed. Run gcloud run deploy.',
    "Don't use Redis; instead use Firestore.",
  ])('keeps an uncertain/narrative match visible: %s', (content) => {
    const findings = detectStaleness(memory({ content }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ disposition: 'manual-review' });
    expect(findings[0]!.evidence).toContain('manual-review');
  });

  it('does not treat platform provenance as a prescription', () => {
    const findings = detectStaleness(
      memory({ metadata: { filePaths: ['docs/bigquery/report.md'], tags: [] } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ disposition: 'manual-review', matched: ['bigquery'] });
  });

  it('keeps an opaque quoted instruction visible even beside a teardown record', () => {
    const findings = detectStaleness(
      memory({ content: 'Firebase was retired.\n> Use Firestore.' }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.disposition).toBe('manual-review');
  });

  it('preserves pure teardown exemptions and classifies each matching rule', () => {
    const findings = detectStaleness(
      memory({ content: 'Firebase was retired. Publish alerts to ntfy.' }),
    );
    expect(findings.map((f) => [f.ruleId, f.disposition])).toEqual([
      ['ntfy-removed-2026-06-13', 'manual-review'],
    ]);
    expect(detectStaleness(memory({ content: 'Never use gcloud or BigQuery.' }))).toEqual([]);
  });

  it('does not hide provenance-only tokens behind a different historical token', () => {
    const findings = detectStaleness(
      memory({
        content: 'Firebase was retired.',
        metadata: { filePaths: ['docs/gcloud/setup.md'], tags: [] },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      disposition: 'manual-review',
      matched: expect.arrayContaining(['firebase', 'gcloud']),
    });
  });

  it('preserves rename findings from provenance regardless of historical prose', () => {
    const findings = detectStaleness(
      memory({
        content: 'The legacy configuration was retired.',
        metadata: {
          filePaths: [],
          tags: [],
          repoUrl: 'https://github.com/jeremylongshore/qmd-team-intent-kb',
        },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.disposition).toBe('retirement-candidate');
  });

  it('does not blanket-exempt imported reference material', () => {
    const findings = detectStaleness(
      memory({
        content: 'Use BigQuery.',
        metadata: { filePaths: ['imports/reference.md'], tags: ['reference'] },
      }),
    );
    expect(findings[0]!.disposition).toBe('retirement-candidate');
  });

  it('does not mutate input and retains deterministic rule order and evidence', () => {
    const subject = memory({ content: 'Use BigQuery. Publish alerts to ntfy.' });
    const before = structuredClone(subject);
    const first = detectStaleness(subject);
    expect(subject).toEqual(before);
    expect(detectStaleness(subject)).toEqual(first);
    expect(first.map((f) => f.ruleId)).toEqual([
      'gcp-torn-down-2026-07-09',
      'ntfy-removed-2026-06-13',
    ]);
    for (const finding of first) {
      expect(finding.disposition).toBe('retirement-candidate');
      expect(finding.evidence).toContain(finding.matched[0]);
      expect(finding.memoryId).toBe(subject.id);
    }
  });
});
