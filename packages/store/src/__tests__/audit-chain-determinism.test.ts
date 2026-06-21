/**
 * Cross-clone determinism + hash-version migration round-trip for the audit
 * chain (bead qmd-team-intent-kb-8da.6).
 *
 * The original (v1) canonical hash body included `timestamp`, sourced from
 * `new Date().toISOString()` at write time. Two clones processing the same
 * logical event at different instants minted different timestamps, hence
 * different entry_hash values - the chain was reproducible only within a
 * single DB, never across clones.
 *
 * Migration 6 (`rehash_audit_chain_v2`) adds a `hash_version` discriminant.
 * New rows are written as v2, whose canonical body EXCLUDES `timestamp`, so
 * the entry_hash is a pure function of the logical event. This file proves:
 *
 *   1. determinism - the same logical event hashed twice with DIFFERENT
 *      wallclock timestamps produces the SAME entry_hash (v2).
 *   2. migration round-trip - a DB carrying BOTH a legacy v1 row (timestamp
 *      in the hash) and new v2 rows verifies clean in a single pass; the
 *      v1 row's stored hash is never rehashed.
 *
 * @module __tests__/audit-chain-determinism.test
 */

import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@qmd-team-intent-kb/schema';

import { AuditRepository } from '../repositories/audit-repository.js';
import { createTestDatabase } from '../database.js';
import { verifyAuditChain } from '../audit-verify.js';
import { computeEntryHash, canonicalRowJson, CURRENT_AUDIT_HASH_VERSION } from '../audit-chain.js';

/**
 * The logical event - every field EXCEPT the wallclock timestamp. Two clones
 * agree on all of these for the same event; they disagree only on the instant
 * the row was written.
 */
const LOGICAL_EVENT = {
  id: '00000000-0000-4000-8000-00000000000a',
  action: 'promoted' as const,
  memory_id: '11111111-1111-4111-8111-111111111111',
  tenant_id: 'demo-e2e',
  actor_json: JSON.stringify({ type: 'human', id: 'curator-1' }),
  reason: 'cross-clone determinism',
  details_json: JSON.stringify({ candidateId: 'cand-1' }),
  prev_entry_hash: null,
};

function makeEvent(timestamp: string): AuditEvent {
  return {
    id: LOGICAL_EVENT.id,
    action: LOGICAL_EVENT.action,
    memoryId: LOGICAL_EVENT.memory_id,
    tenantId: LOGICAL_EVENT.tenant_id,
    actor: { type: 'human', id: 'curator-1' },
    reason: LOGICAL_EVENT.reason,
    details: { candidateId: 'cand-1' },
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// 1. Determinism - same logical event, different wallclock, identical hash
// ---------------------------------------------------------------------------

describe('audit entry_hash is deterministic across wallclock (8da.6)', () => {
  it('computeEntryHash (v2) ignores timestamp: two instants -> one hash', () => {
    // Same logical event; only the timestamp differs between the two clones.
    const clockA = '2026-06-20T08:00:00.000Z';
    const clockB = '2026-12-31T23:59:59.999Z';

    const hashA = computeEntryHash({ ...LOGICAL_EVENT, timestamp: clockA });
    const hashB = computeEntryHash({ ...LOGICAL_EVENT, timestamp: clockB });

    expect(hashA).toBe(hashB);
    // And the canonical body must not even mention the timestamp.
    expect(canonicalRowJson({ ...LOGICAL_EVENT, timestamp: clockA })).not.toContain('timestamp');
    expect(canonicalRowJson({ ...LOGICAL_EVENT, timestamp: clockA })).not.toContain(clockA);
  });

  it('two clones inserting the same logical event at different times agree on entry_hash', () => {
    // Clone A writes the event "now"; clone B writes the identical logical
    // event at a wildly different instant. Both DBs are independent.
    const dbA = createTestDatabase();
    const dbB = createTestDatabase();
    try {
      const repoA = new AuditRepository(dbA);
      const repoB = new AuditRepository(dbB);

      repoA.insert(makeEvent('2026-06-20T08:00:00.000Z'));
      repoB.insert(makeEvent('2027-01-15T17:42:11.123Z'));

      const rowA = repoA.findAllChronological()[0]!;
      const rowB = repoB.findAllChronological()[0]!;

      // Reproducible chain head across clones - the whole point of 8da.6.
      expect(rowA.entry_hash).toBe(rowB.entry_hash);
      expect(rowA.entry_hash).not.toBeNull();
      // Timestamps still differ and are still recorded, just not hashed.
      expect(rowA.timestamp).not.toBe(rowB.timestamp);
      expect(rowA.hash_version).toBe(CURRENT_AUDIT_HASH_VERSION);
      expect(rowB.hash_version).toBe(CURRENT_AUDIT_HASH_VERSION);

      // Both single-row chains verify clean.
      expect(verifyAuditChain(repoA).breaks).toHaveLength(0);
      expect(verifyAuditChain(repoB).breaks).toHaveLength(0);
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it('the v1 serialiser still DOES depend on timestamp (proves the bug existed)', () => {
    // Sanity anchor: under the legacy v1 serialiser the same logical event
    // hashed at two instants produces DIFFERENT hashes - exactly the
    // non-determinism migration 6 fixes. We keep v1 reachable so legacy rows
    // still recompute to their stored hash.
    const hashA = computeEntryHash({ ...LOGICAL_EVENT, timestamp: '2026-06-20T08:00:00.000Z' }, 1);
    const hashB = computeEntryHash({ ...LOGICAL_EVENT, timestamp: '2026-12-31T23:59:59.999Z' }, 1);
    expect(hashA).not.toBe(hashB);
  });
});

// ---------------------------------------------------------------------------
// 2. Migration round-trip - mixed v1 (legacy) + v2 (new) rows verify clean
// ---------------------------------------------------------------------------

describe('hash-version migration round-trip (8da.6 / migration 6)', () => {
  it('hash_version column exists with DEFAULT 1 after migration 6', () => {
    const db = createTestDatabase();
    try {
      const cols = db.prepare(`PRAGMA table_info(audit_events)`).all() as Array<{
        name: string;
        dflt_value: string | null;
        notnull: number;
      }>;
      const hv = cols.find((c) => c.name === 'hash_version');
      expect(hv, 'hash_version column should exist').toBeDefined();
      expect(hv?.dflt_value).toBe('1');
      expect(hv?.notnull).toBe(1);

      const recorded = db.prepare(`SELECT name FROM schema_migrations WHERE version = 6`).get() as
        | { name: string }
        | undefined;
      expect(recorded?.name).toBe('rehash_audit_chain_v2');
    } finally {
      db.close();
    }
  });

  it('a legacy v1 row (timestamp-in-hash) and new v2 rows both verify in one pass', () => {
    const db = createTestDatabase();
    try {
      const repo = new AuditRepository(db);

      // Hand-write a legacy v1 row exactly as a pre-migration-6 writer would:
      // entry_hash computed WITH the timestamp (v1 serialiser), hash_version 1,
      // prev_entry_hash NULL (it is the chain anchor).
      const legacyTimestamp = '2026-05-28T00:00:00.000Z';
      const legacyBase = {
        id: '00000000-0000-4000-8000-000000000001',
        action: 'created',
        memory_id: '22222222-2222-4222-8222-222222222222',
        tenant_id: 'demo-e2e',
        actor_json: JSON.stringify({ type: 'human', id: 'legacy' }),
        reason: 'legacy v1 row',
        details_json: '{}',
        timestamp: legacyTimestamp,
        prev_entry_hash: null,
      };
      const legacyHash = computeEntryHash(legacyBase, 1);
      db.prepare(
        `INSERT INTO audit_events (
          id, action, memory_id, tenant_id, actor_json, reason, details_json,
          timestamp, entry_hash, prev_entry_hash, hash_version
        ) VALUES (
          @id, @action, @memory_id, @tenant_id, @actor_json, @reason, @details_json,
          @timestamp, @entry_hash, @prev_entry_hash, 1
        )`,
      ).run({ ...legacyBase, entry_hash: legacyHash });

      // Now append two v2 rows via the repo (the current write path). They
      // chain onto the legacy row's entry_hash.
      repo.insert(makeEvent('2026-06-20T08:00:00.000Z'));
      repo.insert({
        ...makeEvent('2026-06-20T08:05:00.000Z'),
        id: '00000000-0000-4000-8000-00000000000b',
        memoryId: '33333333-3333-4333-8333-333333333333',
      });

      const result = verifyAuditChain(repo);
      // 3 rows, all clean, mixed versions, single pass.
      expect(result.totalRows).toBe(3);
      expect(result.unverifiedRows).toBe(0);
      expect(result.cleanRows).toBe(3);
      expect(result.breaks).toEqual([]);

      // The legacy row's stored hash is untouched (NOT rehashed to v2) - its
      // v1 hash is the tamper-evidence record for that row.
      const stored = db
        .prepare(`SELECT entry_hash, hash_version FROM audit_events WHERE id = ?`)
        .get(legacyBase.id) as { entry_hash: string; hash_version: number };
      expect(stored.entry_hash).toBe(legacyHash);
      expect(stored.hash_version).toBe(1);

      // Recomputing that legacy row under v2 would NOT match - confirms the
      // verifier must (and does) dispatch on the per-row version.
      const wrongVersionHash = computeEntryHash(legacyBase, 2);
      expect(wrongVersionHash).not.toBe(legacyHash);
    } finally {
      db.close();
    }
  });

  it('tampering a legacy v1 row is still detected (v1 evidence preserved)', () => {
    const db = createTestDatabase();
    try {
      const repo = new AuditRepository(db);

      const legacyBase = {
        id: '00000000-0000-4000-8000-000000000001',
        action: 'created',
        memory_id: '22222222-2222-4222-8222-222222222222',
        tenant_id: 'demo-e2e',
        actor_json: JSON.stringify({ type: 'human', id: 'legacy' }),
        reason: 'original v1 reason',
        details_json: '{}',
        timestamp: '2026-05-28T00:00:00.000Z',
        prev_entry_hash: null,
      };
      db.prepare(
        `INSERT INTO audit_events (
          id, action, memory_id, tenant_id, actor_json, reason, details_json,
          timestamp, entry_hash, prev_entry_hash, hash_version
        ) VALUES (
          @id, @action, @memory_id, @tenant_id, @actor_json, @reason, @details_json,
          @timestamp, @entry_hash, @prev_entry_hash, 1
        )`,
      ).run({ ...legacyBase, entry_hash: computeEntryHash(legacyBase, 1) });

      repo.insert(makeEvent('2026-06-20T08:00:00.000Z'));

      // Tamper the legacy row's reason without updating its v1 entry_hash.
      db.prepare(`UPDATE audit_events SET reason = 'TAMPERED' WHERE id = ?`).run(legacyBase.id);

      const result = verifyAuditChain(repo);
      expect(result.breaks.length).toBeGreaterThanOrEqual(1);
      expect(result.breaks[0]!.id).toBe(legacyBase.id);
    } finally {
      db.close();
    }
  });
});
