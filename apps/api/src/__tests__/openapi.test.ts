import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';

describe('GET /openapi.json', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDatabase();
    app = buildApp({ db, silent: true });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 200 and a valid OpenAPI 3.1 document that includes core paths', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);

    const spec = res.json<{
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      tags?: Array<{ name: string }>;
    }>();

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toMatch(/qmd Team Intent KB/i);
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/candidates']));
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/memories']));
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/audit/receipt-tip']));

    // Tag metadata should be propagated from route schemas.
    const tagNames = (spec.tags ?? []).map((t) => t.name);
    expect(tagNames).toEqual(expect.arrayContaining(['candidates', 'memories']));
  });

  it('serves the Swagger UI at /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/static/index.html' });
    // Swagger UI serves an HTML page; acceptable statuses are 200 or 302 (redirect to index).
    expect([200, 302]).toContain(res.statusCode);
  });
});
