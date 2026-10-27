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

/** Explicit fixture applicability, not inferred from the memory's metadata. */
function detectInEstate(subject: Subject, rules = ESTATE_STALENESS_RULES) {
  return detectStaleness(
    subject,
    rules,
    rules.map((rule) => ({
      memoryId: subject.id,
      ruleId: rule.id,
      scope: 'intent-solutions-estate' as const,
      evidenceRef: 'fixture://reviewed-estate-workflow',
    })),
  );
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
    const findings = detectInEstate(
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
    const findings = detectInEstate(
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
    // Old repository URLs may redirect. Identity review never implies that the
    // memory content should be retired, including historical references.
    const findings = detectInEstate(
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
    const findings = detectInEstate(
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
    const findings = detectInEstate(
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
      detectInEstate(
        memory({
          title: 'Commit and PR standard',
          content: 'Branch from origin/main, never commit to main, wait for required checks.',
        }),
      ),
    ).toEqual([]);
  });

  it('reports one finding per matching rule', () => {
    const findings = detectInEstate(
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
        remedy: 'retirement-review',
        authority: null,
      },
    ];

    expect(detectInEstate(memory({ content: 'use a widget' }), rules)).toHaveLength(1);
    expect(detectInEstate(memory({ content: 'use a gadget' }), rules)).toHaveLength(0);
  });
});

describe('ESTATE_STALENESS_RULES — rule hygiene', () => {
  it('has unique rule ids', () => {
    const ids = ESTATE_STALENESS_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('states the dated declaration in every `because`, without proving its truth', () => {
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
    const findings = detectInEstate(memory({ content }));
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
    const findings = detectInEstate(memory({ content }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ disposition: 'manual-review' });
    expect(findings[0]!.evidence).toContain('manual-review');
  });

  it('does not treat platform provenance as a prescription', () => {
    const findings = detectInEstate(
      memory({ metadata: { filePaths: ['docs/bigquery/report.md'], tags: [] } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ disposition: 'manual-review', matched: ['bigquery'] });
  });

  it('keeps an opaque quoted instruction visible even beside a teardown record', () => {
    const findings = detectInEstate(memory({ content: 'Firebase was retired.\n> Use Firestore.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.disposition).toBe('manual-review');
  });

  it('preserves pure teardown exemptions and classifies each matching rule', () => {
    const findings = detectInEstate(
      memory({ content: 'Firebase was retired. Publish alerts to ntfy.' }),
    );
    expect(findings.map((f) => [f.ruleId, f.disposition])).toEqual([
      ['ntfy-removed-2026-06-13', 'manual-review'],
    ]);
    expect(detectInEstate(memory({ content: 'Never use gcloud or BigQuery.' }))).toEqual([]);
  });

  it('does not hide provenance-only tokens behind a different historical token', () => {
    const findings = detectInEstate(
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
    const findings = detectInEstate(
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
    expect(findings[0]!.disposition).toBe('manual-review');
    expect(findings[0]!.remedy).toBe('metadata-review');
  });

  it('does not blanket-exempt imported reference material', () => {
    const findings = detectInEstate(
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
    const first = detectInEstate(subject);
    expect(subject).toEqual(before);
    expect(detectInEstate(subject)).toEqual(first);
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

describe('authority, remedy and applicability boundaries', () => {
  const gcp = ESTATE_STALENESS_RULES[0]!;
  const subject = memory({ content: 'Use BigQuery for the production warehouse.' });
  const assessed = {
    memoryId: subject.id,
    ruleId: gcp.id,
    scope: 'intent-solutions-estate' as const,
    evidenceRef: 'fixture://current-invocation-estate-workflow',
  };

  it('keeps an identical external tutorial in review without estate applicability', () => {
    expect(detectStaleness(subject)[0]).toMatchObject({
      disposition: 'manual-review',
      scopeEvidenceRef: null,
    });
    expect(detectStaleness(subject, undefined, [assessed])[0]).toMatchObject({
      disposition: 'retirement-candidate',
      scopeEvidenceRef: assessed.evidenceRef,
      remedy: 'retirement-review',
    });
  });

  it.each([
    { ...assessed, memoryId: 'another-memory' },
    { ...assessed, ruleId: 'another-rule' },
    { ...assessed, evidenceRef: '  ' },
    { ...assessed, scope: 'external' as const },
    { ...assessed, scope: 'unresolved' as const },
  ])(
    'does not infer applicability from an unrelated or unresolved assessment: %j',
    (assessment) => {
      expect(detectStaleness(subject, undefined, [assessment])[0]!.disposition).toBe(
        'manual-review',
      );
    },
  );

  it('requires reconciliation of duplicate and conflicting scope assessments in either order', () => {
    const external = { ...assessed, scope: 'external' as const };
    for (const assessments of [
      [assessed, external],
      [external, assessed],
      [assessed, assessed],
    ]) {
      expect(detectStaleness(subject, undefined, assessments)[0]).toMatchObject({
        disposition: 'manual-review',
        scopeEvidenceRef: null,
      });
    }
  });

  it('does not borrow an assessment from a different rule in the same memory', () => {
    const findings = detectStaleness(
      memory({ content: 'Use BigQuery. Publish alerts to ntfy.' }),
      undefined,
      [assessed],
    );
    expect(findings.map((finding) => finding.disposition)).toEqual([
      'retirement-candidate',
      'manual-review',
    ]);
  });

  it('does not infer estate scope from metadata or a reference/import label', () => {
    const imported = memory({
      ...subject,
      metadata: {
        repoUrl: 'https://github.com/intent-solutions-io/intent-os',
        projectContext: 'Intent Solutions production',
        filePaths: ['imports/tutorial.md'],
        tags: ['reference', 'intent-solutions-estate'],
      },
    });
    expect(detectStaleness(imported)[0]!.disposition).toBe('manual-review');
    expect(detectStaleness(imported, undefined, [assessed])[0]!.disposition).toBe(
      'retirement-candidate',
    );
  });

  it('keeps custom rules without complete authority in review despite affirmative instructions', () => {
    const rules = [
      { ...gcp, authority: null },
      { ...gcp, authority: { ...gcp.authority!, sources: [] } },
      {
        ...gcp,
        authority: {
          ...gcp.authority!,
          sources: [{ ...gcp.authority!.sources[0]!, revision: 'main' }],
        },
      },
      {
        ...gcp,
        authority: { ...gcp.authority!, sources: [{ ...gcp.authority!.sources[0]!, sha256: '' }] },
      },
    ];
    for (const rule of rules) {
      expect(detectStaleness(subject, [rule], [assessed])[0]!.disposition).toBe('manual-review');
    }
  });

  it.each([
    ['jeremylongshore/intentional-cognition-os', 'bobs-big-brain-compiler'],
    ['jeremylongshore/qmd-team-intent-kb', 'bobs-big-brain-registrar'],
    ['jeremylongshore/governed-second-brain-plugin', 'bobs-big-brain-plugin'],
  ])('routes redirect-compatible identity drift to metadata review: %s', (oldPath, canonical) => {
    const findings = detectInEstate(
      memory({
        content: `Use https://github.com/${oldPath}.`,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ disposition: 'manual-review', remedy: 'metadata-review' });
    expect(findings[0]!.evidence).toContain(canonical);
    expect(findings[0]!.evidence).not.toMatch(/404|no longer resolves/);
  });

  it('preserves the plugin rule id while separating remote and local dates', () => {
    const rule = ESTATE_STALENESS_RULES.find((item) => item.id.endsWith('-plugin'))!;
    expect(rule.id).toBe('repo-renamed-2026-07-14-plugin');
    expect(rule.authority!.effectiveDate).toBe('2026-07-13');
    expect(rule.because).toContain(
      'remote repository on 2026-07-13, local directory on 2026-07-14',
    );
  });

  it('exposes pinned source identifiers and private/unsigned/currentness limits', () => {
    for (const rule of ESTATE_STALENESS_RULES) {
      expect(rule.authority).toMatchObject({
        scope: 'intent-solutions-estate',
        authentication: 'unsigned-record',
        currentness: 'not-revalidated',
      });
      expect(rule.authority!.sources.length).toBeGreaterThan(0);
      for (const source of rule.authority!.sources) {
        expect(source.revision).toMatch(/^[a-f0-9]{40}$/);
        expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(source.locator).not.toBe('');
      }
    }
    expect(gcp.authority!.sources[0]!.visibility).toBe('private');
    expect(gcp.authority!.limitations).toContain('public readers cannot independently inspect');
    expect(gcp.because).not.toContain('0 billing-enabled');
    expect(
      ESTATE_STALENESS_RULES.find((rule) => rule.id.startsWith('ntfy'))!.because,
    ).not.toContain('Slack-only');
  });

  it('does not mutate rules, memory or assessments or authorize a transition', () => {
    const rules = structuredClone(ESTATE_STALENESS_RULES);
    const assessments = [structuredClone(assessed)];
    const before = structuredClone({ rules, subject, assessments });
    const first = detectStaleness(subject, rules, assessments);
    expect({ rules, subject, assessments }).toEqual(before);
    expect(detectStaleness(subject, rules, assessments)).toEqual(first);
    expect(first[0]!.evidence).toContain('not transition authorization');
  });
});
