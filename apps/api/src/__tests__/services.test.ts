import { describe, it, expect, beforeEach } from 'vitest';
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
