import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createTestDatabase,
  MemoryRepository,
  AuditRepository,
  MemoryLinksRepository,
} from '@qmd-team-intent-kb/store';
import {
  computeContentHash,
  deriveMemoryId,
  deriveAuditEventId,
  deriveLinkId,
} from '@qmd-team-intent-kb/common';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import { promote, type EvalResultRecord } from '../promotion/promoter.js';
import { makeCandidate, makeCuratedMemory, TENANT } from './fixtures.js';

function makePipelineResult(overrides?: Partial<PipelineResult>): PipelineResult {
  return {
    candidateId: randomUUID(),
    outcome: 'approved',
    evaluations: [],
    ...overrides,
  };
}

describe('promote', () => {
  let memoryRepo: MemoryRepository;
  let auditRepo: AuditRepository;

  beforeEach(() => {
    const db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    auditRepo = new AuditRepository(db);
  });

  it('creates a CuratedMemory from candidate with correct fields', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const pipelineResult = makePipelineResult({ candidateId: candidate.id });

    const memory = promote({ candidate, contentHash, pipelineResult }, memoryRepo, auditRepo);

    expect(memory.candidateId).toBe(candidate.id);
    expect(memory.content).toBe(candidate.content);
    expect(memory.title).toBe(candidate.title);
    expect(memory.category).toBe(candidate.category);
    expect(memory.trustLevel).toBe(candidate.trustLevel);
    expect(memory.tenantId).toBe(candidate.tenantId);
  });

  it('sets lifecycle to active', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
    );
    expect(memory.lifecycle).toBe('active');
  });

  it('generates a content-derived UUID v5 for the memory ID', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
    );
    // The memory id is now a content-derived UUID v5 (bead 8da.5), not a
    // random v4: version nibble 5, RFC 4122 variant bits.
    expect(memory.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    // And it is exactly deriveMemoryId(candidate.id, contentHash).
    expect(memory.id).toBe(deriveMemoryId(candidate.id, contentHash));
  });

  it('is deterministic: the same logical candidate promotes to the same memory id', () => {
    // Two independent promote() calls (distinct DBs, as two clones would have)
    // for the same logical candidate + content hash must yield the same id.
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);

    const dbA = createTestDatabase();
    const memoryA = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      new MemoryRepository(dbA),
      new AuditRepository(dbA),
    );

    const dbB = createTestDatabase();
    const memoryB = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      new MemoryRepository(dbB),
      new AuditRepository(dbB),
    );

    expect(memoryA.id).toBe(memoryB.id);
    dbA.close();
    dbB.close();
  });

  it('a different content hash for the same candidate yields a different memory id', () => {
    const candidate = makeCandidate();
    const memoryA = promote(
      {
        candidate,
        contentHash: computeContentHash('content one'),
        pipelineResult: makePipelineResult(),
      },
      memoryRepo,
      auditRepo,
    );
    const dbB = createTestDatabase();
    const memoryB = promote(
      {
        candidate,
        contentHash: computeContentHash('content two'),
        pipelineResult: makePipelineResult(),
      },
      new MemoryRepository(dbB),
      new AuditRepository(dbB),
    );
    expect(memoryA.id).not.toBe(memoryB.id);
    dbB.close();
  });

  it('preserves the content hash from input', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
    );
    expect(memory.contentHash).toBe(contentHash);
  });

  it('sets promotedBy to system/curator', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
    );
    expect(memory.promotedBy).toEqual({ type: 'system', id: 'curator' });
  });

  it('converts pipeline evaluations to PolicyEvaluation records', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const pipelineResult = makePipelineResult({
      evaluations: [
        { ruleId: 'rule-secret', ruleType: 'secret_detection', outcome: 'pass', reason: 'Clean' },
        { ruleId: 'rule-length', ruleType: 'content_length', outcome: 'pass', reason: 'OK' },
      ],
    });

    const memory = promote({ candidate, contentHash, pipelineResult }, memoryRepo, auditRepo);

    expect(memory.policyEvaluations).toHaveLength(2);
    expect(memory.policyEvaluations[0]?.ruleId).toBe('rule-secret');
    expect(memory.policyEvaluations[0]?.result).toBe('pass');
    expect(memory.policyEvaluations[1]?.ruleId).toBe('rule-length');
  });

  it('inserts memory into store', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
    );

    expect(memoryRepo.count()).toBe(1);
    expect(memoryRepo.findById(memory.id)).not.toBeNull();
  });

  it('records a promotion audit event', () => {
    const candidate = makeCandidate({ tenantId: TENANT });
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
    );

    const events = auditRepo.findByMemory(memory.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('promoted');
    expect(events[0]?.tenantId).toBe(TENANT);
  });

  it('handles supersession: marks old memory as superseded with link', () => {
    const old = makeCuratedMemory({ title: 'Error handling guide', category: 'convention' });
    memoryRepo.insert(old);

    const candidate = makeCandidate({
      title: 'Error handling guide updated',
      category: 'convention',
    });
    const contentHash = computeContentHash(candidate.content);
    const supersession = {
      supersededMemoryId: old.id,
      supersededTitle: old.title,
      similarity: 0.75,
    };

    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult(), supersession },
      memoryRepo,
      auditRepo,
    );

    const updatedOld = memoryRepo.findById(old.id);
    expect(updatedOld?.lifecycle).toBe('superseded');
    expect(updatedOld?.supersession?.supersededBy).toBe(memory.id);
    expect(updatedOld?.supersession?.reason).toContain('0.75');
  });

  it('creates a supersession audit event for the old memory', () => {
    const old = makeCuratedMemory({ title: 'Error handling guide', category: 'convention' });
    memoryRepo.insert(old);

    const candidate = makeCandidate({ title: 'Error handling guide v2', category: 'convention' });
    const contentHash = computeContentHash(candidate.content);
    const supersession = {
      supersededMemoryId: old.id,
      supersededTitle: old.title,
      similarity: 0.8,
    };

    promote(
      { candidate, contentHash, pipelineResult: makePipelineResult(), supersession },
      memoryRepo,
      auditRepo,
    );

    const events = auditRepo.findByMemory(old.id);
    const supersededEvent = events.find((e) => e.action === 'superseded');
    expect(supersededEvent).toBeDefined();
    expect(supersededEvent?.tenantId).toBe(TENANT);
  });

  // ── R9: promote() is atomic (all-or-nothing) ────────────────────────────────
  // The whole write block runs in ONE `db.transaction(...).immediate()`, so a
  // crash partway (the cron `timeout 1800`, or a SIGTERM) can NEVER leave a
  // promoted memory without its 'promoted' receipt — a durable row without a
  // receipt would violate the product's append-only-receipts promise and never
  // self-heal. We simulate the crash by making the 'promoted' audit insert throw
  // AFTER the memory row is already inserted (the exact orphan window).
  it('atomicity: a crash before the promoted receipt rolls the memory back — no orphan', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const memoryId = deriveMemoryId(candidate.id, contentHash);

    const realInsert = auditRepo.insert.bind(auditRepo);
    vi.spyOn(auditRepo, 'insert').mockImplementation((event) => {
      if (event.action === 'promoted') {
        throw new Error('simulated crash before the promoted receipt');
      }
      return realInsert(event);
    });

    expect(() =>
      promote(
        { candidate, contentHash, pipelineResult: makePipelineResult() },
        memoryRepo,
        auditRepo,
      ),
    ).toThrow(/simulated crash before the promoted receipt/);

    // NEITHER the memory NOR any partial audit event survives.
    expect(memoryRepo.findById(memoryId)).toBeNull();
    expect(memoryRepo.count()).toBe(0);
    expect(auditRepo.findByMemory(memoryId)).toHaveLength(0);
  });

  it('atomicity: a crash in a supersession promote also rolls back the earlier superseded event + old-memory update', () => {
    const old = makeCuratedMemory({ title: 'Error handling guide', category: 'convention' });
    memoryRepo.insert(old);

    const candidate = makeCandidate({ title: 'Error handling guide v4', category: 'convention' });
    const contentHash = computeContentHash(candidate.content);
    const memoryId = deriveMemoryId(candidate.id, contentHash);
    const supersession = {
      supersededMemoryId: old.id,
      supersededTitle: old.title,
      similarity: 0.9,
    };

    const realInsert = auditRepo.insert.bind(auditRepo);
    vi.spyOn(auditRepo, 'insert').mockImplementation((event) => {
      if (event.action === 'promoted') {
        throw new Error('simulated crash before the promoted receipt');
      }
      return realInsert(event);
    });

    expect(() =>
      promote(
        { candidate, contentHash, pipelineResult: makePipelineResult(), supersession },
        memoryRepo,
        auditRepo,
      ),
    ).toThrow(/simulated crash before the promoted receipt/);

    // The new memory never lands.
    expect(memoryRepo.findById(memoryId)).toBeNull();
    // The old memory's active→superseded update — written EARLIER in the same
    // transaction — is undone: it is still 'active' with no supersession link.
    const oldAfter = memoryRepo.findById(old.id);
    expect(oldAfter?.lifecycle).toBe('active');
    expect(oldAfter?.supersession).toBeUndefined();
    // The 'superseded' audit event (also written before the throw) is rolled back.
    expect(auditRepo.findByMemory(old.id).some((e) => e.action === 'superseded')).toBe(false);
    // Only the original memory remains — nothing partial.
    expect(memoryRepo.count()).toBe(1);
  });

  it('dry run does not insert memory into store', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
      true, // dryRun
    );

    expect(memoryRepo.count()).toBe(0);
  });

  it('dry run does not record audit events', () => {
    const candidate = makeCandidate({ tenantId: TENANT });
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
      true, // dryRun
    );

    expect(auditRepo.findByTenant(TENANT)).toHaveLength(0);
    // Memory object is still returned
    expect(memory.candidateId).toBe(candidate.id);
  });

  it('dry run still returns a valid CuratedMemory', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
      true,
    );
    expect(memory.lifecycle).toBe('active');
    expect(memory.contentHash).toBe(contentHash);
  });

  it('new memory has no supersession link (it is the superseder)', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
    );
    expect(memory.supersession).toBeUndefined();
  });

  it('persists a supersedes graph edge when linksRepo is provided', () => {
    const db = createTestDatabase();
    const mRepo = new MemoryRepository(db);
    const aRepo = new AuditRepository(db);
    const lRepo = new MemoryLinksRepository(db);

    const old = makeCuratedMemory({ title: 'Error handling guide', category: 'convention' });
    mRepo.insert(old);

    const candidate = makeCandidate({
      title: 'Error handling guide updated',
      category: 'convention',
    });
    const contentHash = computeContentHash(candidate.content);
    const supersession = {
      supersededMemoryId: old.id,
      supersededTitle: old.title,
      similarity: 0.75,
    };

    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult(), supersession },
      mRepo,
      aRepo,
      false,
      lRepo,
    );

    const links = lRepo.findBySource(memory.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.targetMemoryId).toBe(old.id);
    expect(links[0]!.linkType).toBe('supersedes');
    expect(links[0]!.weight).toBe(0.75);
    expect(links[0]!.source).toBe('curator');

    db.close();
  });

  // Additional: promotion timestamp is set
  it('sets promotedAt and updatedAt to a valid ISO datetime', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const before = new Date().toISOString();
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
    );
    const after = new Date().toISOString();
    expect(memory.promotedAt >= before).toBe(true);
    expect(memory.promotedAt <= after).toBe(true);
    expect(memory.updatedAt).toBe(memory.promotedAt);
  });
});

describe('promote — eval callback (Evidence emission)', () => {
  let memoryRepo: MemoryRepository;
  let auditRepo: AuditRepository;

  beforeEach(() => {
    const db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    auditRepo = new AuditRepository(db);
  });

  it('emits an eval-result audit event per verdict the callback returns', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
      false,
      undefined,
      (): EvalResultRecord[] => [
        { name: 'memory-utility', passed: true, score: 1, threshold: 0.8, details: { probes: 3 } },
        { name: 'provenance-integrity', passed: true, score: 1, threshold: 1, details: {} },
      ],
    );

    const evalEvents = auditRepo.findByMemory(memory.id).filter((e) => e.action === 'eval-result');
    expect(evalEvents).toHaveLength(2);
    expect(evalEvents.map((e) => e.details.evaluator).sort()).toEqual([
      'memory-utility',
      'provenance-integrity',
    ]);
    expect(evalEvents.every((e) => e.details.passed === true)).toBe(true);
  });

  it('does not emit eval-result events when no callback is supplied', () => {
    const candidate = makeCandidate();
    const memory = promote(
      {
        candidate,
        contentHash: computeContentHash(candidate.content),
        pipelineResult: makePipelineResult(),
      },
      memoryRepo,
      auditRepo,
    );
    expect(auditRepo.findByAction('eval-result')).toHaveLength(0);
    expect(memoryRepo.findById(memory.id)).not.toBeNull();
  });

  it('does not emit eval-result events in dry-run mode', () => {
    const candidate = makeCandidate();
    promote(
      {
        candidate,
        contentHash: computeContentHash(candidate.content),
        pipelineResult: makePipelineResult(),
      },
      memoryRepo,
      auditRepo,
      true,
      undefined,
      () => [{ name: 'x', passed: true, score: 1, threshold: 1, details: {} }],
    );
    expect(auditRepo.findByAction('eval-result')).toHaveLength(0);
  });

  it('contains a throwing callback — the promotion still succeeds', () => {
    const candidate = makeCandidate();
    const contentHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash, pipelineResult: makePipelineResult() },
      memoryRepo,
      auditRepo,
      false,
      undefined,
      () => {
        throw new Error('eval-surface fault');
      },
    );
    // Memory persisted + 'promoted' event present; no eval-result events written.
    expect(memoryRepo.findById(memory.id)).not.toBeNull();
    expect(auditRepo.findByMemory(memory.id).some((e) => e.action === 'promoted')).toBe(true);
    expect(auditRepo.findByAction('eval-result')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-clone audit-event-id determinism (beads 8da.5 + 8da.6)
//
// Regression guard for the cross-clone determinism blocker: promoter.ts used to
// mint every audit-event id with crypto.randomUUID() (v4), and the audit chain's
// v2 entry_hash folds the event id into its canonical body. So two independent
// clones promoting the SAME logical candidate could never reproduce a
// byte-identical entry_hash: the random id diverged even after 8da.6 excluded
// the wallclock timestamp from the hash.
//
// The fix makes every audit-event id (and graph-edge id) a pure function of the
// logical event identity via deriveAuditEventId / deriveLinkId (UUID v5), exactly
// as deriveMemoryId already did for the memory id. These tests vary the wallclock
// between the two clone runs (via fake timers) to prove the ids (and, given an
// identical preceding chain, the entry_hash) are timestamp-independent.
// ---------------------------------------------------------------------------

/** A fixed logical candidate id so two independent runs share one identity. */
const LOGICAL_CANDIDATE_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/**
 * Promote one logical candidate into a fresh in-memory DB at a chosen wallclock,
 * returning the promoter output plus the raw audit chain (entry_hash visible).
 * Models a single clone: a brand-new DB, a fixed logical candidate, a controllable
 * "now".
 */
function promoteOnClone(
  wallclock: string,
  opts?: { evalCallback?: EvalResultRecord[] },
): {
  memoryId: string;
  contentHash: string;
  chain: ReturnType<AuditRepository['findAllChronological']>;
} {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(wallclock));
  try {
    const db = createTestDatabase();
    try {
      const memoryRepo = new MemoryRepository(db);
      const auditRepo = new AuditRepository(db);
      const candidate = makeCandidate({ id: LOGICAL_CANDIDATE_ID });
      const contentHash = computeContentHash(candidate.content);
      const memory = promote(
        {
          candidate,
          contentHash,
          pipelineResult: makePipelineResult({ candidateId: candidate.id }),
        },
        memoryRepo,
        auditRepo,
        false,
        undefined,
        opts?.evalCallback ? (): EvalResultRecord[] => opts.evalCallback! : undefined,
      );
      // Snapshot the chain BEFORE the DB closes; findAllChronological returns plain rows.
      const chain = auditRepo.findAllChronological();
      return { memoryId: memory.id, contentHash, chain };
    } finally {
      db.close();
    }
  } finally {
    vi.useRealTimers();
  }
}

describe('promote: cross-clone audit-event-id determinism (8da.5 + 8da.6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('two clones at different wallclocks mint a byte-identical promoted audit-event id', () => {
    const cloneA = promoteOnClone('2026-06-20T08:00:00.000Z');
    const cloneB = promoteOnClone('2027-01-15T17:42:11.123Z');

    // Same logical candidate -> same memory id (the 8da.5 foundation primitive).
    expect(cloneA.memoryId).toBe(cloneB.memoryId);

    const promotedA = cloneA.chain.find((e) => e.action === 'promoted')!;
    const promotedB = cloneB.chain.find((e) => e.action === 'promoted')!;

    // The audit-event id is content-derived and therefore identical across clones,
    // and is exactly deriveAuditEventId(memoryId, 'promoted').
    expect(promotedA.id).toBe(promotedB.id);
    expect(promotedA.id).toBe(deriveAuditEventId(cloneA.memoryId, 'promoted'));
    // It is a real v5 id (version nibble 5, RFC 4122 variant), not a random v4.
    expect(promotedA.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('given an identical preceding chain (empty), the promoted entry_hash is byte-identical across clones', () => {
    // Both clones start from an empty audit table, so prev_entry_hash is NULL for
    // the first event on each, the "identical preceding chain" precondition. With
    // a content-derived id and timestamp excluded from the v2 body, the entry_hash
    // must match despite the wildly different wallclocks.
    const cloneA = promoteOnClone('2026-06-20T08:00:00.000Z');
    const cloneB = promoteOnClone('2027-01-15T17:42:11.123Z');

    const promotedA = cloneA.chain.find((e) => e.action === 'promoted')!;
    const promotedB = cloneB.chain.find((e) => e.action === 'promoted')!;

    // First event in each empty chain -> no anchor.
    expect(promotedA.prev_entry_hash).toBeNull();
    expect(promotedB.prev_entry_hash).toBeNull();

    // The reproducible chain head: identical entry_hash across clones...
    expect(promotedA.entry_hash).not.toBeNull();
    expect(promotedA.entry_hash).toBe(promotedB.entry_hash);

    // ...while the timestamps genuinely differ and are still recorded (just not hashed).
    expect(promotedA.timestamp).not.toBe(promotedB.timestamp);
  });

  it('eval-result audit-event ids are deterministic and discriminated per evaluator', () => {
    const verdicts: EvalResultRecord[] = [
      { name: 'memory-utility', passed: true, score: 1, threshold: 0.8, details: { probes: 3 } },
      { name: 'provenance-integrity', passed: true, score: 1, threshold: 1, details: {} },
    ];
    const cloneA = promoteOnClone('2026-06-20T08:00:00.000Z', { evalCallback: verdicts });
    const cloneB = promoteOnClone('2027-01-15T17:42:11.123Z', { evalCallback: verdicts });

    const evalA = cloneA.chain.filter((e) => e.action === 'eval-result');
    const evalB = cloneB.chain.filter((e) => e.action === 'eval-result');
    expect(evalA).toHaveLength(2);
    expect(evalB).toHaveLength(2);

    // The two evaluators get distinct ids within a single clone (the verdict name
    // is the discriminator), and the same logical row matches across clones.
    const idsA = evalA.map((e) => e.id).sort();
    const idsB = evalB.map((e) => e.id).sort();
    expect(new Set(idsA).size).toBe(2);
    expect(idsA).toEqual(idsB);
    expect(idsA).toEqual(
      [
        deriveAuditEventId(cloneA.memoryId, 'eval-result', 'memory-utility'),
        deriveAuditEventId(cloneA.memoryId, 'eval-result', 'provenance-integrity'),
      ].sort(),
    );

    // And every eval-result entry_hash matches across clones (identical preceding
    // chain: the promoted event hashes identically, so each subsequent link does too).
    const hashesA = evalA.map((e) => e.entry_hash).sort();
    const hashesB = evalB.map((e) => e.entry_hash).sort();
    expect(hashesA).toEqual(hashesB);
  });
});

describe('promote: cross-clone determinism on the supersession path (8da.5)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Promote a superseding candidate over a pre-seeded old memory, on a fresh DB at
   * a chosen wallclock. The old memory is inserted with a FIXED id on both clones so
   * the supersession references the same logical target.
   */
  function promoteWithSupersessionOnClone(wallclock: string): {
    memoryId: string;
    supersededId: string;
    chain: ReturnType<AuditRepository['findAllChronological']>;
    linkIds: string[];
  } {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(wallclock));
    try {
      const db = createTestDatabase();
      try {
        const memoryRepo = new MemoryRepository(db);
        const auditRepo = new AuditRepository(db);
        const linksRepo = new MemoryLinksRepository(db);

        const old = makeCuratedMemory({
          id: '11112222-3333-4444-8555-666677778888',
          title: 'Error handling guide',
          category: 'convention',
        });
        memoryRepo.insert(old);

        const candidate = makeCandidate({
          id: LOGICAL_CANDIDATE_ID,
          title: 'Error handling guide updated',
          category: 'convention',
        });
        const contentHash = computeContentHash(candidate.content);
        const memory = promote(
          {
            candidate,
            contentHash,
            pipelineResult: makePipelineResult({ candidateId: candidate.id }),
            supersession: {
              supersededMemoryId: old.id,
              supersededTitle: old.title,
              similarity: 0.75,
            },
          },
          memoryRepo,
          auditRepo,
          false,
          linksRepo,
        );

        const chain = auditRepo.findAllChronological();
        const linkIds = linksRepo
          .findBySource(memory.id)
          .map((l) => l.id)
          .sort();
        return { memoryId: memory.id, supersededId: old.id, chain, linkIds };
      } finally {
        db.close();
      }
    } finally {
      vi.useRealTimers();
    }
  }

  it('superseded audit-event id + supersedes link id are byte-identical across clones', () => {
    const cloneA = promoteWithSupersessionOnClone('2026-06-20T08:00:00.000Z');
    const cloneB = promoteWithSupersessionOnClone('2027-01-15T17:42:11.123Z');

    const supersededA = cloneA.chain.find((e) => e.action === 'superseded')!;
    const supersededB = cloneB.chain.find((e) => e.action === 'superseded')!;

    // The superseded audit-event id is content-derived: (supersededMemoryId,
    // 'superseded', superseding-memory-id-as-discriminator), identical across clones.
    expect(supersededA.id).toBe(supersededB.id);
    expect(supersededA.id).toBe(
      deriveAuditEventId(cloneA.supersededId, 'superseded', cloneA.memoryId),
    );

    // The supersedes graph edge id is content-derived from its (source, target, type)
    // and matches across clones too.
    expect(cloneA.linkIds).toEqual(cloneB.linkIds);
    expect(cloneA.linkIds).toContain(
      deriveLinkId(cloneA.memoryId, cloneA.supersededId, 'supersedes'),
    );
  });
});

describe('promote — persists classified sensitivity (5bm.3)', () => {
  let memoryRepo: MemoryRepository;
  let auditRepo: AuditRepository;
  let db: ReturnType<typeof createTestDatabase>;

  beforeEach(() => {
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    auditRepo = new AuditRepository(db);
  });
  afterEach(() => db.close());

  function promoteWith(content: string) {
    const candidate = makeCandidate({ content });
    const contentHash = computeContentHash(content);
    return promote(
      { candidate, contentHash, pipelineResult: makePipelineResult({ candidateId: candidate.id }) },
      memoryRepo,
      auditRepo,
    );
  }

  it('classifies clean prose as public (no longer hardcoded internal)', () => {
    const memory = promoteWith(
      'A perfectly ordinary technical note about deterministic pipelines.',
    );
    expect(memory.sensitivity).toBe('public');
  });

  it('classifies content with an internal absolute path as internal', () => {
    const memory = promoteWith(
      'The config lives at /home/jeremy/000-projects/foo/bar.yaml on the box.',
    );
    expect(memory.sensitivity).toBe('internal');
  });

  it('classifies content carrying PII as confidential', () => {
    const memory = promoteWith('Reach the operator at operator.person@example.com for escalation.');
    expect(memory.sensitivity).toBe('confidential');
  });

  it('persists the classified value to the store, not a constant', () => {
    const memory = promoteWith('Ping ops.contact@example.com about the runbook.');
    const stored = memoryRepo.findById(memory.id);
    expect(stored?.sensitivity).toBe('confidential');
  });
});
