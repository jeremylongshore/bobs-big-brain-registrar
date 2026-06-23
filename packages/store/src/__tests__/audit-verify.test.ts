/**
 * Tests for the audit-chain verifier (bead kmr / gvt).
 *
 * Covers the 5 acceptance scenarios from kmr:
 *   1. intact chain        — clean walk, zero breaks
 *   2. sequence gap        — pre-migration row interspersed (unverified, not broken)
 *   3. broken hash link    — tampered prev_entry_hash
 *   4. malformed entry     — tampered content invalidates entry_hash
 *   5. missing file/chain  — empty table (zero rows is intact)
 *
 * Plus: pre-migration rows treated as unverified (not broken); chain
 * re-anchors after a tamper so a single break doesn't cascade.
 *
 * @module __tests__/audit-verify.test
 */

import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@qmd-team-intent-kb/schema';

import { AuditRepository } from '../repositories/audit-repository.js';
import { createTestDatabase } from '../database.js';
import { verifyAuditChain } from '../audit-verify.js';
import { computeEntryHash, CURRENT_AUDIT_HASH_VERSION } from '../audit-chain.js';

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padStart(12, '0')}`,
    action: 'promoted',
    memoryId: '11111111-1111-4111-8111-111111111111',
    tenantId: 'demo-e2e',
    actor: { type: 'human', id: 'curator-1' },
    reason: 'test',
    details: { test: true },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function setupRepo(): { db: ReturnType<typeof createTestDatabase>; repo: AuditRepository } {
  const db = createTestDatabase();
  const repo = new AuditRepository(db);
  return { db, repo };
}

// ---------------------------------------------------------------------------
// 1. Intact chain
// ---------------------------------------------------------------------------

describe('verifyAuditChain — intact chain', () => {
  it('reports zero breaks after inserting several events', () => {
    const { db, repo } = setupRepo();
    try {
      for (let i = 0; i < 5; i++) {
        repo.insert(
          makeEvent({
            id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            timestamp: `2026-05-29T08:0${i}:00.000Z`,
          }),
        );
      }
      const result = verifyAuditChain(repo);
      expect(result.totalRows).toBe(5);
      expect(result.unverifiedRows).toBe(0);
      expect(result.cleanRows).toBe(5);
      expect(result.breaks).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Sequence gap — pre-migration rows interspersed
// ---------------------------------------------------------------------------

describe('verifyAuditChain — pre-migration (unverified) rows', () => {
  it('treats rows with NULL entry_hash + NULL prev_entry_hash as unverified, not broken', () => {
    const { db, repo } = setupRepo();
    try {
      // Simulate a pre-migration row by writing directly into the DB
      // with NULL hash columns. This is exactly what migration 5 leaves
      // historical rows looking like.
      db.prepare(
        `INSERT INTO audit_events (
          id, action, memory_id, tenant_id, actor_json, reason, details_json,
          timestamp, entry_hash, prev_entry_hash
        ) VALUES (
          @id, @action, @memory_id, @tenant_id, @actor_json, @reason, @details_json,
          @timestamp, NULL, NULL
        )`,
      ).run({
        id: 'preexisting-row-1',
        action: 'created',
        memory_id: '22222222-2222-4222-8222-222222222222',
        tenant_id: 'demo-e2e',
        actor_json: JSON.stringify({ type: 'human', id: 'legacy' }),
        reason: 'pre-migration',
        details_json: '{}',
        timestamp: '2026-05-28T00:00:00.000Z',
      });

      // Now insert hashed rows via the repo.
      for (let i = 0; i < 3; i++) {
        repo.insert(
          makeEvent({
            id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            timestamp: `2026-05-29T08:0${i}:00.000Z`,
          }),
        );
      }

      const result = verifyAuditChain(repo);
      expect(result.totalRows).toBe(4);
      expect(result.unverifiedRows).toBe(1);
      expect(result.cleanRows).toBe(3);
      expect(result.breaks).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Broken hash link — tampered prev_entry_hash
// ---------------------------------------------------------------------------

describe('verifyAuditChain — broken hash link', () => {
  it('detects a tampered prev_entry_hash and reports PREV_LINK_MISMATCH', () => {
    const { db, repo } = setupRepo();
    try {
      const ids = [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
      ];
      for (let i = 0; i < ids.length; i++) {
        repo.insert(
          makeEvent({
            id: ids[i]!,
            timestamp: `2026-05-29T08:0${i}:00.000Z`,
          }),
        );
      }

      // Tamper: overwrite row 2's prev_entry_hash with garbage, but
      // recompute the entry_hash so ONLY the link is broken (not the
      // content hash). This is the worst tamper — an attacker who
      // knows the algorithm changes the chain link and recomputes
      // entry_hash to look valid against their fake prev. The verifier
      // catches it because the actual previous row's stored entry_hash
      // doesn't match the tampered prev_entry_hash.
      const fakePrev = 'f'.repeat(64);
      const fakeEntry = 'a'.repeat(64);
      db.prepare(
        `UPDATE audit_events
           SET prev_entry_hash = ?,
               entry_hash = ?
           WHERE id = ?`,
      ).run(fakePrev, fakeEntry, ids[1]);

      const result = verifyAuditChain(repo);
      expect(result.breaks.length).toBeGreaterThanOrEqual(1);
      const firstBreak = result.breaks[0]!;
      expect(firstBreak.id).toBe(ids[1]);
      expect(firstBreak.index).toBe(1);
      expect(['PREV_LINK_MISMATCH', 'PREV_LINK_AND_ENTRY_HASH_MISMATCH']).toContain(
        firstBreak.reason,
      );
      expect(firstBreak.expectedPrevEntryHash).not.toEqual(firstBreak.actualPrevEntryHash);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed entry — tampered content invalidates entry_hash
// ---------------------------------------------------------------------------

describe('verifyAuditChain — tampered content (entry_hash mismatch)', () => {
  it('detects tampered reason text and reports ENTRY_HASH_MISMATCH', () => {
    const { db, repo } = setupRepo();
    try {
      const ids = [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
      ];
      for (let i = 0; i < ids.length; i++) {
        repo.insert(
          makeEvent({
            id: ids[i]!,
            reason: `original reason ${i}`,
            timestamp: `2026-05-29T08:0${i}:00.000Z`,
          }),
        );
      }

      // Tamper the middle row's `reason` content WITHOUT updating its
      // entry_hash. The verifier recomputes the expected hash from the
      // tampered content and detects the mismatch.
      db.prepare(`UPDATE audit_events SET reason = 'TAMPERED' WHERE id = ?`).run(ids[1]);

      const result = verifyAuditChain(repo);
      expect(result.breaks.length).toBeGreaterThanOrEqual(1);
      const firstBreak = result.breaks[0]!;
      expect(firstBreak.id).toBe(ids[1]);
      expect(['ENTRY_HASH_MISMATCH', 'PREV_LINK_AND_ENTRY_HASH_MISMATCH']).toContain(
        firstBreak.reason,
      );
      expect(firstBreak.expectedEntryHash).not.toEqual(firstBreak.actualEntryHash);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Empty table — zero rows is intact
// ---------------------------------------------------------------------------

describe('verifyAuditChain — empty table', () => {
  it('reports zero rows and zero breaks on an empty audit_events table', () => {
    const { db, repo } = setupRepo();
    try {
      const result = verifyAuditChain(repo);
      expect(result.totalRows).toBe(0);
      expect(result.cleanRows).toBe(0);
      expect(result.unverifiedRows).toBe(0);
      expect(result.breaks).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Defensive: chain re-anchors after a tamper so one break doesn't cascade
// ---------------------------------------------------------------------------

describe('verifyAuditChain — re-anchoring after tamper', () => {
  it('only flags the tampered row, not every subsequent row', () => {
    const { db, repo } = setupRepo();
    try {
      const ids = [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000005',
      ];
      for (let i = 0; i < ids.length; i++) {
        repo.insert(
          makeEvent({
            id: ids[i]!,
            timestamp: `2026-05-29T08:0${i}:00.000Z`,
          }),
        );
      }

      // Tamper row 2 only.
      db.prepare(`UPDATE audit_events SET reason = 'tamper' WHERE id = ?`).run(ids[2]);

      const result = verifyAuditChain(repo);
      // Exactly one break — the tamper anchor; the chain re-anchors after.
      expect(result.breaks.length).toBe(1);
      expect(result.breaks[0]!.id).toBe(ids[2]);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Same-timestamp ordering — the chain rides insertion order (seq), not
//    (timestamp, id). Regression for bead qmd-team-intent-kb-yxp: a
//    promotion-that-supersedes writes a `promoted` and a `superseded` event
//    in the same instant, so events share a timestamp. The chain MUST verify
//    clean regardless of how the random-UUID `id` sorts within that instant —
//    ordering by (timestamp, id) reordered same-timestamp rows vs the order
//    their prev-links were built in and produced spurious PREV_LINK_MISMATCH
//    breaks (310 of them, 0 tampering, on the live brain).
// ---------------------------------------------------------------------------

describe('verifyAuditChain — same-timestamp ordering (bead yxp)', () => {
  it('verifies clean when several same-timestamp events have UUIDs that sort opposite to insertion order', () => {
    const { db, repo } = setupRepo();
    try {
      const SAME_TS = '2026-06-14T04:51:54.023Z';
      // Insert in this order, but choose ids so that id-sort is the REVERSE
      // of insertion order. Under the old `ORDER BY timestamp ASC, id ASC`
      // walk (and the matching `timestamp DESC, id DESC` write-time prev
      // lookup), a later same-timestamp insert would link back past its
      // immediate predecessor to a higher-id sibling — forking the chain so
      // no linear walk could verify it. Under seq ordering the walk follows
      // true insertion order and the chain is clean.
      const inserted: Array<{ id: string; action: AuditEvent['action']; ts: string }> = [
        // (timestamp, descending id) — adversarial: first-inserted has the
        // highest id, so (timestamp, id) order would reverse these three.
        { id: '00000000-0000-4000-8000-0000000000ff', action: 'superseded', ts: SAME_TS },
        { id: '00000000-0000-4000-8000-0000000000aa', action: 'promoted', ts: SAME_TS },
        { id: '00000000-0000-4000-8000-000000000011', action: 'promoted', ts: SAME_TS },
        // a later-timestamp row whose prev-link, under the old logic, would
        // have skipped back to the highest-id same-ts sibling.
        {
          id: '00000000-0000-4000-8000-000000000022',
          action: 'promoted',
          ts: '2026-06-14T04:51:54.027Z',
        },
      ];
      for (const e of inserted) {
        repo.insert(makeEvent({ id: e.id, action: e.action, timestamp: e.ts }));
      }

      // The walk must be in insertion (seq) order, NOT id order.
      const walked = repo.findAllChronological().map((r) => r.id);
      expect(walked).toEqual(inserted.map((e) => e.id));

      const result = verifyAuditChain(repo);
      expect(result.totalRows).toBe(4);
      expect(result.cleanRows).toBe(4);
      expect(result.unverifiedRows).toBe(0);
      expect(result.breaks).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('keeps the chain clean across many same-timestamp promote/supersede pairs', () => {
    const { db, repo } = setupRepo();
    try {
      const SAME_TS = '2026-06-14T04:51:54.023Z';
      // 20 pairs, all sharing one timestamp, ids assigned so they sort in the
      // OPPOSITE order to insertion (descending id) — the exact shape that
      // forked the live chain. seq ordering must keep every pair clean.
      let n = 0;
      for (let p = 0; p < 20; p++) {
        for (const action of ['promoted', 'superseded'] as const) {
          const descId = (10_000 - n).toString(16).padStart(12, '0');
          repo.insert(
            makeEvent({ id: `00000000-0000-4000-8000-${descId}`, action, timestamp: SAME_TS }),
          );
          n++;
        }
      }
      const result = verifyAuditChain(repo);
      expect(result.totalRows).toBe(40);
      expect(result.cleanRows).toBe(40);
      expect(result.breaks).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Fork classification — a link back to a real, intact earlier row is a
//    CHAIN_FORK (writer-bug ordering artifact), NOT tampering. This is what
//    lets `verify` tell the truth about the 155 historical forks on the live
//    brain instead of crying tamper. Bead qmd-team-intent-kb-yxp.
// ---------------------------------------------------------------------------

describe('verifyAuditChain — fork classification (bead yxp)', () => {
  it('reports CHAIN_FORK (not tampering) when a row links back to a real earlier intact row', () => {
    const { db, repo } = setupRepo();
    try {
      const ids = [
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000a2',
        '00000000-0000-4000-8000-0000000000a3',
      ];
      for (let i = 0; i < ids.length; i++) {
        repo.insert(
          makeEvent({ id: ids[i]!, reason: `r${i}`, timestamp: `2026-05-29T08:0${i}:00.000Z` }),
        );
      }

      // Forge the exact shape the old buggy writer produced: make row C link
      // back to A (so B and C share predecessor A) AND recompute C's entry_hash
      // so it is VALID for that forking prev — i.e. a non-linear chain with
      // every hash intact. The new writer can no longer produce this, so we
      // synthesise it directly.
      const rowA = db.prepare('SELECT entry_hash FROM audit_events WHERE id = ?').get(ids[0]) as {
        entry_hash: string;
      };
      const rowC = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(ids[2]) as {
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
        ids[2],
      );

      const result = verifyAuditChain(repo);
      // A and B verify clean; C is the fork.
      expect(result.cleanRows).toBe(2);
      expect(result.breaks).toHaveLength(1);
      const fork = result.breaks[0]!;
      expect(fork.id).toBe(ids[2]);
      expect(fork.reason).toBe('CHAIN_FORK');
      // The fork's OWN content hash is intact — recomputed == stored.
      expect(fork.actualEntryHash).toBe(fork.expectedEntryHash);
      // The tamper-only view (what curator-cli reports) sees zero tampering.
      expect(result.breaks.filter((b) => b.reason !== 'CHAIN_FORK')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('still reports tampering (not CHAIN_FORK) when a prev link points at a hash no row holds', () => {
    const { db, repo } = setupRepo();
    try {
      const ids = [
        '00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000b2',
        '00000000-0000-4000-8000-0000000000b3',
      ];
      for (let i = 0; i < ids.length; i++) {
        repo.insert(makeEvent({ id: ids[i]!, timestamp: `2026-05-29T08:0${i}:00.000Z` }));
      }
      // Point row B's prev at a hash NO row holds, and recompute its entry_hash
      // to be self-consistent. This is a forged splice, not a fork — it must
      // NOT be excused as CHAIN_FORK.
      const fakePrev = 'd'.repeat(64);
      const rowB = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(ids[1]) as {
        id: string;
        action: string;
        memory_id: string;
        tenant_id: string;
        actor_json: string;
        reason: string | null;
        details_json: string;
        timestamp: string;
      };
      const forged = computeEntryHash(
        {
          id: rowB.id,
          action: rowB.action,
          memory_id: rowB.memory_id,
          tenant_id: rowB.tenant_id,
          actor_json: rowB.actor_json,
          reason: rowB.reason,
          details_json: rowB.details_json,
          timestamp: rowB.timestamp,
          prev_entry_hash: fakePrev,
        },
        CURRENT_AUDIT_HASH_VERSION,
      );
      db.prepare('UPDATE audit_events SET prev_entry_hash = ?, entry_hash = ? WHERE id = ?').run(
        fakePrev,
        forged,
        ids[1],
      );

      const result = verifyAuditChain(repo);
      const offending = result.breaks.find((b) => b.id === ids[1]);
      expect(offending).toBeDefined();
      expect(offending!.reason).not.toBe('CHAIN_FORK');
      expect(offending!.reason).toBe('PREV_LINK_MISMATCH');
    } finally {
      db.close();
    }
  });
});
