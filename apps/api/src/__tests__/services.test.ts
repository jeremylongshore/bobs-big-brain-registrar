import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createTestDatabase,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
} from '@qmd-team-intent-kb/store';
import { CandidateService } from '../services/candidate-service.js';
import { MemoryService } from '../services/memory-service.js';
import { PolicyService } from '../services/policy-service.js';
import { HealthService } from '../services/health-service.js';
import { ApiError } from '../errors.js';
import { makeCandidate, makeMemory, makePolicy, NOW } from './fixtures.js';

describe('CandidateService', () => {
  let db: Database.Database;
  let repo: CandidateRepository;
  let service: CandidateService;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new CandidateRepository(db);
    service = new CandidateService(repo);
  });

  it('intake validates and inserts a candidate', () => {
    const data = makeCandidate();
    const candidate = service.intake(data).candidate;
    expect(candidate.id).toBe(data['id']);
    expect(candidate.status).toBe('inbox');
    // Verify persistence
    const fromRepo = repo.findById(candidate.id);
    expect(fromRepo).not.toBeNull();
  });

  it('intake rejects invalid data with a 400 ApiError', () => {
    expect(() => service.intake({ title: 'No required fields' })).toThrow(ApiError);
    expect(() => service.intake({ title: 'No required fields' })).toThrow(/Invalid candidate/);
  });

  it('getById throws 404 ApiError for unknown id', () => {
    expect(() => service.getById('00000000-0000-0000-0000-000000000000')).toThrow(ApiError);
    try {
      service.getById('00000000-0000-0000-0000-000000000000');
    } catch (err) {
      expect(err instanceof ApiError).toBe(true);
      if (err instanceof ApiError) {
        expect(err.statusCode).toBe(404);
      }
    }
  });

  // ---- R10: intake early-check scans metadata odd fields --------------------
  //
  // 010-AT-RISK R10 / bead compile-then-govern-e06.3: the intake() early-check
  // used to scan only content/title/tags, so a secret or PII hidden in
  // metadata.filePaths / projectContext bypassed THIS boundary and only tripped
  // the deeper repository backstop. These tests use a SPY repo whose insert()
  // throws if reached, so a clean 422 with insert() NEVER called proves the
  // EARLY gate — not the backstop — now catches the odd-field leak.

  /** A CandidateRepository double whose insert() fails the test if reached. */
  function spyRepo(): { repo: CandidateRepository; inserted: () => boolean } {
    let didInsert = false;
    const stub = {
      insert: () => {
        didInsert = true;
        throw new Error('repo.insert reached — the intake early-check did NOT gate this leak');
      },
      findById: () => null,
      findByTenant: () => [],
      findByContentHash: () => null,
    } as unknown as CandidateRepository;
    return { repo: stub, inserted: () => didInsert };
  }

  it('intake rejects an SSN hidden in metadata.filePaths at the early-check (R10)', () => {
    const { repo: stub, inserted } = spyRepo();
    const svc = new CandidateService(stub);
    const data = makeCandidate({
      content: 'a perfectly ordinary architecture note',
      metadata: { filePaths: ['/records/patient-123-45-6789.txt'], tags: [] },
    });
    let status = 0;
    try {
      svc.intake(data);
    } catch (err) {
      if (err instanceof ApiError) status = err.statusCode;
    }
    expect(status).toBe(422);
    // The early gate fired BEFORE the repository backstop.
    expect(inserted()).toBe(false);
  });

  it('intake rejects a credential hidden in metadata.projectContext at the early-check (R10)', () => {
    const { repo: stub, inserted } = spyRepo();
    const svc = new CandidateService(stub);
    const data = makeCandidate({
      content: 'note about the deploy pipeline',
      metadata: {
        filePaths: [],
        tags: [],
        projectContext: 'onboarding for AKIAIOSFODNN7EXAMPLE',
      },
    });
    let status = 0;
    try {
      svc.intake(data);
    } catch (err) {
      if (err instanceof ApiError) status = err.statusCode;
    }
    expect(status).toBe(422);
    expect(inserted()).toBe(false);
  });

  it('intake 422 for an odd-field leak does NOT echo the flagged value back (R10)', () => {
    const { repo: stub } = spyRepo();
    const svc = new CandidateService(stub);
    const data = makeCandidate({
      content: 'clean',
      metadata: { filePaths: ['/records/patient-123-45-6789.txt'], tags: [] },
    });
    try {
      svc.intake(data);
      throw new Error('expected intake to reject');
    } catch (err) {
      if (err instanceof ApiError) {
        expect(err.message).not.toContain('123-45-6789');
      }
    }
  });

  // ---- R10 gap closure: tenantId + author free-text (Gemini HIGH) -----------
  //
  // The early-check's hand-maintained field list MISSED `tenantId` and the
  // `author` free-text (`author.name` / `author.id`) even though the repository
  // backstop (`assertDisclosureClean`) already scanned them — a bypass where a
  // secret / PII hidden there slipped the EARLY gate and only tripped the deeper
  // choke point. The fix derives the scanned set structurally via
  // `collectFreeTextFields`, so the early gate now covers exactly the backstop's
  // fields. These SPY-repo tests prove the early gate — not the backstop — now
  // fires on those two surfaces (insert() never reached).

  it('intake rejects an SSN hidden in tenantId at the early-check (R10 gap)', () => {
    const { repo: stub, inserted } = spyRepo();
    const svc = new CandidateService(stub);
    const data = makeCandidate({
      content: 'an ordinary architecture note',
      tenantId: 'ssn-123-45-6789',
    });
    let status = 0;
    try {
      svc.intake(data);
    } catch (err) {
      if (err instanceof ApiError) status = err.statusCode;
    }
    expect(status).toBe(422);
    // The early gate fired BEFORE the repository backstop.
    expect(inserted()).toBe(false);
  });

  it('intake rejects a credential hidden in author.name at the early-check (R10 gap)', () => {
    const { repo: stub, inserted } = spyRepo();
    const svc = new CandidateService(stub);
    const data = makeCandidate({
      content: 'note about the deploy pipeline',
      author: { type: 'ai', id: 'claude-1', name: 'AKIAIOSFODNN7EXAMPLE' },
    });
    let status = 0;
    try {
      svc.intake(data);
    } catch (err) {
      if (err instanceof ApiError) status = err.statusCode;
    }
    expect(status).toBe(422);
    expect(inserted()).toBe(false);
  });

  it('intake rejects an SSN hidden in author.id at the early-check (R10 gap)', () => {
    const { repo: stub, inserted } = spyRepo();
    const svc = new CandidateService(stub);
    const data = makeCandidate({
      content: 'clean body',
      author: { type: 'human', id: '123-45-6789' },
    });
    let status = 0;
    try {
      svc.intake(data);
    } catch (err) {
      if (err instanceof ApiError) status = err.statusCode;
    }
    expect(status).toBe(422);
    expect(inserted()).toBe(false);
  });

  it('intake 422 for a tenantId leak does NOT echo the flagged value back (R10 gap)', () => {
    const { repo: stub } = spyRepo();
    const svc = new CandidateService(stub);
    const data = makeCandidate({
      content: 'clean',
      tenantId: 'ssn-123-45-6789',
    });
    try {
      svc.intake(data);
      throw new Error('expected intake to reject');
    } catch (err) {
      if (err instanceof ApiError) {
        expect(err.message).not.toContain('123-45-6789');
      }
    }
  });

  it('intake still accepts a clean candidate with benign metadata (R10 precision guard)', () => {
    // Uses the REAL repo so the accept path runs end-to-end (backstop included).
    const data = makeCandidate({
      content: 'the store layer keeps raw and derived content separate',
      metadata: {
        filePaths: ['packages/store/src/repositories/policy-repository.ts'],
        tags: ['store'],
        projectContext: 'governed brain intake',
      },
    });
    const candidate = service.intake(data).candidate;
    expect(candidate.id).toBe(data['id']);
    expect(repo.findById(candidate.id)).not.toBeNull();
  });
});

describe('MemoryService', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let auditRepo: AuditRepository;
  let service: MemoryService;

  beforeEach(() => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    auditRepo = new AuditRepository(db);
    service = new MemoryService(memoryRepo, auditRepo);
  });

  it('transition validates allowed lifecycle transitions', () => {
    const memory = makeMemory({ lifecycle: 'active' });
    memoryRepo.insert(memory);

    const result = service.transition(memory.id, 'deprecated', {
      reason: 'No longer maintained',
      actor: { type: 'human', id: 'user-1', name: 'Test User' },
    });
    expect(result.lifecycle).toBe('deprecated');
  });

  it('transition rejects disallowed lifecycle transitions with 400', () => {
    const memory = makeMemory({ lifecycle: 'archived' });
    memoryRepo.insert(memory);

    expect(() =>
      service.transition(memory.id, 'active', {
        reason: 'Attempt to reactivate',
        actor: { type: 'human', id: 'user-1' },
      }),
    ).toThrow(ApiError);
  });

  it('transition creates a corresponding audit trail entry', () => {
    const memory = makeMemory({ lifecycle: 'active', tenantId: 'team-audit' });
    memoryRepo.insert(memory);

    service.transition(memory.id, 'archived', {
      reason: 'Archiving',
      actor: { type: 'human', id: 'user-1', name: 'Test User' },
    });

    const events = auditRepo.findByMemory(memory.id);
    expect(events.length).toBe(1);
    expect(events[0]?.action).toBe('archived');
    expect(events[0]?.tenantId).toBe('team-audit');
  });

  // --- governed recategorization (5bm.7) --------------------------------------

  it('recategorize corrects the category in place and returns the updated memory', () => {
    const memory = makeMemory({ category: 'reference' });
    memoryRepo.insert(memory);

    const result = service.recategorize(memory.id, {
      category: 'decision',
      reason: 'Miscompiled — this is a decision record',
      actor: { type: 'human', id: 'user-1', name: 'Test User' },
    });

    expect(result.category).toBe('decision');
    expect(memoryRepo.findById(memory.id)?.category).toBe('decision');
  });

  it('recategorize writes a receipted audit event with from/to categories', () => {
    const memory = makeMemory({ category: 'reference', tenantId: 'team-recat' });
    memoryRepo.insert(memory);

    service.recategorize(memory.id, {
      category: 'architecture',
      reason: 'Belongs in architecture',
      actor: { type: 'human', id: 'user-1', name: 'Test User' },
    });

    const events = auditRepo.findByMemory(memory.id);
    expect(events.length).toBe(1);
    expect(events[0]?.action).toBe('recategorized');
    expect(events[0]?.tenantId).toBe('team-recat');
    expect(events[0]?.details).toMatchObject({
      fromCategory: 'reference',
      toCategory: 'architecture',
    });
  });

  it('recategorize rejects a same-category no-op with 400', () => {
    const memory = makeMemory({ category: 'pattern' });
    memoryRepo.insert(memory);
    expect(() =>
      service.recategorize(memory.id, {
        category: 'pattern',
        reason: 'no change',
        actor: { type: 'human', id: 'user-1' },
      }),
    ).toThrow(ApiError);
    // No spurious audit event on a rejected no-op.
    expect(auditRepo.findByMemory(memory.id).length).toBe(0);
  });

  it('recategorize throws 404 for a missing memory', () => {
    expect(() =>
      service.recategorize('00000000-0000-4000-8000-000000000000', {
        category: 'decision',
        reason: 'x',
        actor: { type: 'human', id: 'user-1' },
      }),
    ).toThrow(ApiError);
  });

  it('recategorize rejects an invalid request body with 400', () => {
    const memory = makeMemory();
    memoryRepo.insert(memory);
    expect(() => service.recategorize(memory.id, { category: 'not-a-category' })).toThrow(ApiError);
  });

  describe.each(['transition', 'recategorize'] as const)('%s receipt atomicity', (operation) => {
    const actor = { type: 'human' as const, id: 'atomicity-reviewer' };

    function apply(id: string) {
      return operation === 'transition'
        ? service.transition(id, 'deprecated', { reason: 'Correct obsolete guidance', actor })
        : service.recategorize(id, {
            category: 'architecture',
            reason: 'Correct classification',
            actor,
          });
    }

    function seed() {
      const earlier = makeMemory({ lifecycle: 'active' });
      memoryRepo.insert(earlier);
      service.transition(earlier.id, 'deprecated', { reason: 'Earlier receipt', actor });
      const memory = makeMemory({ lifecycle: 'active', category: 'reference' });
      memoryRepo.insert(memory);
      return {
        id: memory.id,
        before: memoryRepo.findById(memory.id),
        auditBefore: auditRepo.findAllChronological(),
      };
    }

    it('rolls back a real audit insert and memory change on failure, then retries once', () => {
      const { id, before, auditBefore } = seed();
      const insert = auditRepo.insert.bind(auditRepo);
      const fault = vi.spyOn(auditRepo, 'insert').mockImplementationOnce((event) => {
        insert(event); // Exercise the real nested audit transaction before failing.
        throw new Error('Injected failure after audit insert');
      });
      try {
        expect(() => apply(id)).toThrow('Injected failure after audit insert');
      } finally {
        fault.mockRestore();
      }
      expect(memoryRepo.findById(id)).toEqual(before); // Includes lifecycle/category/updatedAt.
      expect(auditRepo.findAllChronological()).toEqual(auditBefore);
      expect(db.inTransaction).toBe(false);

      const updated = apply(id);
      expect(memoryRepo.findById(id)).toEqual(updated);
      expect(updated.updatedAt).not.toBe(before?.updatedAt);
      expect(updated.lifecycle).toBe(operation === 'transition' ? 'deprecated' : 'active');
      expect(updated.category).toBe(operation === 'recategorize' ? 'architecture' : 'reference');
      const events = auditRepo.findByMemory(id);
      expect(events).toHaveLength(1);
      expect(events[0]?.actor).toEqual(actor);
      expect(events[0]?.action).toBe(operation === 'transition' ? 'demoted' : 'recategorized');
      expect(events[0]?.details).toEqual(
        operation === 'transition'
          ? { from: 'active', to: 'deprecated' }
          : { fromCategory: 'reference', toCategory: 'architecture' },
      );
      const tail = auditRepo.findAllChronological();
      expect(tail).toHaveLength(auditBefore.length + 1);
      expect(tail.at(-1)?.prev_entry_hash).toBe(auditBefore.at(-1)?.entry_hash);
    });

    it('leaves the caller transaction open and rolls back with its outer failure', () => {
      const { id, before, auditBefore } = seed();
      expect(() =>
        db.transaction(() => {
          const updated = apply(id);
          expect(db.inTransaction).toBe(true);
          expect(memoryRepo.findById(id)).toEqual(updated);
          expect(auditRepo.findByMemory(id)).toHaveLength(1);
          throw new Error('Outer caller rolls back');
        })(),
      ).toThrow('Outer caller rolls back');
      expect(memoryRepo.findById(id)).toEqual(before);
      expect(auditRepo.findAllChronological()).toEqual(auditBefore);
      expect(db.inTransaction).toBe(false);
      apply(id);
      expect(auditRepo.findByMemory(id)).toHaveLength(1);
    });
  });
});

describe('PolicyService', () => {
  let db: Database.Database;
  let repo: PolicyRepository;
  let service: PolicyService;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new PolicyRepository(db);
    service = new PolicyService(repo);
  });

  it('create validates data with Zod and inserts', () => {
    const data = makePolicy();
    const policy = service.create(data);
    expect(policy.id).toBe(data['id']);
    expect(repo.findById(policy.id)).not.toBeNull();
  });

  it('create rejects invalid data with a 400 ApiError', () => {
    expect(() => service.create({ name: 'Missing everything' })).toThrow(ApiError);
    try {
      service.create({ name: 'Missing everything' });
    } catch (err) {
      if (err instanceof ApiError) {
        expect(err.statusCode).toBe(400);
      }
    }
  });
});

describe('HealthService', () => {
  let db: Database.Database;
  let service: HealthService;

  beforeEach(() => {
    db = createTestDatabase();
    service = new HealthService(db);
  });

  it('check returns healthy status when database is connected', () => {
    const status = service.check();
    expect(status.status).toBe('healthy');
    expect(status.dbConnected).toBe(true);
  });

  it('check returns version string', () => {
    const status = service.check();
    expect(status.version).toBe('0.4.0');
  });

  it('check returns a non-negative uptime', () => {
    const status = service.check();
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  it('check returns degraded when database is closed', () => {
    db.close();
    const status = service.check();
    expect(status.status).toBe('degraded');
    expect(status.dbConnected).toBe(false);
  });
});

// Keep a reference to NOW to avoid unused import warning
const _now: string = NOW;
void _now;
