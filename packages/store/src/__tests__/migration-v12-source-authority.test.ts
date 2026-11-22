import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../database.js';
import { CandidateRepository } from '../repositories/candidate-repository.js';
import { makeCandidate } from './fixtures.js';

// Disposable prior-version fixture; no live store is opened or enrolled.
describe('source authority migration', () => {
  it('upgrades a v11 store without enrolling it or rewriting existing records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-authority-migration-'));
    const path = join(dir, 'test.db');
    let db = createDatabase({ path });
    try {
      db.exec('DROP TABLE source_classification_authority');
      db.exec('DELETE FROM schema_migrations WHERE version = 12');
      const { candidate, contentHash } = makeCandidate();
      new CandidateRepository(db).insert(candidate, contentHash);
      const before = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
      db.close();
      db = createDatabase({ path });
      expect(db.prepare('SELECT * FROM source_classification_authority').all()).toEqual([]);
      expect(new CandidateRepository(db).findById(candidate.id)).toEqual(candidate);
      expect(
        db.prepare('SELECT * FROM schema_migrations WHERE version < 12 ORDER BY version').all(),
      ).toEqual(before);
      db.prepare('INSERT INTO source_classification_authority VALUES (1, ?)').run(
        '{"fixture":true}',
      );
      expect(() =>
        db.prepare('INSERT INTO source_classification_authority VALUES (2, ?)').run('{}'),
      ).toThrow();
      expect(() =>
        db.prepare('INSERT INTO source_classification_authority VALUES (1, ?)').run('{}'),
      ).toThrow();
      db.close();
      db = createDatabase({ path });
      expect(db.prepare('SELECT registry_json FROM source_classification_authority').get()).toEqual(
        { registry_json: '{"fixture":true}' },
      );
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 12').get(),
      ).toEqual({ n: 1 });
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
