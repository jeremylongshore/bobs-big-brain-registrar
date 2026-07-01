import { describe, it, expect } from 'vitest';
import { scanForSecrets, hasSecrets } from '../secrets/secret-scanner.js';

describe('scanForSecrets', () => {
  it('detects JWT tokens', () => {
    const content =
      'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'jwt')).toBe(true);
  });

  it('detects AWS access keys', () => {
    const content = 'aws_key = AKIAIOSFODNN7EXAMPLE';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'aws-key')).toBe(true);
  });

  it('detects GitHub tokens', () => {
    const content = 'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'github-token')).toBe(true);
  });

  it('detects generic API keys (sk-*)', () => {
    const content = 'api_key: sk-abcdefghijklmnopqrstuvwxyz';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'generic-api-key')).toBe(true);
  });

  it('detects Slack tokens', () => {
    const content = 'slack: xoxb-' + '123456789012-1234567890123-abcdefgh';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'slack-token')).toBe(true);
  });

  it('detects PEM private keys', () => {
    const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'pem-key')).toBe(true);
  });

  it('detects connection strings with credentials', () => {
    const content = 'DATABASE_URL=postgres://admin:s3cret@localhost:5432/mydb';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'connection-string')).toBe(true);
  });

  it('detects Base64 auth headers', () => {
    const content = 'Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'base64-auth')).toBe(true);
  });

  it('detects GCP service account JSON', () => {
    const content = '{ "type": "service_account", "project_id": "my-project" }';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'gcp-service-account')).toBe(true);
  });

  it('detects high-entropy hex strings', () => {
    const content = 'key: ' + 'a1b2c3d4e5'.repeat(5);
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'high-entropy-hex')).toBe(true);
  });

  it('detects env secret values', () => {
    const content = 'SECRET=my_super_secret_value_123';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'env-secret')).toBe(true);
  });

  it('returns empty for clean content', () => {
    const content =
      'Use Result<T, E> for all fallible operations.\nPrefer composition over inheritance.';
    const matches = scanForSecrets(content);
    expect(matches).toHaveLength(0);
  });

  it('reports correct line and column numbers', () => {
    const content = 'line one\ntoken: AKIAIOSFODNN7EXAMPLE\nline three';
    const matches = scanForSecrets(content);
    const awsMatch = matches.find((m) => m.patternId === 'aws-key');
    expect(awsMatch).toBeDefined();
    expect(awsMatch!.line).toBe(2);
    expect(awsMatch!.column).toBeGreaterThan(0);
  });

  it('detects multiple secrets in one document', () => {
    const content = [
      'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
      'JWT=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'DB=postgres://user:pass@host/db',
    ].join('\n');
    const matches = scanForSecrets(content);
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe('hasSecrets', () => {
  it('returns true when secrets present', () => {
    expect(hasSecrets('key: AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('returns false for clean content', () => {
    expect(hasSecrets('Just a normal comment about code patterns')).toBe(false);
  });
});

/**
 * Evasion hardening (bead compile-then-govern-e06.14 · umbrella #27).
 *
 * The e06.3 govern-decision eval measured secret-scanner recall at 0.56 because
 * two evasions defeated the line-by-line scan: (A) a key SPLIT across a newline
 * matched no per-line pattern, and (B) a token BASE64/hex-WRAPPED had no decode
 * step. These tests pin the fix (a newline-collapsed pre-pass + a bounded
 * decode-and-rescan) AND guard precision: benign base64 (a data-URI image) must
 * NOT be flagged as a secret.
 */
describe('scanForSecrets — split-across-newline keys (evasion A)', () => {
  it('detects an AWS key broken across two lines', () => {
    // `AKIAIOSFO` + `DNN7EXAMPLE` straddle a newline; per-line scan sees neither
    // half, the no-whitespace collapsed view rejoins the full AKIA… key.
    const content = 'access key:\nAKIAIOSFO\nDNN7EXAMPLE\nendkey';
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.patternId === 'aws-key')).toBe(true);
  });

  it('detects an sk- key split across a newline', () => {
    const content = 'The key is sk-abcdefghij1234567890\nKLMNOPqrstuvWX and it authenticates.';
    expect(hasSecrets(content)).toBe(true);
  });

  it('still reports the original per-line hit when the key is NOT split', () => {
    // The additive pre-pass must not disturb the existing per-line path: an
    // inline key keeps its precise line/column (not the collapsed line=1).
    const content = 'line one\ntoken: AKIAIOSFODNN7EXAMPLE\nline three';
    const matches = scanForSecrets(content);
    const inline = matches.find((m) => m.patternId === 'aws-key');
    expect(inline).toBeDefined();
    expect(inline!.line).toBe(2);
  });
});

describe('scanForSecrets — base64/hex-wrapped tokens (evasion B)', () => {
  it('detects an AWS key base64-wrapped in content', () => {
    const wrapped = Buffer.from('AKIAIOSFODNN7EXAMPLE', 'utf8').toString('base64');
    const matches = scanForSecrets(`Decoded at runtime: ${wrapped}`);
    expect(matches.some((m) => m.patternId === 'base64-wrapped:aws-key')).toBe(true);
  });

  it('detects an OpenAI-style key base64-wrapped in content', () => {
    const wrapped = Buffer.from('sk-abcdefghij1234567890KLMNOPqrstuvWX', 'utf8').toString('base64');
    const matches = scanForSecrets(`token blob = ${wrapped}`);
    expect(matches.some((m) => m.patternId.startsWith('base64-wrapped:'))).toBe(true);
  });

  it('detects a GitHub PAT hex-wrapped in content', () => {
    const wrapped = Buffer.from('ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 'utf8').toString('hex');
    const matches = scanForSecrets(`hexval ${wrapped}`);
    expect(matches.some((m) => m.patternId === 'hex-wrapped:github-token')).toBe(true);
  });

  it('does NOT flag benign base64 (a data-URI PNG) as a secret — precision guard', () => {
    // A real 1x1 PNG data-URI blob. It decodes to binary noise, so the
    // isMostlyPrintable guard rejects it and no secret pattern is applied. If
    // this ever trips, tighten the decoder — never weaken a real detection.
    const dataUri =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const matches = scanForSecrets(`Here is an inline image: data:image/png;base64,${dataUri}`);
    expect(matches).toHaveLength(0);
  });

  it('does NOT flag a benign base64 word blob that decodes to plain prose', () => {
    // Decodes to ordinary English — printable, but contains no secret pattern,
    // so the rescan finds nothing. Confirms decode-and-rescan is pattern-gated,
    // not a blanket "any decodable base64 is suspicious" flag.
    const prose = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8').toString(
      'base64',
    );
    expect(hasSecrets(`config value: ${prose}`)).toBe(false);
  });

  it('stays deterministic and bounded on large repetitive input (no throw)', () => {
    // Pathological input: many base64-looking blobs. The caps in scanForSecrets
    // bound the work; it must return deterministically without throwing.
    const blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5 '.repeat(500);
    expect(() => scanForSecrets(blob)).not.toThrow();
    const a = scanForSecrets(blob);
    const b = scanForSecrets(blob);
    expect(a.length).toBe(b.length);
  });
});
