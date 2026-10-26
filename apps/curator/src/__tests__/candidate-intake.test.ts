import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { computeContentHash, deriveAuditEventId } from '@qmd-team-intent-kb/common';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  createTestDatabase,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { makeCandidate } from '@qmd-team-intent-kb/test-fixtures';

import { CandidateIntake, intakeCandidate } from '../intake/candidate-intake.js';

describe('canonical audited candidate intake', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDatabase();
  });
  afterEach(() => {
    db.close();
  });

  const actor = { actor: 'reviewer', role: 'member' as const, tenants: ['team-alpha'] };

  it('persists the overridden candidate and exact proposal receipt on one store', () => {
    const data = makeCandidate({
      trustLevel: 'high',
      tenantId: 'team-other',
      metadata: {
        filePaths: ['src/intake.ts'],
        tags: ['capture'],
        subjects: ['capture-boundary'],
        audience: 'owner',
      },
    });
    const result = intakeCandidate(data, db, actor);
    expect(result.intake).toBe('created');
    expect(result.candidate).toMatchObject({
      tenantId: 'team-alpha',
      trustLevel: 'untrusted',
      author: { type: 'human', id: 'reviewer' },
      metadata: {
        proposedByRole: 'member',
        filePaths: ['src/intake.ts'],
        tags: ['capture'],
        subjects: ['capture-boundary'],
        audience: 'owner',
      },
      prePolicyFlags: { potentialSecret: false, duplicateSuspect: false, lowConfidence: false },
    });
    expect(new CandidateRepository(db).findById(result.candidate.id)).toEqual(result.candidate);
    const events = new AuditRepository(db).findByMemoryAndTenant(result.candidate.id, 'team-alpha');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: deriveAuditEventId(result.candidate.id, 'proposed'),
      action: 'proposed',
      memoryId: result.candidate.id,
      tenantId: 'team-alpha',
      actor: { type: 'human', id: 'reviewer' },
      details: {
        candidateId: result.candidate.id,
        contentHash: computeContentHash(result.candidate.content),
        tenantId: 'team-alpha',
        proposedByRole: 'member',
      },
    });
    expect(events[0]!.timestamp).toBe(events[0]!.details['at']);
    expect(verifyAuditChain(new AuditRepository(db)).breaks).toEqual([]);
  });

  it('returns actual first-write identity for ID and content retries without new receipts', () => {
    const first = intakeCandidate(makeCandidate(), db);
    const idReplay = intakeCandidate(
      { ...first.candidate, content: 'a different distillation' },
      db,
    );
    const hashReplay = intakeCandidate({ ...first.candidate, id: randomUUID() }, db);
    expect(idReplay).toEqual({ candidate: first.candidate, intake: 'already_exists' });
    expect(hashReplay).toEqual(idReplay);
    expect(db.prepare('SELECT COUNT(*) AS n FROM candidates').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 1 });
  });

  it('refuses an ID collision across tenants and retains the first row and receipt', () => {
    const first = intakeCandidate(makeCandidate(), db);
    expect(() => intakeCandidate({ ...first.candidate, tenantId: 'team-other' }, db)).toThrow(
      /another tenant/,
    );
    expect(new CandidateRepository(db).findById(first.candidate.id)).toEqual(first.candidate);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 1 });
  });

  it('keeps identical content in different tenants independent', () => {
    const first = intakeCandidate(makeCandidate(), db);
    const other = intakeCandidate(
      { ...first.candidate, id: randomUUID(), tenantId: 'team-other' },
      db,
    );
    expect(other.intake).toBe('created');
    expect(other.candidate.tenantId).toBe('team-other');
    expect(db.prepare('SELECT COUNT(*) AS n FROM candidates').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 2 });
  });

  it('refuses repositories on different connections before any write', () => {
    const other = createTestDatabase();
    try {
      const intake = new CandidateIntake(new CandidateRepository(db), new AuditRepository(other));
      expect(() => intake.intake(makeCandidate())).toThrow(/one shared database connection/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM candidates').get()).toEqual({ n: 0 });
      expect(other.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
    } finally {
      other.close();
    }
  });

  it('does not commit independently of an enclosing transaction', () => {
    expect(() =>
      db
        .transaction(() => {
          intakeCandidate(makeCandidate(), db);
          throw new Error('outer rollback');
        })
        .immediate(),
    ).toThrow('outer rollback');
    expect(db.prepare('SELECT COUNT(*) AS n FROM candidates').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });

  it.each(['receipt', 'hash'])(
    'rolls back %s drift after insertion and accepts the identical retry after fault removal',
    (field) => {
      const change =
        field === 'receipt'
          ? "UPDATE audit_events SET reason = 'altered receipt' WHERE id = NEW.id;"
          : "UPDATE candidates SET content_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id = NEW.memory_id;";
      db.exec(`CREATE TRIGGER intake_fault AFTER INSERT ON audit_events
      WHEN NEW.action = 'proposed' BEGIN ${change} END`);
      const data = makeCandidate();
      expect(() => intakeCandidate(data, db)).toThrow(/did not retain/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM candidates').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
      db.exec('DROP TRIGGER intake_fault');
      expect(intakeCandidate(data, db).intake).toBe('created');
    },
  );

  it('preserves explicitly unaudited construction without fabricating receipts', () => {
    const result = new CandidateIntake(new CandidateRepository(db)).intake(makeCandidate());
    expect(result.intake).toBe('created');
    expect(new CandidateRepository(db).findById(result.candidate.id)).toEqual(result.candidate);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });

  it('returns a legacy stored candidate without fabricating a missing historical receipt', () => {
    const candidate = MemoryCandidate.parse(makeCandidate());
    new CandidateRepository(db).insert(candidate, computeContentHash(candidate.content));
    expect(intakeCandidate(candidate, db).intake).toBe('already_exists');
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });
});
