import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import { makeCandidate } from './fixtures.js';

/**
 * Per-actor capture quota on POST /api/candidates (jfv.10). buildApp({ db }) runs
 * dev mode = every request is actor 'dev', so all POSTs share one quota bucket.
 */
describe('capture quota — per-actor cap on candidate intake (jfv.10)', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDatabase();
    app = buildApp({ db, silent: true, captureQuotaMax: 2, captureQuotaWindowMs: 60_000 });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const post = (content: string) =>
    app.inject({ method: 'POST', url: '/api/candidates', payload: makeCandidate({ content }) });

  it('429s the (N+1)th intake from one actor within the window', async () => {
    // maxCaptures = 2 → the 3rd POST is over quota.
    expect((await post('first distinct proposal aaaa')).statusCode).toBe(201);
    expect((await post('second distinct proposal bbbb')).statusCode).toBe(201);
    const third = await post('third distinct proposal cccc');
    expect(third.statusCode).toBe(429);
    expect(
      (third.json() as { message?: string; error?: string }).message ??
        (third.json() as { error?: string }).error,
    ).toMatch(/quota exceeded/i);
  });

  it('does NOT count reads or other paths against the capture quota', async () => {
    // Two GETs + a POST to a different path do not consume the capture bucket.
    await app.inject({ method: 'GET', url: '/api/candidates?tenantId=team-alpha' });
    await app.inject({ method: 'GET', url: '/api/health' });
    // The capture bucket is still empty → two intakes succeed.
    expect((await post('proposal after some reads dddd')).statusCode).toBe(201);
    expect((await post('another proposal eeee')).statusCode).toBe(201);
  });
});
