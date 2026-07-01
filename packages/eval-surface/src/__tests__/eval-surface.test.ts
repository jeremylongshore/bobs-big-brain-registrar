import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import {
  AuditRepository,
  CURRENT_AUDIT_HASH_VERSION,
  MemoryRepository,
  computeEntryHash,
  computeManifestHash,
  createTestDatabase,
} from '@qmd-team-intent-kb/store';
import type { AuditEvent } from '@qmd-team-intent-kb/schema';
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
  // A path that will never exist → forces the eval's manifest loader down its
  // "no amnesty" branch deterministically, regardless of the host filesystem
  // (never reads a real ~/.teamkb manifest during unit tests).
  const NO_MANIFEST = join(tmpdir(), 'gsb-eval-no-such-manifest-should-not-exist.json');

  // ---- audit-row helpers (real repo, real chain) ------------------------
  // Mirrors packages/store/src/__tests__/audit-verify.test.ts idioms: insert
  // real hashed rows via the repo, then splice a fork/tamper directly in SQL.

  function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
    return {
      id: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padStart(12, '0')}`,
      action: 'promoted',
      memoryId: '11111111-1111-4111-8111-111111111111',
      tenantId: DEFAULT_TENANT,
      actor: { type: 'human', id: 'curator-1' },
      reason: 'test',
      details: { test: true },
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  /** Insert `n` valid, linearly-chained hashed audit rows via the repo. */
  function seedChain(n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `00000000-0000-4000-8000-0000000000${(i + 1).toString(16).padStart(2, '0')}`;
      ids.push(id);
      auditRepo.insert(
        makeEvent({ id, reason: `r${i}`, timestamp: `2026-05-29T08:0${i}:00.000Z` }),
      );
    }
    return ids;
  }

  /**
   * Splice a benign CHAIN_FORK: re-point row C's prev link back to row A (a
   * real earlier intact row) and recompute C's entry_hash so its OWN hash stays
   * intact — a non-linear chain with zero tampering (bead yxp). Requires ≥3
   * rows; forks the last one back to the first.
   */
  function forkLastRowBackToFirst(ids: string[]): void {
    const first = ids[0]!;
    const last = ids[ids.length - 1]!;
    const rowA = db.prepare('SELECT entry_hash FROM audit_events WHERE id = ?').get(first) as {
      entry_hash: string;
    };
    const rowC = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(last) as {
      id: string;
      action: string;
      memory_id: string;
      tenant_id: string;
      actor_json: string;
      reason: string | null;
      details_json: string;
      timestamp: string;
    };
    const forkedEntry = computeEntryHash(
      {
        id: rowC.id,
        action: rowC.action,
        memory_id: rowC.memory_id,
        tenant_id: rowC.tenant_id,
        actor_json: rowC.actor_json,
        reason: rowC.reason,
        details_json: rowC.details_json,
        timestamp: rowC.timestamp,
        prev_entry_hash: rowA.entry_hash,
      },
      CURRENT_AUDIT_HASH_VERSION,
    );
    db.prepare('UPDATE audit_events SET prev_entry_hash = ?, entry_hash = ? WHERE id = ?').run(
      rowA.entry_hash,
      forkedEntry,
      last,
    );
  }

  // -----------------------------------------------------------------------

  it('passes on a clean store (consistent hashes, intact chain)', () => {
    memRepo.insert(makeMemory({ content: 'clean memory one' }));
    memRepo.insert(makeMemory({ content: 'clean memory two' }));
    const r = evaluateProvenanceIntegrity(memRepo, auditRepo, {
      tenantId: DEFAULT_TENANT,
      exceptionManifestPath: NO_MANIFEST,
    });
    expect(r.name).toBe('provenance-integrity');
    expect(r.details.content_hash_mismatches).toBe(0);
    expect(r.details.tamper_signatures).toBe(0);
    expect(r.details.chain_forks).toBe(0);
    expect(r.passed).toBe(true);
  });

  it('detects a content-hash mismatch (content altered after fingerprinting)', () => {
    // Force an inconsistent record: contentHash does not match the content.
    const tampered = makeMemory({
      content: 'this is the real content',
      contentHash: computeContentHash('a DIFFERENT string than the content'),
    });
    memRepo.insert(tampered);
    const r = evaluateProvenanceIntegrity(memRepo, auditRepo, {
      tenantId: DEFAULT_TENANT,
      exceptionManifestPath: NO_MANIFEST,
    });
    expect(r.details.content_hash_mismatches).toBe(1);
    expect(r.passed).toBe(false);
  });

  it('passes on an empty store', () => {
    const r = evaluateProvenanceIntegrity(memRepo, auditRepo, {
      tenantId: DEFAULT_TENANT,
      exceptionManifestPath: NO_MANIFEST,
    });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  // -- (a) 010-AT-RISK R5: forks-only chain must PASS, forks disclosed --------
  it('PASSES on a chain with ONLY CHAIN_FORK breaks and discloses the forks (R5)', () => {
    memRepo.insert(makeMemory({ content: 'forked-brain memory' }));
    const ids = seedChain(3);
    forkLastRowBackToFirst(ids);

    const r = evaluateProvenanceIntegrity(memRepo, auditRepo, {
      tenantId: DEFAULT_TENANT,
      exceptionManifestPath: NO_MANIFEST,
    });

    // A benign fork is NOT tampering → the eval must pass (the whole R5 fix).
    expect(r.passed).toBe(true);
    // …but the fork IS disclosed, not silently greened.
    expect(Number(r.details.chain_forks)).toBeGreaterThan(0);
    expect(r.details.tamper_signatures).toBe(0);
    expect(r.details.documented_exceptions).toBe(0);
    // Forks do not drag the score below threshold on an untampered brain.
    expect(r.score).toBe(1);
  });

  // -- (b) a tamper-reason break must FAIL -----------------------------------
  it('FAILS on a tamper-reason audit break (content of a row altered post-hash)', () => {
    memRepo.insert(makeMemory({ content: 'tampered-brain memory' }));
    const ids = seedChain(3);
    // Alter the middle row's reason WITHOUT recomputing its entry_hash → the
    // walk recomputes a different hash → ENTRY_HASH_MISMATCH (a tamper reason).
    db.prepare(`UPDATE audit_events SET reason = 'TAMPERED' WHERE id = ?`).run(ids[1]);

    const r = evaluateProvenanceIntegrity(memRepo, auditRepo, {
      tenantId: DEFAULT_TENANT,
      exceptionManifestPath: NO_MANIFEST,
    });

    expect(Number(r.details.tamper_signatures)).toBeGreaterThan(0);
    expect(r.passed).toBe(false);
    expect(r.score).toBeLessThan(1);
  });

  // -- (c) content-hash mismatch already covered above; assert it does not
  //        leak into the chain counters -------------------------------------
  it('a content-hash mismatch fails without inventing chain tamper signatures', () => {
    memRepo.insert(
      makeMemory({
        content: 'real content C',
        contentHash: computeContentHash('some other content entirely'),
      }),
    );
    const r = evaluateProvenanceIntegrity(memRepo, auditRepo, {
      tenantId: DEFAULT_TENANT,
      exceptionManifestPath: NO_MANIFEST,
    });
    expect(r.details.content_hash_mismatches).toBe(1);
    expect(r.details.tamper_signatures).toBe(0);
    expect(r.passed).toBe(false);
  });

  // -- (d) a documented tamper break covered by a manifest → PASSES ----------
  it('PASSES when a tamper break is byte-pinned in a documented exception manifest', () => {
    memRepo.insert(makeMemory({ content: 'documented-break memory' }));
    const ids = seedChain(3);
    // Create a genuine tamper-reason break on the middle row.
    db.prepare(`UPDATE audit_events SET reason = 'MIGRATED' WHERE id = ?`).run(ids[1]);

    // Read the break's CURRENT stored tuple to byte-pin it in the manifest.
    const brokenRow = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(ids[1]) as {
      id: string;
      entry_hash: string | null;
      prev_entry_hash: string | null;
      hash_version: number | null;
      seq: number;
    };

    const entries = [
      {
        id: brokenRow.id,
        entryHash: brokenRow.entry_hash,
        prevEntryHash: brokenRow.prev_entry_hash,
        hashVersion: brokenRow.hash_version ?? 1,
        seq: brokenRow.seq,
        // The walk reports ENTRY_HASH_MISMATCH for a content-altered row whose
        // prev link still chains correctly.
        reason: 'ENTRY_HASH_MISMATCH' as const,
      },
    ];
    const body = {
      schemaVersion: 1 as const,
      generatedAt: '2026-06-30T00:00:00.000Z',
      entryCount: entries.length,
      entries,
    };
    const manifest = { ...body, manifestHash: computeManifestHash(body) };

    const manifestPath = join(
      tmpdir(),
      `gsb-eval-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(manifestPath, JSON.stringify(manifest));
    try {
      const r = evaluateProvenanceIntegrity(memRepo, auditRepo, {
        tenantId: DEFAULT_TENANT,
        exceptionManifestPath: manifestPath,
      });
      // The break is DOCUMENTED (byte-pinned) → not a tamper signature → passes,
      // but is disclosed as a documented exception.
      expect(r.details.exception_manifest_loaded).toBe(true);
      expect(r.details.tamper_signatures).toBe(0);
      expect(Number(r.details.documented_exceptions)).toBeGreaterThan(0);
      expect(r.passed).toBe(true);
    } finally {
      if (existsSync(manifestPath)) rmSync(manifestPath);
    }
  });
});
