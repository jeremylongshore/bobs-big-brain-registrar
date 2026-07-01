import { describe, it, expect } from 'vitest';
import { SECRET_PATTERNS, PII_PATTERNS } from '../secrets/patterns.js';

describe('SECRET_PATTERNS', () => {
  it('has 15 patterns', () => {
    expect(SECRET_PATTERNS).toHaveLength(15);
  });

  it('each pattern has required fields', () => {
    for (const p of SECRET_PATTERNS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(p.description).toBeTruthy();
    }
  });

  it('all pattern IDs are unique', () => {
    const ids = SECRET_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Azure connection string pattern matches AccountKey=base64string==', () => {
    const azurePattern = SECRET_PATTERNS.find((p) => p.id === 'azure-connection-string');
    expect(azurePattern).toBeDefined();
    expect(azurePattern!.regex.test('AccountKey=dGVzdGtleXZhbHVlaGVyZWZvcnRlc3Rpbmc==')).toBe(true);
  });

  it('PostgreSQL pattern matches postgres://user:pass@host:5432/db', () => {
    const pgPattern = SECRET_PATTERNS.find((p) => p.id === 'postgres-connection-string');
    expect(pgPattern).toBeDefined();
    expect(pgPattern!.regex.test('postgres://user:pass@host:5432/db')).toBe(true);
  });
});

describe('PII_PATTERNS', () => {
  it('includes an email address pattern', () => {
    const emailPattern = PII_PATTERNS.find((p) => p.id === 'email-address');
    expect(emailPattern).toBeDefined();
    expect(emailPattern!.regex.test('alice@example.com')).toBe(true);
  });

  it('includes a US phone number pattern', () => {
    const phonePattern = PII_PATTERNS.find((p) => p.id === 'us-phone');
    expect(phonePattern).toBeDefined();
    expect(phonePattern!.regex.test('(555) 867-5309')).toBe(true);
  });

  it('includes an SSN-like pattern', () => {
    const ssnPattern = PII_PATTERNS.find((p) => p.id === 'ssn-like');
    expect(ssnPattern).toBeDefined();
    expect(ssnPattern!.regex.test('123-45-6789')).toBe(true);
  });

  // PII vocabulary convergence (bead compile-then-govern-e06.15 · umbrella #27):
  // the classifier's PII set is widened UP to the repository-boundary filter's
  // PII_PATTERN — SSN keyword, DOB, and background-check terms — so a DOB-only
  // leak is caught pre-boundary by the policy pipeline too, not only at the
  // write choke point. Additive / tightening only.
  it('includes an SSN keyword pattern (SSN / social security number)', () => {
    const p = PII_PATTERNS.find((x) => x.id === 'ssn-keyword');
    expect(p).toBeDefined();
    expect(p!.regex.test('Employee SSN on file')).toBe(true);
    expect(p!.regex.test('social security number redacted')).toBe(true);
  });

  it('includes a date-of-birth pattern (date of birth / DOB: / DOB=)', () => {
    const p = PII_PATTERNS.find((x) => x.id === 'date-of-birth');
    expect(p).toBeDefined();
    expect(p!.regex.test('DOB: 1984-07-02')).toBe(true);
    expect(p!.regex.test('date of birth on the form')).toBe(true);
    // A bare "DOB" mention without an assignment stays below the bar (matches
    // the boundary filter's `\bDOB\b\s*[:=]` shape — no over-broad firing).
    expect(p!.regex.test('the DOB column header')).toBe(false);
  });

  it('includes a background-check pattern', () => {
    const p = PII_PATTERNS.find((x) => x.id === 'background-check');
    expect(p).toBeDefined();
    expect(p!.regex.test('background-check passed')).toBe(true);
    expect(p!.regex.test('background check report attached')).toBe(true);
  });
});

describe('heroku-api-key context gate (precision guard)', () => {
  // The heroku-api-key rule is UUID-shaped, so it is gated behind key-context to
  // avoid over-flagging a request/trace/bead id in prose (bead
  // compile-then-govern-e06.15). The pattern still carries the UUID regex; the
  // scanner (execWithContext) enforces the context. Here we assert the
  // requiresContext gate exists and matches key-context but not bare prose.
  const heroku = SECRET_PATTERNS.find((p) => p.id === 'heroku-api-key')!;

  it('still recognises the UUID shape', () => {
    expect(heroku.regex.test('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
  });

  it('carries a requiresContext gate', () => {
    expect(heroku.requiresContext).toBeInstanceOf(RegExp);
  });

  it('context gate matches key-context (HEROKU / API / KEY / assignment)', () => {
    const ctx = heroku.requiresContext!;
    expect(ctx.test('HEROKU_API_KEY=3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(ctx.test('the Heroku API key is ...')).toBe(true);
    expect(ctx.test('bearer token ...')).toBe(true);
  });

  it('context gate does NOT match ordinary id prose', () => {
    const ctx = heroku.requiresContext!;
    expect(ctx.test('The request id was 3f2504e0-4f89-41d3-9a0c-0305e82c3301 in the trace.')).toBe(
      false,
    );
    expect(ctx.test('Tracked in bead 3f2504e0-4f89-41d3-9a0c-0305e82c3301 for the sprint.')).toBe(
      false,
    );
  });
});
