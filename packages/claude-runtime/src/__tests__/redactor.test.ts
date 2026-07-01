import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../secrets/redactor.js';

describe('redactSecrets', () => {
  it('redacts AWS keys', () => {
    const content = 'aws_key = AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(content);
    expect(result).toContain('[REDACTED:aws-key]');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts JWT tokens', () => {
    const content =
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redactSecrets(content);
    expect(result).toContain('[REDACTED:jwt]');
  });

  it('redacts connection strings', () => {
    const content = 'postgres://admin:s3cret@localhost:5432/db';
    const result = redactSecrets(content);
    expect(result).toContain('[REDACTED:connection-string]');
  });

  it('leaves clean content unchanged', () => {
    const content = 'Use Result<T, E> for error handling';
    expect(redactSecrets(content)).toBe(content);
  });

  it('handles multiple secrets on different lines', () => {
    const content = 'key=AKIAIOSFODNN7EXAMPLE\ndb=postgres://user:pass@host/db';
    const result = redactSecrets(content);
    expect(result).toContain('[REDACTED:aws-key]');
    expect(result).toContain('[REDACTED:connection-string]');
  });

  // Context gate consistency with scanForSecrets (bead compile-then-govern-e06.15).
  it('does NOT redact a bare UUID in prose (heroku context gate)', () => {
    const content = 'The request id was 3f2504e0-4f89-41d3-9a0c-0305e82c3301 in the trace.';
    // No key-context → the heroku rule is suppressed, so the UUID is left intact
    // (matching the scanner, which no longer flags it).
    expect(redactSecrets(content)).toBe(content);
  });

  it('STILL redacts a real Heroku key in key-context (recall held)', () => {
    // The key MUST be gone (recall held). Note: in a `HEROKU_API_KEY=` string the
    // broader `env-secret` (`API_KEY=…`) rule runs first and redacts the whole
    // assignment, so the value is removed under that id — the context-gated
    // heroku rule is a backstop, not the only path. Either way, no leak.
    const content = 'HEROKU_API_KEY=3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const result = redactSecrets(content);
    expect(result).not.toContain('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(result).toContain('[REDACTED:');
  });

  it('redacts the Heroku key via the context-gated rule when no other rule fires', () => {
    // Reference the key with heroku/api-key WORDS (not an `API_KEY=` assignment),
    // so the env-secret rule does not pre-empt it — proving the context-gated
    // heroku rule itself fires and redacts when its context is present.
    const content = 'Heroku api key value: 3f2504e0-4f89-41d3-9a0c-0305e82c3301 rotate soon';
    const result = redactSecrets(content);
    expect(result).toContain('[REDACTED:heroku-api-key]');
    expect(result).not.toContain('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });
});
