import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import { makeCandidate } from './fixtures.js';
import { injectJson } from './assertions.js';

/**
 * `metadata.subjects` on POST /api/candidates (the team-mode `brain_capture`
 * path). The intake schema is the shared MemoryCandidate, so subjects are
 * validated by the SubjectKey slug (<= 8 keys) and survive intake -> store ->
 * read. Absent subjects stay valid (every existing client).
 */
describe('/api/candidates — metadata.subjects', () => {
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

  const withSubjects = (subjects: unknown) => {
    const base = makeCandidate();
    return { ...base, metadata: { ...(base['metadata'] as object), subjects } };
  };

  it('accepts declared subjects and returns them on create and on read-back', async () => {
    const body = withSubjects(['hosting.vps', 'deploy-pipeline']);
    const res = await injectJson(app, 'POST', '/api/candidates', body);
    expect(res.status).toBe(201);
    expect((res.body as { metadata: { subjects?: string[] } }).metadata.subjects).toEqual([
      'hosting.vps',
      'deploy-pipeline',
    ]);

    const got = await injectJson(app, 'GET', `/api/candidates/${body['id']}`);
    expect(got.status).toBe(200);
    expect((got.body as { metadata: { subjects?: string[] } }).metadata.subjects).toEqual([
      'hosting.vps',
      'deploy-pipeline',
    ]);
  });

  it('stays backward compatible: a candidate without subjects is accepted unchanged', async () => {
    const res = await injectJson(app, 'POST', '/api/candidates', makeCandidate());
    expect(res.status).toBe(201);
    expect((res.body as { metadata: { subjects?: string[] } }).metadata.subjects).toBeUndefined();
  });

  it('accepts exactly 8 subjects and rejects 9 with 400', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => `topic-${i}`);
    expect((await injectJson(app, 'POST', '/api/candidates', withSubjects(eight))).status).toBe(
      201,
    );
    const nine = Array.from({ length: 9 }, (_, i) => `topic-${i}`);
    const res = await injectJson(app, 'POST', '/api/candidates', withSubjects(nine));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/Invalid candidate/);
  });

  it.each([['Hosting.GCP'], ['has space'], ['trailing.'], ['-lead'], [''], ['a'.repeat(97)]])(
    'rejects the invalid slug %j with 400',
    async (bad) => {
      const res = await injectJson(app, 'POST', '/api/candidates', withSubjects([bad]));
      expect(res.status).toBe(400);
    },
  );

  it('rejects a non-array subjects value with 400', async () => {
    const res = await injectJson(app, 'POST', '/api/candidates', withSubjects('hosting.vps'));
    expect(res.status).toBe(400);
  });
});
