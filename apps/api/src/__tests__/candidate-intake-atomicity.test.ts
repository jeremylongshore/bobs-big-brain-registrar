import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { CandidateRepository, createTestDatabase } from '@qmd-team-intent-kb/store';

import { buildApp } from '../app.js';
import { injectJson } from './assertions.js';
import { makeCandidate } from './fixtures.js';

describe('candidate intake atomicity', () => {
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

  it.each(['ABORT', 'IGNORE'])('rolls back a candidate when its receipt is %s', async (mode) => {
    const candidate = makeCandidate();
    const failure = mode === 'ABORT' ? "RAISE(ABORT, 'injected receipt fault')" : 'RAISE(IGNORE)';
    db.exec(`CREATE TRIGGER intake_fault BEFORE INSERT ON audit_events
      WHEN NEW.action = 'proposed' BEGIN SELECT ${failure}; END`);
    const result = await injectJson(app, 'POST', '/api/candidates', candidate);
    expect(result.status).toBe(500);
    expect(new CandidateRepository(db).findById(candidate['id'] as string)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 });

    db.exec('DROP TRIGGER intake_fault');
    const retry = await injectJson(app, 'POST', '/api/candidates', candidate);
    expect(retry.status).toBe(201);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'proposed'").get(),
    ).toEqual({ n: 1 });
  });

  it('refuses an ignored candidate write without leaving a receipt', async () => {
    db.exec(`CREATE TRIGGER intake_fault BEFORE INSERT ON candidates
      BEGIN SELECT RAISE(IGNORE); END`);
    const result = await injectJson(app, 'POST', '/api/candidates', makeCandidate());
    expect(result.status).toBe(500);
    expect(db.prepare('SELECT COUNT(*) AS n FROM candidates').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });

  it('rolls back candidate drift introduced by its proposal receipt', async () => {
    db.exec(`CREATE TRIGGER intake_fault AFTER INSERT ON audit_events
      WHEN NEW.action = 'proposed' BEGIN
        UPDATE candidates SET title = 'changed after capture' WHERE id = NEW.memory_id;
      END`);
    const candidate = makeCandidate();
    const result = await injectJson(app, 'POST', '/api/candidates', candidate);
    expect(result.status).toBe(500);
    expect(new CandidateRepository(db).findById(candidate['id'] as string)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });
});
