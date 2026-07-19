import { describe, it, expect, vi } from 'vitest';
import {
  scanForDisclosure,
  scanDisclosureFields,
  assertDisclosureClean,
  collectFreeTextFields,
  ENUM_CONSTRAINED_FIELDS,
  normalizeForScan,
  DisclosureRejectedError,
  SECRET_PATTERNS,
  type DisclosureViolation,
} from '../disclosure-filter.js';

const PII: DisclosureViolation = { category: 'pii' };
const COMP: DisclosureViolation = { category: 'compensation' };
const SECRET: DisclosureViolation = { category: 'secret' };

describe('scanForDisclosure — PII (hard-fail)', () => {
  it.each([
    ['an SSN in SSN format', 'employee record 123-45-6789 on file'],
    ['the literal token SSN', 'her SSN is stored elsewhere'],
    ['social security number', 'collect the social security number at onboarding'],
    ['a background-check result', 'background-check passed for this hire'],
    ['date of birth', 'date of birth recorded in HR'],
    ['DOB with a separator', 'DOB: 1990-01-01'],
  ])('flags %s as pii', (_label, text) => {
    expect(scanForDisclosure(text)).toEqual(PII);
  });
});

describe('scanForDisclosure — unambiguous compensation (hard-fail)', () => {
  it.each([
    ['salary', 'his base salary was disclosed'],
    ['base pay', 'base pay for the role'],
    ['signing bonus', 'signing bonus on offer'],
    ['equity grant', 'equity grant vests over time'],
    ['vesting', 'a 4-year vesting schedule'],
    ['RSUs', 'paid in RSUs'],
    ['stock options', 'granted stock options'],
    ['the 7-bucket framework', 'allocate per the 7-bucket framework'],
  ])('flags %s as compensation', (_label, text) => {
    expect(scanForDisclosure(text)).toEqual(COMP);
  });
});

describe('scanForDisclosure — numeric ratio-split is context-gated', () => {
  it('flags a ratio-split alongside a compensation keyword', () => {
    expect(scanForDisclosure('the revenue is a 60/40 split with the partner')).toEqual(COMP);
    expect(scanForDisclosure('his comp: 70/30 split')).toEqual(COMP);
  });

  it('does NOT flag a bare ratio-split in technical context', () => {
    expect(scanForDisclosure('we route a 60/40 traffic split between regions')).toBeNull();
    expect(scanForDisclosure('70/30 canary split for the rollout')).toBeNull();
  });
});

describe('scanForDisclosure — gitleaks-class secrets (hard-fail)', () => {
  // Synthetic fixtures only. The partner-pattern tokens below are split with
  // string concatenation so the contiguous secret shape never appears in source
  // (defeats GitHub push-protection and our own scanner on this very repo).
  // Runtime values are identical, so scanForDisclosure still receives the full token.
  it.each([
    ['AWS access key id', 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
    ['GitHub PAT', 'token ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz12'],
    ['GitLab PAT', 'glpat-' + 'abcdefghij1234567890'],
    ['Slack token', 'xoxb-' + '1234567890-abcdefghijklmnop'],
    ['Stripe live key', 'sk_live_' + 'abcdefghijklmnopqrstuvwx'],
    ['Google API key', 'AIza' + 'SyA1234567890abcdefghijklmnopqrstuv'],
    ['Anthropic-style key', 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123'],
    ['npm token', 'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789'],
    ['RSA private key header', '-----BEGIN RSA ' + 'PRIVATE KEY-----'],
    ['generic private key header', '-----BEGIN ' + 'PRIVATE KEY-----'],
    ['OPENSSH private key header', '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'],
    [
      'JWT',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    ],
  ])('flags %s as secret', (_label, text) => {
    expect(scanForDisclosure(text)).toEqual(SECRET);
  });

  it('does NOT flag ordinary technical content that looks key-ish', () => {
    expect(
      scanForDisclosure('the AKIA prefix denotes an AWS key but this is just prose'),
    ).toBeNull();
    expect(scanForDisclosure('we use sha256 hashing for content addresses')).toBeNull();
    expect(scanForDisclosure('git push origin main')).toBeNull();
  });
});

describe('scanForDisclosure — clean content (no false positives)', () => {
  it.each([
    ['investing (not vesting)', 'we are investing in better tests'],
    ['client revenue / deal value is allowed', 'the deal value is $50k for this client'],
    ['ordinary technical content', 'always return Result types from the kernel'],
    ['empty string', ''],
    ['whitespace only', '   \n\t'],
  ])('passes %s', (_label, text) => {
    expect(scanForDisclosure(text)).toBeNull();
  });
});

describe('normalization — evasion resistance', () => {
  it('catches a keyword split by a zero-width space', () => {
    // "sal" + U+200B (zero-width space) + "ary"
    expect(scanForDisclosure('his base sal​ary was disclosed')).toEqual(COMP);
  });

  it('catches a keyword broken by a soft hyphen', () => {
    expect(scanForDisclosure('base ­salary listed')).toEqual(COMP);
  });

  it('catches a Cyrillic-homoglyph keyword (ѕalary → salary)', () => {
    // U+0455 (Cyrillic small letter dze) for the leading "s"
    expect(scanForDisclosure('his ѕalary disclosed')).toEqual(COMP);
  });

  it('catches an SSN-token written with a homoglyph S', () => {
    // U+0405 (Cyrillic capital dze) + SN → SSN after fold
    expect(scanForDisclosure('the ЅSN is on file')).toEqual(PII);
  });

  it('catches percent-encoded comp content (decoded once)', () => {
    // "base salary" with the space percent-encoded
    expect(scanForDisclosure('base%20salary on offer')).toEqual(COMP);
  });

  it('NFKC-normalizes fullwidth forms before scanning', () => {
    // fullwidth "ＳＳＮ" → "SSN"
    expect(scanForDisclosure('record ＳＳＮ here')).toEqual(PII);
  });

  it('normalizeForScan strips invisibles and folds homoglyphs', () => {
    expect(normalizeForScan('sal​ary')).toBe('salary');
    expect(normalizeForScan('ѕalary')).toBe('salary');
  });
});

describe('ReDoS safety — worst-case input completes in linear time', () => {
  it('does not hang on a long adversarial string', () => {
    // A pathological input that would blow up a backtracking regex with nested
    // quantifiers. The patterns here are linear, so this must complete fast.
    const evil = '/'.repeat(50000) + 'a'.repeat(50000);
    const start = performance.now();
    const result = scanForDisclosure(evil);
    const elapsed = performance.now() - start;
    expect(result).toBeNull();
    // Generous bound: linear-time scan of 100k chars is well under 1s.
    expect(elapsed).toBeLessThan(1000);
  });

  it('does not hang on repeated near-match ratio prefixes', () => {
    const evil = '12/34 '.repeat(20000) + 'split revenue';
    const start = performance.now();
    scanForDisclosure(evil);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('fail-closed behavior', () => {
  it('returns a violation (not null) when normalization throws', () => {
    // Force String.prototype.normalize to throw to simulate an internal failure.
    const spy = vi.spyOn(String.prototype, 'normalize').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      // Must NOT silently pass — fail-closed means it reports a violation.
      expect(scanForDisclosure('totally clean content')).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('non-leak — the matched value is never returned', () => {
  it('returns only the category, never the secret text', () => {
    const v = scanForDisclosure('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    expect(v).toEqual(SECRET);
    // No property of the violation should contain the matched substring.
    expect(JSON.stringify(v)).not.toContain('AKIA');
  });

  it('DisclosureRejectedError message omits the matched value', () => {
    let caught: unknown;
    try {
      assertDisclosureClean({ content: 'ssn 123-45-6789', title: 'x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DisclosureRejectedError);
    const err = caught as DisclosureRejectedError;
    expect(err.category).toBe('pii');
    expect(err.message).not.toContain('123-45-6789');
  });
});

describe('scanDisclosureFields', () => {
  it('returns null when every field is clean', () => {
    expect(scanDisclosureFields(['clean title', 'clean body', 'tag-a'])).toBeNull();
  });

  it('catches PII that appears only in a later field (e.g. a tag)', () => {
    expect(scanDisclosureFields(['clean', 'clean', 'DOB: 2000-02-02'])).toEqual(PII);
  });

  it('catches a secret in any field', () => {
    expect(
      scanDisclosureFields(['clean', 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz12']),
    ).toEqual(SECRET);
  });
});

describe('assertDisclosureClean — choke-point entry point', () => {
  it('passes a clean candidate', () => {
    expect(() =>
      assertDisclosureClean({
        content: 'always return Result types',
        title: 'Error handling convention',
        metadata: { tags: ['errors', 'kernel'] },
      }),
    ).not.toThrow();
  });

  it('throws on PII in content', () => {
    expect(() => assertDisclosureClean({ content: 'her SSN is on file', title: 'x' })).toThrow(
      DisclosureRejectedError,
    );
  });

  it('throws on a secret in a tag', () => {
    expect(() =>
      assertDisclosureClean({
        content: 'clean',
        title: 'clean',
        metadata: { tags: ['ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz12'] },
      }),
    ).toThrow(DisclosureRejectedError);
  });

  it('SECRET_PATTERNS is a non-empty frozen-ish list of regexes', () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThan(5);
    for (const p of SECRET_PATTERNS) expect(p).toBeInstanceOf(RegExp);
  });
});

describe('assertDisclosureClean — metadata / author free-text surfaces (c5k.1)', () => {
  // These fields are serialized into metadata_json / author_json on insert but
  // previously bypassed the scan (only content/title/tags were checked).

  it('throws on PII (SSN) in metadata.projectContext', () => {
    expect(() =>
      assertDisclosureClean({
        content: 'clean',
        title: 'clean',
        metadata: { projectContext: 'ticket references ssn 123-45-6789 here' },
      }),
    ).toThrow(DisclosureRejectedError);
  });

  it('throws (category=secret) on a token in metadata.repoUrl', () => {
    let caught: unknown;
    try {
      assertDisclosureClean({
        content: 'clean',
        title: 'clean',
        metadata: { repoUrl: 'https://ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz12@host/x' },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DisclosureRejectedError);
    expect((caught as DisclosureRejectedError).category).toBe('secret');
  });

  it('throws (category=secret) on a token in a metadata.filePaths entry', () => {
    expect(() =>
      assertDisclosureClean({
        content: 'clean',
        title: 'clean',
        metadata: { filePaths: ['src/ok.ts', 'sk_live_' + 'abcdefghijklmnopqrstuvwx'] },
      }),
    ).toThrow(DisclosureRejectedError);
  });

  it('throws (category=compensation) on a comp keyword in author.name', () => {
    let caught: unknown;
    try {
      assertDisclosureClean({
        content: 'clean',
        title: 'clean',
        author: { id: 'u-1', name: 'salary leak via name' },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DisclosureRejectedError);
    expect((caught as DisclosureRejectedError).category).toBe('compensation');
  });

  it('throws (category=pii) on an SSN-format author.id', () => {
    let caught: unknown;
    try {
      assertDisclosureClean({ content: 'clean', title: 'clean', author: { id: '123-45-6789' } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DisclosureRejectedError);
    expect((caught as DisclosureRejectedError).category).toBe('pii');
  });

  it('throws on a homoglyph-obfuscated SSN token in metadata.branch', () => {
    // U+0405 (Cyrillic capital dze) + SN → SSN after fold.
    expect(() =>
      assertDisclosureClean({
        content: 'clean',
        title: 'clean',
        metadata: { branch: 'feat/ЅSN-handling' },
      }),
    ).toThrow(DisclosureRejectedError);
  });

  it('passes a candidate with clean metadata free-text and author', () => {
    expect(() =>
      assertDisclosureClean({
        content: 'always return Result types',
        title: 'Error handling convention',
        metadata: {
          tags: ['errors'],
          filePaths: ['src/kernel.ts'],
          projectContext: 'governed brain',
          repoUrl: 'https://github.com/jeremylongshore/bobs-big-brain-registrar',
          branch: 'main',
          language: 'typescript',
        },
        author: { id: 'jeremy', name: 'Jeremy Longshore' },
      }),
    ).not.toThrow();
  });
});

describe('assertDisclosureClean — tenant_id free-text surface (c5k.1)', () => {
  // tenant_id is persisted by CandidateRepository.insert() but was absent from
  // the old hand-enumerated field list, so an SSN-shaped / comp-shaped tenant_id
  // reached durable state. The structural walk now derives it automatically.
  // Split secret-shaped literals with concatenation so the contiguous shape never
  // appears in source.
  const SSN_TENANT = '123-45-' + '6789';
  const COMP_TENANT = 'team-salary-' + '90000';

  it('throws (category=pii) on an SSN-shaped tenantId', () => {
    let caught: unknown;
    try {
      assertDisclosureClean({ content: 'clean', title: 'clean', tenantId: SSN_TENANT });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DisclosureRejectedError);
    expect((caught as DisclosureRejectedError).category).toBe('pii');
  });

  it('throws (category=compensation) on a comp-shaped tenantId', () => {
    let caught: unknown;
    try {
      assertDisclosureClean({ content: 'clean', title: 'clean', tenantId: COMP_TENANT });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DisclosureRejectedError);
    expect((caught as DisclosureRejectedError).category).toBe('compensation');
  });

  it('passes a clean tenantId through unchanged', () => {
    expect(() =>
      assertDisclosureClean({ content: 'clean', title: 'clean', tenantId: 'acme-prod' }),
    ).not.toThrow();
  });
});

describe('collectFreeTextFields — structural derivation (c5k.1 root-cause fix)', () => {
  it('collects every string surface, recursing into nested objects and arrays', () => {
    const collected = collectFreeTextFields({
      content: 'body',
      title: 'heading',
      tenantId: 'acme',
      metadata: {
        tags: ['a', 'b'],
        filePaths: ['src/x.ts'],
        projectContext: 'ctx',
      },
      author: { id: 'u-1', name: 'Jane' },
    });
    for (const expected of [
      'body',
      'heading',
      'acme',
      'a',
      'b',
      'src/x.ts',
      'ctx',
      'u-1',
      'Jane',
    ]) {
      expect(collected).toContain(expected);
    }
  });

  it('skips enum-constrained fields by name (no false-positive scanning)', () => {
    const collected = collectFreeTextFields({
      content: 'body',
      title: 'heading',
      status: 'inbox',
      source: 'claude_session',
      category: 'convention',
      trustLevel: 'medium',
      author: { type: 'human', id: 'u-1' },
      metadata: { confidence: 'high', sensitivity: 'internal', tags: [] },
    });
    // The enum values must NOT be collected; the free-text id must be.
    for (const enumValue of [
      'inbox',
      'claude_session',
      'convention',
      'medium',
      'human',
      'high',
      'internal',
    ]) {
      expect(collected).not.toContain(enumValue);
    }
    expect(collected).toContain('u-1');
  });

  it('ignores non-string scalars (numbers / booleans / null)', () => {
    const collected = collectFreeTextFields({
      content: 'body',
      count: 42,
      flag: true,
      empty: null,
    });
    expect(collected).toEqual(['body']);
  });

  it('does not loop forever on a cyclic object (DoS guard)', () => {
    const cyclic: Record<string, unknown> = { content: 'body' };
    cyclic.self = cyclic;
    expect(() => collectFreeTextFields(cyclic)).not.toThrow();
    expect(collectFreeTextFields(cyclic)).toContain('body');
  });

  it('ENUM_CONSTRAINED_FIELDS is the only hand-maintained list and is non-empty', () => {
    expect(ENUM_CONSTRAINED_FIELDS.size).toBeGreaterThan(0);
    // Direction check: the allow-list SKIPS fields, so the fail-safe is that an
    // unlisted field gets scanned, never bypassed.
    expect(ENUM_CONSTRAINED_FIELDS.has('tenantId')).toBe(false);
  });
});
