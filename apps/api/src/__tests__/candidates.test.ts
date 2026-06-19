import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import { makeCandidate, NOW } from './fixtures.js';
import { injectJson } from './assertions.js';

describe('/api/candidates', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDatabase();
    app = buildApp({ db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  // ---- POST /api/candidates ------------------------------------------------

  it('POST creates a candidate and returns 201', async () => {
    const body = makeCandidate();
    const res = await injectJson(app, 'POST', '/api/candidates', body);
    expect(res.status).toBe(201);
    const created = res.body as { id: string; status: string };
    expect(created.id).toBe(body['id']);
    expect(created.status).toBe('inbox');
  });

  it('POST with invalid data returns 400', async () => {
    const res = await injectJson(app, 'POST', '/api/candidates', {
      title: 'Missing required fields',
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/Invalid candidate/);
  });

  it('POST with missing required fields returns 400', async () => {
    const res = await injectJson(app, 'POST', '/api/candidates', {
      id: randomUUID(),
      status: 'inbox',
    });
    expect(res.status).toBe(400);
  });

  it('POST computes and stores a content hash', async () => {
    const content = 'Unique content for hash test';
    const body = makeCandidate({ content });
    const res = await injectJson(app, 'POST', '/api/candidates', body);
    expect(res.status).toBe(201);
    // Verify the candidate is retrievable (hash stored internally)
    const candidate = res.body as { id: string };
    const getRes = await injectJson(app, 'GET', `/api/candidates/${candidate.id}`);
    expect(getRes.status).toBe(200);
    expect((getRes.body as { content: string }).content).toBe(content);
  });

  it('POST accepts duplicate candidates with different IDs', async () => {
    const content = 'Shared content between two candidates';
    const first = makeCandidate({ content });
    const second = makeCandidate({ content, id: randomUUID() });

    const r1 = await injectJson(app, 'POST', '/api/candidates', first);
    const r2 = await injectJson(app, 'POST', '/api/candidates', second);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
  });

  it('POST with full metadata fields succeeds', async () => {
    const body = makeCandidate({
      metadata: {
        filePaths: ['src/api.ts', 'src/auth.ts'],
        language: 'typescript',
        projectContext: 'backend api',
        sessionId: 'session-abc',
        tags: ['api', 'auth'],
      },
      prePolicyFlags: {
        potentialSecret: true,
        lowConfidence: false,
        duplicateSuspect: true,
      },
    });
    const res = await injectJson(app, 'POST', '/api/candidates', body);
    expect(res.status).toBe(201);
    const created = res.body as { metadata: { filePaths: string[] } };
    expect(created.metadata.filePaths).toEqual(['src/api.ts', 'src/auth.ts']);
  });

  // ---- POST disclosure gate (bead 3iu.1) -----------------------------------

  it('POST with compensation content is rejected 422', async () => {
    const body = makeCandidate({ content: 'his base salary and 4-year vesting schedule' });
    const res = await injectJson(app, 'POST', '/api/candidates', body);
    expect(res.status).toBe(422);
    expect((res.body as { error: string }).error).toMatch(/compensation/i);
  });

  it('POST with PII content is rejected 422', async () => {
    const body = makeCandidate({ content: 'candidate SSN 123-45-6789 from the background-check' });
    const res = await injectJson(app, 'POST', '/api/candidates', body);
    expect(res.status).toBe(422);
    expect((res.body as { error: string }).error).toMatch(/PII/);
  });

  it('POST with a disclosure violation in the title is rejected 422', async () => {
    const body = makeCandidate({ title: 'launch bonus terms', content: 'clean body' });
    const res = await injectJson(app, 'POST', '/api/candidates', body);
    expect(res.status).toBe(422);
  });

  it('POST 422 error does NOT echo the flagged value back', async () => {
    const body = makeCandidate({ content: 'SSN 123-45-6789' });
    const res = await injectJson(app, 'POST', '/api/candidates', body);
    expect(res.status).toBe(422);
    expect((res.body as { error: string }).error).not.toContain('123-45-6789');
  });

  it('POST with a bare technical ratio-split (no comp context) still succeeds 201', async () => {
    const body = makeCandidate({ content: 'route a 60/40 traffic split between regions' });
    const res = await injectJson(app, 'POST', '/api/candidates', body);
    expect(res.status).toBe(201);
  });

  // ---- GET /api/candidates/:id ---------------------------------------------

  it('GET /:id returns the stored candidate', async () => {
    const body = makeCandidate();
    await app.inject({ method: 'POST', url: '/api/candidates', payload: body });

    const res = await injectJson(app, 'GET', `/api/candidates/${body['id'] as string}`);
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(body['id']);
  });

  it('GET /:id for non-existent returns 404', async () => {
    const res = await injectJson(app, 'GET', `/api/candidates/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/not found/i);
  });

  // ---- GET /api/candidates -------------------------------------------------

  it('GET list with tenantId filter returns matching candidates', async () => {
    const alpha = makeCandidate({ tenantId: 'team-alpha' });
    const beta = makeCandidate({ tenantId: 'team-beta', content: 'Beta-specific content' });
    await app.inject({ method: 'POST', url: '/api/candidates', payload: alpha });
    await app.inject({ method: 'POST', url: '/api/candidates', payload: beta });

    const res = await injectJson(app, 'GET', '/api/candidates?tenantId=team-alpha');
    expect(res.status).toBe(200);
    const list = res.body as Array<{ tenantId: string }>;
    expect(list.every((c) => c.tenantId === 'team-alpha')).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('GET list without tenantId returns 400', async () => {
    const res = await injectJson(app, 'GET', '/api/candidates');
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/tenantId/);
  });

  it('POST preserves capturedAt timestamp exactly', async () => {
    const body = makeCandidate({ capturedAt: NOW });
    const res = await injectJson(app, 'POST', '/api/candidates', body);
    expect(res.status).toBe(201);
    expect((res.body as { capturedAt: string }).capturedAt).toBe(NOW);
  });
});
