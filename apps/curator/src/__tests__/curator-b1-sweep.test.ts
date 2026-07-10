import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestDatabase,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
} from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';
import { Curator } from '../curator.js';
import type { CuratorDependencies } from '../curator.js';
import { makeCandidate, makeCuratedMemory, makePolicy } from './fixtures.js';

function makeDeps(db: Database.Database): CuratorDependencies {
  return {
    candidateRepo: new CandidateRepository(db),
    memoryRepo: new MemoryRepository(db),
    policyRepo: new PolicyRepository(db),
    auditRepo: new AuditRepository(db),
  };
}

/**
 * B1 (bead compile-then-govern-jfv.2.1) — the two Curator behaviors the auto-govern
 * sweep relies on: tenant-scoped dedup, and suppressible per-candidate reject
 * receipts.
 */
describe('Curator — tenant-scoped dedup (B1)', () => {
  let deps: CuratorDependencies;
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDatabase();
    deps = makeDeps(db);
  });

  it('does NOT suppress a candidate as a duplicate of ANOTHER tenant memory', () => {
    const content = 'Prefer composition over inheritance in service wiring layers';
    // A memory with this exact content already exists — but under a DIFFERENT tenant.
    deps.memoryRepo.insert(makeCuratedMemory({ tenantId: 'team-other', content }));

    const curator = new Curator(deps, { tenantId: 'team-mine' });
    const result = curator.processSingle(makeCandidate({ tenantId: 'team-mine', content }));

    // Globally the content exists, but not for team-mine → it must PROMOTE, not
    // be swallowed as a cross-tenant duplicate.
    expect(result.outcome).toBe('promoted');
  });

  it('still flags a genuine SAME-tenant duplicate', () => {
    const content = 'Prefer composition over inheritance in service wiring layers';
    deps.memoryRepo.insert(makeCuratedMemory({ tenantId: 'team-mine', content }));

    const curator = new Curator(deps, { tenantId: 'team-mine' });
    const result = curator.processSingle(makeCandidate({ tenantId: 'team-mine', content }));
    expect(result.outcome).toBe('duplicate');
  });
});

describe('Curator — suppressRejectionReceipts (B1)', () => {
  let deps: CuratorDependencies;
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDatabase();
    deps = makeDeps(db);
  });

  it('writes a per-candidate reject receipt by DEFAULT', () => {
    // content_length rule rejects a too-short candidate.
    deps.policyRepo.insert(
      makePolicy({
        tenantId: 'team-mine',
        rules: [
          {
            id: 'len',
            type: 'content_length',
            action: 'reject',
            enabled: true,
            priority: 0,
            parameters: { min: 1000 },
            description: 'reject short',
          },
        ],
      }),
    );
    const curator = new Curator(deps, { tenantId: 'team-mine' });
    const result = curator.processSingle(
      makeCandidate({ tenantId: 'team-mine', content: 'too short body' }),
    );
    expect(result.outcome).toBe('rejected');
    // A 'deleted' (rejection) audit event WAS written.
    expect(deps.auditRepo.findByAction('deleted').length).toBe(1);
  });

  it('suppresses the per-candidate reject receipt when configured (sweep mode)', () => {
    deps.policyRepo.insert(
      makePolicy({
        tenantId: 'team-mine',
        rules: [
          {
            id: 'len',
            type: 'content_length',
            action: 'reject',
            enabled: true,
            priority: 0,
            parameters: { min: 1000 },
            description: 'reject short',
          },
        ],
      }),
    );
    const curator = new Curator(deps, { tenantId: 'team-mine', suppressRejectionReceipts: true });
    const result = curator.processSingle(
      makeCandidate({ tenantId: 'team-mine', content: 'too short body' }),
    );
    // Outcome still surfaces...
    expect(result.outcome).toBe('rejected');
    // ...but NO per-candidate reject receipt was written (idempotent re-sweeps).
    expect(deps.auditRepo.findByAction('deleted').length).toBe(0);
  });

  it('still writes the promoted receipt while suppressing rejections', () => {
    const curator = new Curator(deps, { tenantId: 'team-mine', suppressRejectionReceipts: true });
    const result = curator.processSingle(
      makeCandidate({
        tenantId: 'team-mine',
        content: 'A sufficiently long and clean governed body of text.',
      }),
    );
    expect(result.outcome).toBe('promoted');
    expect(deps.auditRepo.findByAction('promoted').length).toBe(1);
  });
});
