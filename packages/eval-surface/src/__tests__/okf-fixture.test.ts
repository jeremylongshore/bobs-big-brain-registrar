import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { PolicyPipeline } from '@qmd-team-intent-kb/policy-engine';
import { CandidateRepository, createTestDatabase } from '@qmd-team-intent-kb/store';
import { makeMemory, makePolicy } from '@qmd-team-intent-kb/test-fixtures';
import {
  exportGovernedOkfFixture,
  parseOkfFixtureBundle,
  proposeOkfFixtureImport,
} from '../okf-fixture/exchange.js';
import {
  OKF_FIXTURE_LIMITS,
  parseOkfDocument,
  serializeOkfDocument,
} from '../okf-fixture/codec.js';

const NOW = '2026-11-04T00:00:00.000Z';
const context = { tenantId: 'synthetic-team', capturedAt: NOW };
const concept = (
  fields = 'type: Novel Type',
  body = 'A synthetic reference.\n',
  path = 'concepts/test.md',
) => [{ path, text: `---\n${fields}\n---\n${body}` }];

describe('bounded OKF fixture exchange', () => {
  it('reads the artifact produced by the pinned ArcKit CLI as an untrusted proposal', () => {
    const text = readFileSync(
      new URL('./fixtures/okf/arckit-requirements.md.txt', import.meta.url),
      'utf8',
    );
    const result = proposeOkfFixtureImport(
      [{ path: 'projects/001-fixture/ARC-001-REQ-v1.0.md', text }],
      context,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.trustLevel).toBe('untrusted');
    expect(result.bundle.concepts[0]!.frontmatter.type).toBe('Requirements');
    expect(result.bundle.concepts[0]!.frontmatter.arckit).toMatchObject({
      doc_type: 'REQ',
      document_id: 'ARC-001-REQ-v1.0',
    });
    expect(result.bundle.concepts[0]!.diagnostics).toEqual(['broken_bundle_link']);
  });
  it('checks frontmatter, node, total-bundle, encoding and computation-contract limits', () => {
    expect(() =>
      parseOkfDocument('---\ntype: Reference\nx: ' + 'a'.repeat(33000) + '\n---\nBody'),
    ).toThrow('frontmatter_limit');
    expect(() =>
      parseOkfDocument(
        '---\ntype: Reference\nx: [' + Array(4100).fill('0').join(',') + ']\n---\nBody',
      ),
    ).toThrow('yaml_complexity');
    expect(() =>
      parseOkfFixtureBundle(
        Array.from({ length: 6 }, (_, i) => ({ path: `large${i}.md`, text: 'a'.repeat(200000) })),
        NOW,
      ),
    ).toThrow('bundle_limit');
    expect(() => parseOkfDocument('---\ntype: Reference\n---\n\ud800')).toThrow(
      'document_encoding_or_limit',
    );
    const doc = parseOkfFixtureBundle(
      concept(
        'type: Attested Computation\nruntime: python\nparameters: [broken]\nexecutor: {}\nattester: {}',
        '# Computation\n```python\nprint(1)\n```',
      ),
      NOW,
    ).concepts[0]!;
    expect(doc.diagnostics).toEqual(
      expect.arrayContaining([
        'invalid_parameters',
        'missing_executor_receipt',
        'incomplete_executor',
        'incomplete_attester',
        'attestation_not_performed',
      ]),
    );
    expect(doc.diagnostics).not.toContain('missing_runtime');
    expect(doc.diagnostics).not.toContain('computation_contract_not_validated');
  });
  it.each(['{ future: stable }', '[{ future: stable }]', 'null', '42'])(
    'preserves malformed optional status %s as a diagnostic',
    (status) => {
      const result = proposeOkfFixtureImport(
        concept(`type: Reference\nstatus: ${status}`),
        context,
      );
      expect(result.bundle.concepts[0]!.diagnostics).toContain('unsupported_status');
      expect(JSON.parse(result.candidates[0]!.metadata.projectContext!).frontmatter.status).toEqual(
        result.bundle.concepts[0]!.frontmatter.status,
      );
    },
  );
  it.each(['2026-02-30T00:00:00Z', '2026-11-04T24:00:00Z', '2026-13-01T00:00:00Z'])(
    'does not normalize invalid claimed freshness %s into a valid date',
    (date) => {
      expect(
        parseOkfFixtureBundle(concept(`type: Reference\nstale_after: ${date}`), NOW).concepts[0]!
          .claimedFreshness,
      ).toBe('invalid');
    },
  );
  it('exports a governed public fixture and re-imports an untrusted proposal without authority', () => {
    const memory = makeMemory({
      tenantId: context.tenantId,
      sensitivity: 'public',
      updatedAt: NOW,
    });
    const entries = exportGovernedOkfFixture(memory, context.tenantId);
    const result = proposeOkfFixtureImport(entries, context);
    expect(result.bundle.diagnostics).toEqual([]);
    expect(result.bundle.concepts).toHaveLength(1);
    expect(result.bundle.concepts[0]!.frontmatter.bbb_fixture).toEqual(memory);
    expect(result.bundle.concepts[0]!.claimedVerification).toBe('unverified');
    const candidate = result.candidates[0]!;
    expect(candidate).toMatchObject({
      status: 'inbox',
      source: 'import',
      trustLevel: 'untrusted',
      tenantId: context.tenantId,
      content: memory.content,
      author: { type: 'system', id: 'okf-fixture-import' },
      metadata: { audience: 'owner', sensitivity: 'internal' },
    });
    expect(candidate.origin).toBeUndefined();
    expect(candidate.id).not.toBe(memory.id);
    expect(JSON.parse(candidate.metadata.projectContext!).frontmatter.bbb_fixture).toEqual(memory);
    const db = createTestDatabase();
    try {
      const repo = new CandidateRepository(db);
      repo.insert(candidate, computeContentHash(candidate.content));
      expect(repo.findById(candidate.id)?.status).toBe('inbox');
      const policy = makePolicy({
        rules: [
          {
            id: 'reject-untrusted',
            type: 'source_trust',
            action: 'reject',
            enabled: true,
            priority: 0,
            parameters: { minimumTrust: 'low' },
          },
        ],
      });
      expect(new PolicyPipeline(policy).evaluate(candidate).outcome).toBe('rejected');
      expect(db.prepare('SELECT count(*) AS n FROM curated_memories').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it.each([
    { sensitivity: 'internal' as const },
    { tenantId: 'other' },
    { metadata: { filePaths: [], tags: [], audience: 'owner' as const } },
    { metadata: { filePaths: [], tags: [], sensitivity: 'restricted' as const } },
    { contentHash: 'a'.repeat(64) },
  ])('rejects export outside the selected public scope %#', (overrides) => {
    expect(() =>
      exportGovernedOkfFixture(
        makeMemory({ tenantId: context.tenantId, sensitivity: 'public', ...overrides }),
        context.tenantId,
      ),
    ).toThrow();
  });

  it('preserves unknown nested metadata and prototype-shaped keys without polluting objects', () => {
    const entries = concept(
      'type: Future Type\nunknown:\n  list: [true, null, 4]\n__proto__:\n  polluted: true\nconstructor: retained',
    );
    const doc = parseOkfDocument(entries[0]!.text);
    const reread = parseOkfDocument(serializeOkfDocument(doc));
    expect(reread.frontmatter).toEqual(doc.frontmatter);
    expect(Object.getPrototypeOf(reread.frontmatter)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(
      JSON.parse(proposeOkfFixtureImport(entries, context).candidates[0]!.metadata.projectContext!)
        .frontmatter.__proto__,
    ).toEqual({ polluted: true });
  });

  it('normalizes verification mapping/list for informational tier, never for candidate trust', () => {
    for (const verified of [
      'verified:\n  by: human:reviewer\n  at: 2026-11-03T00:00:00Z',
      'verified:\n  - by: human:reviewer\n    at: 2026-11-03T00:00:00Z',
    ]) {
      const result = proposeOkfFixtureImport(
        concept(
          `type: Reference\n${verified}\nstatus: stable\ntrustLevel: high\ntenantId: attacker\nauthor: human:owner\norigin: forged`,
        ),
        context,
      );
      expect(result.bundle.concepts[0]!.claimedVerification).toBe('human-reviewed');
      expect(result.candidates[0]).toMatchObject({
        trustLevel: 'untrusted',
        tenantId: context.tenantId,
        author: { id: 'okf-fixture-import' },
      });
      expect(result.candidates[0]!.origin).toBeUndefined();
    }
  });

  it('keeps freshness boundaries, unknown status, malformed claims and attestation inert', () => {
    const result = parseOkfFixtureBundle(
      concept(
        'type: Attested Computation\nstale_after: 2026-11-04T00:00:00Z\nstatus: future-state\nverified: bogus\nsources: [broken]\ngenerated: {}\nexecutor:\n  resource: https://example.invalid/execute\nattester:\n  resource: process:offline',
      ),
      NOW,
    ).concepts[0]!;
    expect(result.claimedFreshness).toBe('stale');
    expect(result.claimedVerification).toBe('unverified');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        'unsupported_status',
        'invalid_verified_claim',
        'invalid_generated_claim',
        'invalid_sources',
        'missing_runtime',
        'attestation_not_performed',
      ]),
    );
    expect(
      parseOkfFixtureBundle(concept('type: Reference\nstale_after: 2026-11-05T00:00:00+00:00'), NOW)
        .concepts[0]!.claimedFreshness,
    ).toBe('fresh');
    expect(
      parseOkfFixtureBundle(concept('type: Reference\nstale_after: tomorrow'), NOW).concepts[0]!
        .claimedFreshness,
    ).toBe('invalid');
  });

  it('identifies reserved files before type, including nested reserved paths', () => {
    expect(
      parseOkfFixtureBundle(
        [
          { path: 'index.md', text: '---\nokf_version: "0.2"\n---\n# Index' },
          { path: 'nested/log.md', text: '# Log\n\n## 2026-11-04' },
        ],
        NOW,
      ),
    ).toEqual({ concepts: [], diagnostics: [] });
    expect(
      parseOkfFixtureBundle(
        [{ path: 'index.md', text: '---\ntype: OKF Bundle Index\n---\nIndex' }],
        NOW,
      ),
    ).toEqual({ concepts: [], diagnostics: ['index.md:noncanonical_reserved_frontmatter'] });
  });

  it('permits absent optional fields and confined parent/root links, warns on broken links', () => {
    const entries = [
      ...concept(
        'type: Reference\nsources:\n  - resource: all synthetic widgets',
        '[Sibling](../other.md) [Root](/other.md) [Missing](missing.md) [Web](https://example.invalid/)',
      ),
      ...concept('type: Unknown', 'Other', 'other.md'),
    ];
    expect(parseOkfFixtureBundle(entries, NOW).concepts[0]!.diagnostics).toEqual([
      'broken_bundle_link',
    ]);
  });

  it.each([
    '../escape.md',
    '/absolute.md',
    'a/../b.md',
    'a\\b.md',
    'a%2fb.md',
    'a//b.md',
    'a.md\0',
    'a/./b.md',
  ])('rejects entry path %s', (path) => {
    expect(() => parseOkfFixtureBundle(concept('type: Reference', 'Body', path), NOW)).toThrow(
      'okf_fixture:entry_path',
    );
  });
  it.each([
    '../../escape.md',
    '/../../../escape.md',
    '%2e%2e/%2e%2e/escape.md',
    '%252e%252e/escape.md',
    '..%5cescape.md',
    '//host/secret.md',
  ])('rejects escaping reference %s', (reference) => {
    expect(() =>
      parseOkfFixtureBundle(concept(`type: Reference\nresource: "${reference}"`), NOW),
    ).toThrow();
  });
  it.each([
    'type: Reference\ntype: Other',
    'type: [Reference]',
    'title: No type',
    'type: ""',
    'type: Reference\nx: &a [*a]',
    'type: Reference\nx: !!js/function code',
    'type: Reference\nx: 9007199254740993',
    'type: Reference\nx: .nan',
    'type: Reference\nx: -0.0',
    'type: Reference\nx: [unterminated',
  ])('rejects unsupported or malformed frontmatter %#', (fields) => {
    expect(() => parseOkfFixtureBundle(concept(fields), NOW)).toThrow();
  });
  it('rejects duplicate entries, unclosed frontmatter, byte/entry/depth budgets and empty proposals', () => {
    const entries = concept();
    expect(() => parseOkfFixtureBundle([...entries, ...entries], NOW)).toThrow('duplicate_path');
    expect(() => parseOkfDocument('---\ntype: Reference')).toThrow('unterminated_frontmatter');
    expect(() => parseOkfDocument('x'.repeat(OKF_FIXTURE_LIMITS.documentBytes + 1))).toThrow(
      'limit',
    );
    expect(() =>
      parseOkfFixtureBundle(
        Array.from({ length: 65 }, (_, i) => ({ path: `d${i}.md`, text: 'x' })),
        NOW,
      ),
    ).toThrow('entry_limit');
    expect(() =>
      parseOkfFixtureBundle(
        concept('type: Reference\nx: ' + '['.repeat(18) + '0' + ']'.repeat(18)),
        NOW,
      ),
    ).toThrow('yaml_complexity');
    expect(() => proposeOkfFixtureImport(concept('type: Reference', '\n'), context)).toThrow(
      'empty_body_unsupported',
    );
  });

  it('scopes deterministic identity to target tenant and metadata revision, retaining exact foreign body', () => {
    const first = proposeOkfFixtureImport(concept(), context).candidates[0]!;
    expect(
      proposeOkfFixtureImport(concept(), { ...context, capturedAt: '2026-11-05T00:00:00.000Z' })
        .candidates[0]!.id,
    ).toBe(first.id);
    expect(
      proposeOkfFixtureImport(concept(), { ...context, tenantId: 'second' }).candidates[0]!.id,
    ).not.toBe(first.id);
    expect(
      proposeOkfFixtureImport(concept('type: Novel Type\nstatus: deprecated'), context)
        .candidates[0]!.id,
    ).not.toBe(first.id);
    expect(JSON.parse(first.metadata.projectContext!).body).toBe('A synthetic reference.\n');
    expect(first.content).toBe('A synthetic reference.');
    const reordered = proposeOkfFixtureImport(concept('title: Same\ntype: Reference'), context)
      .candidates[0]!;
    expect(
      proposeOkfFixtureImport(concept('type: Reference\ntitle: Same'), context).candidates[0]!.id,
    ).toBe(reordered.id);
  });

  it('passes foreign metadata through the real disclosure choke point before persistence', () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    const candidate = proposeOkfFixtureImport(
      concept(`type: Reference\nforeign_secret: ${secret}`),
      context,
    ).candidates[0]!;
    expect(candidate.content).not.toContain(secret);
    const db = createTestDatabase();
    try {
      expect(() =>
        new CandidateRepository(db).insert(candidate, computeContentHash(candidate.content)),
      ).toThrow();
      expect(db.prepare('SELECT count(*) AS n FROM candidates').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
