/**
 * Write-time provenance origin tokens (GSB Wave-2 H1) — mint/verify round-trip,
 * forgery/tamper negatives, receipt-hash truncation (H2), and the on-disk
 * per-installation secret lifecycle (0600, idempotent, env override).
 */
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildOriginTokenPayload,
  hashOriginToken,
  loadOriginSecret,
  loadOrCreateOriginSecret,
  mintOriginToken,
  originSecretPath,
  ORIGIN_SECRET_ENV,
  ORIGIN_TOKEN_HASH_SURFACE_LEN,
  verifyOriginToken,
} from '../origin-token.js';

const IDENTITY = {
  candidateId: '6c6f6e67-7368-6f72-6500-69636f73706c',
  tenantId: 'team-alpha',
  capturedAt: '2026-01-15T10:00:00.000Z',
};
const SECRET = 'f'.repeat(64);

describe('mint/verify round-trip', () => {
  it('a minted token verifies under the same secret and identity', () => {
    const token = mintOriginToken(SECRET, IDENTITY);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyOriginToken(SECRET, IDENTITY, token)).toBe(true);
  });

  it('is deterministic — same inputs mint the same token', () => {
    expect(mintOriginToken(SECRET, IDENTITY)).toBe(mintOriginToken(SECRET, IDENTITY));
  });

  it('a token minted under a DIFFERENT secret does not verify (forgery)', () => {
    const forged = mintOriginToken('0'.repeat(64), IDENTITY);
    expect(verifyOriginToken(SECRET, IDENTITY, forged)).toBe(false);
  });

  it('a valid token replayed over a different identity tuple does not verify', () => {
    const token = mintOriginToken(SECRET, IDENTITY);
    expect(verifyOriginToken(SECRET, { ...IDENTITY, tenantId: 'team-beta' }, token)).toBe(false);
    expect(
      verifyOriginToken(SECRET, { ...IDENTITY, capturedAt: '2026-01-15T10:00:01.000Z' }, token),
    ).toBe(false);
    expect(
      verifyOriginToken(
        SECRET,
        { ...IDENTITY, candidateId: '00000000-0000-4000-8000-000000000001' },
        token,
      ),
    ).toBe(false);
  });

  it('rejects malformed tokens without throwing (uppercase, short, non-hex)', () => {
    const token = mintOriginToken(SECRET, IDENTITY);
    expect(verifyOriginToken(SECRET, IDENTITY, token.toUpperCase())).toBe(false);
    expect(verifyOriginToken(SECRET, IDENTITY, token.slice(0, 32))).toBe(false);
    expect(verifyOriginToken(SECRET, IDENTITY, 'z'.repeat(64))).toBe(false);
    expect(verifyOriginToken(SECRET, IDENTITY, '')).toBe(false);
  });

  it('NUL-joins the identity tuple injectively (no field-boundary collision)', () => {
    // "ab"+"c" vs "a"+"bc" across the candidateId/tenantId boundary must differ.
    const a = mintOriginToken(SECRET, { candidateId: 'ab', tenantId: 'c', capturedAt: 'x' });
    const b = mintOriginToken(SECRET, { candidateId: 'a', tenantId: 'bc', capturedAt: 'x' });
    expect(a).not.toBe(b);
    expect(buildOriginTokenPayload(IDENTITY)).toContain(String.fromCharCode(0));
  });
});

describe('receipt hashing (H2 — never enough to replay-mint)', () => {
  it('hashOriginToken is a one-way SHA-256 of the token, distinct from it', () => {
    const token = mintOriginToken(SECRET, IDENTITY);
    const hash = hashOriginToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    // The truncated surface form is 16 hex chars — far below token material.
    expect(hash.slice(0, ORIGIN_TOKEN_HASH_SURFACE_LEN)).toHaveLength(16);
  });
});

describe('per-installation secret file', () => {
  let base: string;
  const savedEnv = process.env[ORIGIN_SECRET_ENV];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'origin-secret-'));
    delete process.env[ORIGIN_SECRET_ENV];
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env[ORIGIN_SECRET_ENV];
    else process.env[ORIGIN_SECRET_ENV] = savedEnv;
  });

  it('auto-creates a 64-hex secret with mode 0600 on first use, then is idempotent', () => {
    const first = loadOrCreateOriginSecret(base);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const mode = statSync(originSecretPath(base)).mode & 0o777;
    expect(mode).toBe(0o600);
    // Second call reads the same secret — no re-mint.
    expect(loadOrCreateOriginSecret(base)).toBe(first);
    expect(readFileSync(originSecretPath(base), 'utf8').trim()).toBe(first);
  });

  it('loadOriginSecret never creates the file (team-client safety)', () => {
    expect(loadOriginSecret(base)).toBeUndefined();
    expect(existsSync(originSecretPath(base))).toBe(false);
  });

  it('the env override wins over the file and is never written to disk', () => {
    process.env[ORIGIN_SECRET_ENV] = 'e'.repeat(64);
    expect(loadOriginSecret(base)).toBe('e'.repeat(64));
    expect(loadOrCreateOriginSecret(base)).toBe('e'.repeat(64));
    expect(existsSync(originSecretPath(base))).toBe(false);
  });
});
