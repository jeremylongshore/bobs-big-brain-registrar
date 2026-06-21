import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import { isLoopbackHost } from '../middleware/api-key-auth.js';

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

// ---------------------------------------------------------------------------
// No-auth path is loopback-only — never admin-stamp off-host (EPIC 0)
// ---------------------------------------------------------------------------

describe('isLoopbackHost', () => {
  it('treats loopback / localhost / IPv6 loopback as loopback', () => {
    // '' is intentionally NOT in this list — see the empty-host regression
    // below. A whitespace-padded real loopback ('  127.0.0.1  ') stays true
    // because .trim() reduces it to a genuine loopback address.
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '  127.0.0.1  ']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('treats tailnet / LAN / wildcard binds as NON-loopback', () => {
    for (const h of ['0.0.0.0', '100.88.144.55', '10.0.0.5', '192.168.1.10', '167.86.106.29']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  // Regression for compile-then-govern-c5k.3: an empty / whitespace-only host
  // must NOT be classified as loopback. Node/libuv binds '' to :: (all
  // interfaces); the prior `h === ''` true-arm let an unauthenticated brain be
  // reachable off-host while still passing the boot assertion. Before the fix
  // both of these returned true.
  it('treats an empty / whitespace-only host as NON-loopback', () => {
    for (const h of ['', '   ', '\t', '\n', '  \t  ']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('no-auth path refuses to bind a non-loopback interface', () => {
  it('throws when the registry is empty AND the bind host is non-loopback', () => {
    // Ensure NODE_ENV is not "production" so this exercises the off-loopback
    // assertion specifically, not the production fail-closed branch.
    const original = process.env['NODE_ENV'];
    delete process.env['NODE_ENV'];
    const db = createTestDatabase();
    try {
      expect(() => buildApp({ db, silent: true, bindHost: '0.0.0.0' })).toThrow(
        /non-loopback interface/i,
      );
      expect(() => buildApp({ db, silent: true, bindHost: '100.88.144.55' })).toThrow(
        /non-loopback interface/i,
      );
    } finally {
      if (original === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = original;
      db.close();
    }
  });

  it('throws when the registry is empty AND the bind host is empty (binds :: otherwise)', () => {
    // Regression for compile-then-govern-c5k.3: a caller that constructs
    // AppDependencies with bindHost:'' bypasses loadConfig's coercion. With the
    // fix isLoopbackHost('') === false, so the off-loopback boot refusal fires
    // rather than letting an unauthenticated brain bind all interfaces.
    const original = process.env['NODE_ENV'];
    delete process.env['NODE_ENV'];
    const db = createTestDatabase();
    try {
      expect(() => buildApp({ db, silent: true, bindHost: '' })).toThrow(/non-loopback interface/i);
      expect(() => buildApp({ db, silent: true, bindHost: '   ' })).toThrow(
        /non-loopback interface/i,
      );
    } finally {
      if (original === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = original;
      db.close();
    }
  });

  it('allows no-auth dev on loopback (default bind) and runs as admin', async () => {
    const original = process.env['NODE_ENV'];
    delete process.env['NODE_ENV'];
    const db = createTestDatabase();
    let app: FastifyInstance | undefined;
    try {
      // Default bindHost is 127.0.0.1 — loopback dev no-auth is permitted.
      app = buildApp({ db, silent: true });
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
    } finally {
      if (original === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = original;
      await app?.close();
      db.close();
    }
  });

  it('allows a non-loopback bind when tokens ARE configured (auth present)', async () => {
    const db = createTestDatabase();
    let app: FastifyInstance | undefined;
    try {
      // Off-loopback is fine the moment real auth exists — the refusal is
      // specifically about an UNAUTHENTICATED off-host brain.
      expect(() => {
        app = buildApp({
          db,
          silent: true,
          bindHost: '100.88.144.55',
          tokens: [{ token: 't', actor: 'a', role: 'admin' }],
        });
      }).not.toThrow();
      await app?.ready();
    } finally {
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
