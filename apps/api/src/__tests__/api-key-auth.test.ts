import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';

// ---------------------------------------------------------------------------
// API key auth — security-focused tests
// ---------------------------------------------------------------------------

describe('API key auth — timing-safe comparison', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDatabase();
    app = buildApp({ db, silent: true, apiKey: 'correct-key-abc123' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('valid key passes timing-safe comparison and returns non-401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { Authorization: 'Bearer correct-key-abc123' },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('wrong token on Bearer scheme is rejected via timing-safe path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { Authorization: 'Bearer wrong-key-xyz' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('token with same length as key but different content is rejected', async () => {
    // Same byte-length as 'correct-key-abc123' to exercise the equal-length
    // timingSafeEqual branch, not the fast-reject length-mismatch branch
    const sameLength = 'X'.repeat('correct-key-abc123'.length);
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { Authorization: `Bearer ${sameLength}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('token with different length is rejected (constant-time fallback branch)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { Authorization: 'Bearer short' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('API key auth — fail-closed in production', () => {
  it('throws when NODE_ENV=production and no API key is set', async () => {
    const original = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const db = createTestDatabase();
      try {
        expect(() => buildApp({ db, silent: true })).toThrow(/must be set in production/i);
      } finally {
        db.close();
      }
    } finally {
      process.env['NODE_ENV'] = original;
    }
  });

  it('does not throw when NODE_ENV=production and API key is provided', async () => {
    const original = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    let app: FastifyInstance | undefined;
    const db = createTestDatabase();
    try {
      expect(() => {
        app = buildApp({ db, silent: true, apiKey: 'prod-key-abc' });
      }).not.toThrow();
    } finally {
      process.env['NODE_ENV'] = original;
      await app?.close();
      db.close();
    }
  });
});

describe('API key auth — malformed Authorization headers', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDatabase();
    app = buildApp({ db, silent: true, apiKey: 'test-key-789' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('rejects Authorization header with no space separator', async () => {
    // e.g. "Bearertoken" — no space between scheme and token
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { Authorization: 'Bearertest-key-789' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects empty Authorization header value', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { Authorization: '' },
    });
    // Empty string header — 401 expected (missing token)
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-Bearer scheme even with correct token value', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { Authorization: 'Token test-key-789' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects Bearer with empty token (Bearer followed by space only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { Authorization: 'Bearer ' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('health endpoint is always exempt regardless of missing auth', async () => {
    // /api/health is always reachable without a token so liveness probes work
    // even when an API key is configured. Asserting 200 (not merely "not 401")
    // proves the real route is exempt, not that a 404 happens to dodge auth.
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });
});
