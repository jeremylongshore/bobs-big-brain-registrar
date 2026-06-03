import { computeContentHash } from '@qmd-team-intent-kb/common';
import { AuditRepository, MemoryRepository, createTestDatabase } from '@qmd-team-intent-kb/store';
import { DEFAULT_TENANT, makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluateDedupCatchRate,
  evaluateMemoryUtility,
  evaluateProvenanceIntegrity,
} from '../index.js';

// Infer the db type from the factory so this package needs no direct
// better-sqlite3 dependency (it's a transitive dep of @qmd-team-intent-kb/store).
let db: ReturnType<typeof createTestDatabase>;
let memRepo: MemoryRepository;
let auditRepo: AuditRepository;

beforeEach(() => {
  db = createTestDatabase();
  memRepo = new MemoryRepository(db);
  auditRepo = new AuditRepository(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// memory-utility
// ---------------------------------------------------------------------------

describe('evaluateMemoryUtility', () => {
  it('passes vacuously with no probes', () => {
    const r = evaluateMemoryUtility(memRepo, []);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it('scores recall@k for the expected memory surfaced by search', () => {
    const m = makeMemory({
      content: 'Zod schemas validate every API endpoint input boundary',
      title: 'validation',
    });
    memRepo.insert(m);

    const r = evaluateMemoryUtility(memRepo, [
      { query: 'Zod schemas validate input', tenantId: DEFAULT_TENANT, expectedMemoryIds: [m.id] },
    ]);
    expect(r.name).toBe('memory-utility');
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.details.probes_scored).toBe(1);
  });

  it('fails when the expected memory is not retrievable', () => {
    memRepo.insert(makeMemory({ content: 'totally unrelated content about widgets' }));
    const r = evaluateMemoryUtility(
      memRepo,
      [
        {
          query: 'nonexistent quantum entanglement topic',
          tenantId: DEFAULT_TENANT,
          expectedMemoryIds: ['missing-id'],
        },
      ],
      { threshold: 0.8 },
    );
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dedup-catch-rate
// ---------------------------------------------------------------------------

describe('evaluateDedupCatchRate', () => {
  it('passes vacuously with no probes', () => {
    expect(evaluateDedupCatchRate(memRepo, []).passed).toBe(true);
  });

  it('catches an exact-content duplicate of a stored memory', () => {
    const content = 'Decisions are recorded as dated AT-DECR documents';
    memRepo.insert(makeMemory({ content }));

    const r = evaluateDedupCatchRate(memRepo, [
      { nearDuplicateContent: content, tenantId: DEFAULT_TENANT, originalMemoryId: 'x' },
    ]);
    expect(r.name).toBe('dedup-catch-rate');
    expect(r.details.caught).toBe(1);
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });

  it('does NOT flag genuinely distinct content (false-positive guard)', () => {
    memRepo.insert(makeMemory({ content: 'the original stored memory text' }));
    const r = evaluateDedupCatchRate(memRepo, [
      {
        nearDuplicateContent: 'completely different memory text that was never stored',
        tenantId: DEFAULT_TENANT,
        originalMemoryId: 'x',
      },
    ]);
    // A non-duplicate must NOT be caught — catch_rate 0 against a 1.0 threshold = fail,
    // which correctly signals "this probe was not actually a duplicate".
    expect(r.details.caught).toBe(0);
  });

  it('reports the honest scope (exact-hash, not semantic)', () => {
    memRepo.insert(makeMemory({ content: 'a stored memory' }));
    const r = evaluateDedupCatchRate(memRepo, [
      { nearDuplicateContent: 'a stored memory', tenantId: DEFAULT_TENANT, originalMemoryId: 'x' },
    ]);
    expect(String(r.details.scope ?? '')).toContain('exact-content-hash');
  });
});

// ---------------------------------------------------------------------------
// provenance-integrity
// ---------------------------------------------------------------------------

describe('evaluateProvenanceIntegrity', () => {
  it('passes on a clean store (consistent hashes, intact chain)', () => {
    memRepo.insert(makeMemory({ content: 'clean memory one' }));
    memRepo.insert(makeMemory({ content: 'clean memory two' }));
    const r = evaluateProvenanceIntegrity(memRepo, auditRepo, { tenantId: DEFAULT_TENANT });
    expect(r.name).toBe('provenance-integrity');
    expect(r.details.content_hash_mismatches).toBe(0);
    expect(r.details.audit_chain_breaks).toBe(0);
    expect(r.passed).toBe(true);
  });

  it('detects a content-hash mismatch (content altered after fingerprinting)', () => {
    // Force an inconsistent record: contentHash does not match the content.
    const tampered = makeMemory({
      content: 'this is the real content',
      contentHash: computeContentHash('a DIFFERENT string than the content'),
    });
    memRepo.insert(tampered);
    const r = evaluateProvenanceIntegrity(memRepo, auditRepo, { tenantId: DEFAULT_TENANT });
    expect(r.details.content_hash_mismatches).toBe(1);
    expect(r.passed).toBe(false);
  });

  it('passes on an empty store', () => {
    const r = evaluateProvenanceIntegrity(memRepo, auditRepo, { tenantId: DEFAULT_TENANT });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });
});
