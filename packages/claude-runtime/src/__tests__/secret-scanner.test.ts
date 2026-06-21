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
