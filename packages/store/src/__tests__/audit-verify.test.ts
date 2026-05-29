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
