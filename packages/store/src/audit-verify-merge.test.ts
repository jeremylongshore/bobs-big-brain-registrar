import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeEntryHash } from './audit-chain.js';
import { verifyMergeAuditChain, canonicalMergeOrder } from './audit-verify-merge.js';
import type { AuditChainRow } from './repositories/audit-repository.js';
import {
  appendSignedMergeAnchor,
  generateActorKeypair,
  type ActorKeypair,
} from './signed-merge-anchor.js';

/**
 * The deterministic merge clock, mirrored from apps/curator merge-gate.ts
 * `mergeClock(index)`. The merged DB stamps each promoted row with this clock in
 * id-sorted traversal order - monotonic with insertion, content-independent of
 * any clone's wallclock. Reproduced here so the test fixtures look exactly like
 * a real `mergeGovern` output.
 */
const MERGE_EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z');
function mergeClock(index: number): string {
  return new Date(MERGE_EPOCH_MS + index).toISOString();
}

/**
 * Build a VALID single-clone linear chain (v2 hashes, prev links in array
 * order). Ids are zero-padded so lexical id order matches array order for any
 * count. Timestamps are the clone's own (independent) wallclock.
 */
function buildCloneChain(prefix: string, memIds: string[]): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: string | null = null;
  memIds.forEach((mem, i) => {
    const base = {
      id: `${prefix}-evt-${String(i).padStart(3, '0')}`,
      action: 'promoted',
      memory_id: mem,
      tenant_id: 'local',
      actor_json: '{"type":"ai","id":"curator"}',
      reason: `${prefix}-r${i}`,
      details_json: '{}',
      timestamp: `2026-05-1${prefix === 'a' ? '0' : '1'}T00:00:0${i}.000Z`,
      hash_version: 2 as const,
    };
    const entry_hash = computeEntryHash({ ...base, prev_entry_hash: prev });
    rows.push({ ...base, prev_entry_hash: prev, entry_hash });
    prev = entry_hash;
  });
  return rows;
}

/**
 * Build a VALID merged chain the way `mergeGovern` does: take the audit-event
 * descriptors, SORT by content-derived event id, then chain them in id order
 * with `mergeClock(index)` timestamps and v2 hashes (timestamp excluded from the
 * body, so the hash is reproducible). Returns the rows in the SAME order
 * `findAllChronological` would (timestamp ASC, id ASC) - which here equals the
 * id-sorted order because the merge clock is monotonic in that order.
 */
function buildMergedChain(events: Array<{ id: string; memory_id: string; reason: string }>): {
  rows: AuditChainRow[];
  head: string;
} {
  const sorted = [...events].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const rows: AuditChainRow[] = [];
  let prev: string | null = null;
  sorted.forEach((evt, index) => {
    const base = {
      id: evt.id,
      action: 'promoted',
      memory_id: evt.memory_id,
      tenant_id: 'local',
      actor_json: '{"type":"ai","id":"curator"}',
      reason: evt.reason,
      details_json: '{}',
      timestamp: mergeClock(index),
      hash_version: 2 as const,
    };
    const entry_hash = computeEntryHash({ ...base, prev_entry_hash: prev });
    rows.push({ ...base, prev_entry_hash: prev, entry_hash });
    prev = entry_hash;
  });
  return { rows, head: prev ?? '' };
}

/** Head entry_hash of a chain ('' when empty). */
function headOf(rows: AuditChainRow[]): string {
  return rows.length > 0 ? (rows[rows.length - 1]!.entry_hash ?? '') : '';
}

/** Minimal repo wrapper for appendSignedMergeAnchor (only findAllChronological). */
function mockRepo(rows: AuditChainRow[]): Parameters<typeof appendSignedMergeAnchor>[0] {
  return { findAllChronological: () => rows } as unknown as Parameters<
    typeof appendSignedMergeAnchor
  >[0];
}

/** A representative merge scenario: two clones + the merged union over them. */
function buildScenario() {
  const cloneA = buildCloneChain('a', ['mem-shared', 'mem-a-only']);
  const cloneB = buildCloneChain('b', ['mem-shared', 'mem-b-only']);

  // The merged union's audit events. Event ids are content-derived (here:
  // synthetic but content-stable). Deliberately NOT in sorted order in this
  // literal - the merged-chain builder sorts them, proving id-ordering is what
  // the chain rides on, not literal order.
  const { rows: mergedRows, head: mergedHead } = buildMergedChain([
    { id: 'm-evt-c', memory_id: 'mem-shared', reason: 'merge-shared' },
    { id: 'm-evt-a', memory_id: 'mem-a-only', reason: 'merge-a' },
    { id: 'm-evt-b', memory_id: 'mem-b-only', reason: 'merge-b' },
  ]);

  return { cloneA, cloneB, mergedRows, mergedHead };
}

describe('audit-verify-merge', () => {
  let anchorPath: string;
  // Ephemeral per-test keypair - no hardcoded private key anywhere.
  let keys: ActorKeypair;

  beforeEach(() => {
    anchorPath = join(
      tmpdir(),
      `gsb-merge-verify-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    keys = generateActorKeypair();
  });
  afterEach(() => {
    if (existsSync(anchorPath)) rmSync(anchorPath);
  });

  /** Anchor the merge with a freshly-generated key over the real clone heads. */
  function anchorMerge(
    cloneA: AuditChainRow[],
    cloneB: AuditChainRow[],
    mergedRows: AuditChainRow[],
  ) {
    return appendSignedMergeAnchor(mockRepo(mergedRows), anchorPath, {
      tenantId: 'local',
      parents: [headOf(cloneA), headOf(cloneB)],
      lamportClock: 1,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });
  }

  it('canonicalMergeOrder sorts by content-derived id regardless of input order', () => {
    const { mergedRows } = buildScenario();
    const shuffled = [mergedRows[2]!, mergedRows[0]!, mergedRows[1]!];
    const ordered = canonicalMergeOrder(shuffled);
    expect(ordered.map((r) => r.id)).toEqual([...mergedRows].map((r) => r.id).sort());
    // Pure: did not mutate the input.
    expect(shuffled[0]!.id).toBe(mergedRows[2]!.id);
  });

  it('VALIDATES a clean per-clone + merged + signed-anchor set', () => {
    const { cloneA, cloneB, mergedRows } = buildScenario();
    anchorMerge(cloneA, cloneB, mergedRows);

    const result = verifyMergeAuditChain({
      cloneARows: cloneA,
      cloneBRows: cloneB,
      mergedRows,
      anchorPath,
    });

    expect(result.ok).toBe(true);
    expect(result.cloneA.breaks).toHaveLength(0);
    expect(result.cloneB.breaks).toHaveLength(0);
    expect(result.mergedChain.breaks).toHaveLength(0);
    expect(result.dagAnchor.ok).toBe(true);
    expect(result.dagAnchor.breaks).toHaveLength(0);
  });

  it('re-walks the merged chain byte-identically even when the rows arrive out of id order', () => {
    const { cloneA, cloneB, mergedRows } = buildScenario();
    anchorMerge(cloneA, cloneB, mergedRows);

    // Hand the merged rows to the verifier REVERSED - the canonical id-sort must
    // recover the true chain and verify clean. This is the proof that ordering
    // is a verifier-owned contract, not a property of how rows happen to arrive.
    const reversed = [...mergedRows].reverse();
    const result = verifyMergeAuditChain({
      cloneARows: cloneA,
      cloneBRows: cloneB,
      mergedRows: reversed,
      anchorPath,
    });

    expect(result.ok).toBe(true);
    expect(result.mergedChain.breaks).toHaveLength(0);
    expect(result.mergedChain.cleanRows).toBe(mergedRows.length);
  });

  it('CATCHES a tampered clone chain (clone-level break, surfaced before merge logic)', () => {
    const { cloneA, cloneB, mergedRows } = buildScenario();
    anchorMerge(cloneA, cloneB, mergedRows);

    // Tamper clone A's first row content WITHOUT re-hashing - its stored
    // entry_hash no longer matches the recomputation, and the next row's
    // prev link no longer matches either.
    const tamperedCloneA = cloneA.map((r) => ({ ...r }));
    tamperedCloneA[0]!.reason = 'INJECTED-BY-ATTACKER';

    const result = verifyMergeAuditChain({
      cloneARows: tamperedCloneA,
      cloneBRows: cloneB,
      mergedRows,
      anchorPath,
    });

    expect(result.ok).toBe(false);
    expect(result.cloneA.breaks.length).toBeGreaterThan(0);
    expect(result.cloneA.breaks.map((b) => b.reason)).toContain('ENTRY_HASH_MISMATCH');
    // Clone B and the merged chain are untouched - the break is isolated to A.
    expect(result.cloneB.breaks).toHaveLength(0);
    expect(result.mergedChain.breaks).toHaveLength(0);
  });

  it('CATCHES a reordered merge (a row substituted so id-order linkage breaks)', () => {
    const { cloneA, cloneB, mergedRows } = buildScenario();
    anchorMerge(cloneA, cloneB, mergedRows);

    // Forge a reordered merge: build a DIFFERENT merged chain (an extra event
    // spliced in the middle) so the id-sorted re-walk no longer matches the
    // stored prev links of the original rows. We keep the ORIGINAL rows' stored
    // hashes but swap one row's content for a foreign event at the same id slot.
    const tampered = mergedRows.map((r) => ({ ...r }));
    // Replace the middle row's content but keep its (now-stale) stored hashes - // simulating an attacker who reordered/substituted a row in the merged DB
    // without recomputing the chain. Its recomputed entry_hash will differ and
    // the following row's prev link will no longer match.
    tampered[1]!.reason = 'reordered-foreign-event';

    const result = verifyMergeAuditChain({
      cloneARows: cloneA,
      cloneBRows: cloneB,
      mergedRows: tampered,
      anchorPath,
    });

    expect(result.ok).toBe(false);
    expect(result.mergedChain.breaks.length).toBeGreaterThan(0);
    const reasons = result.mergedChain.breaks.map((b) => b.reason);
    // The substituted row fails its own hash; the next row's prev link breaks.
    expect(
      reasons.includes('ENTRY_HASH_MISMATCH') ||
        reasons.includes('PREV_LINK_MISMATCH') ||
        reasons.includes('PREV_LINK_AND_ENTRY_HASH_MISMATCH'),
    ).toBe(true);
  });

  it('CATCHES a genuinely reordered merged chain (rows reindexed so prev links break)', () => {
    const { cloneA, cloneB } = buildScenario();
    // A clean 4-event merge.
    const { rows: clean } = buildMergedChain([
      { id: 'r-evt-1', memory_id: 'mem-1', reason: 'r1' },
      { id: 'r-evt-2', memory_id: 'mem-2', reason: 'r2' },
      { id: 'r-evt-3', memory_id: 'mem-3', reason: 'r3' },
      { id: 'r-evt-4', memory_id: 'mem-4', reason: 'r4' },
    ]);
    anchorMerge(cloneA, cloneB, clean);

    // Attacker swaps the IDS of two adjacent rows (a reorder) while keeping the
    // stored prev/entry hashes - so the id-sorted walk now traverses them in a
    // different sequence than the stored links describe.
    const reordered = clean.map((r) => ({ ...r }));
    const tmpId = reordered[1]!.id;
    reordered[1]!.id = reordered[2]!.id;
    reordered[2]!.id = tmpId;

    const result = verifyMergeAuditChain({
      cloneARows: cloneA,
      cloneBRows: cloneB,
      mergedRows: reordered,
      anchorPath,
    });

    expect(result.ok).toBe(false);
    expect(result.mergedChain.breaks.length).toBeGreaterThan(0);
  });

  it('REJECTS an anchor whose signature does not verify', () => {
    const { cloneA, cloneB, mergedRows } = buildScenario();
    const rec = anchorMerge(cloneA, cloneB, mergedRows);

    // Corrupt the on-disk signature (flip a hex char) without touching anything
    // else. The anchor body is otherwise intact, but the Ed25519 check fails.
    const corruptHexChar = rec.signature[0] === 'a' ? 'b' : 'a';
    const corruptedSig = corruptHexChar + rec.signature.slice(1);
    // Re-write the log with the corrupted signature.
    const onDisk = JSON.parse(readFileSync(anchorPath, 'utf8').trim()) as Record<string, unknown>;
    onDisk['signature'] = corruptedSig;
    writeFileSync(anchorPath, JSON.stringify(onDisk) + '\n');

    const result = verifyMergeAuditChain({
      cloneARows: cloneA,
      cloneBRows: cloneB,
      mergedRows,
      anchorPath,
    });

    expect(result.ok).toBe(false);
    expect(result.dagAnchor.ok).toBe(false);
    expect(result.dagAnchor.breaks.map((b) => b.reason)).toContain('DAG_SIGNATURE_INVALID');
    // The clone chains and merged chain are all clean - ONLY the anchor failed.
    expect(result.cloneA.breaks).toHaveLength(0);
    expect(result.cloneB.breaks).toHaveLength(0);
    expect(result.mergedChain.breaks).toHaveLength(0);
  });

  it('REJECTS an anchor whose parents do not match the two clone heads', () => {
    const { cloneA, cloneB, mergedRows } = buildScenario();
    // Anchor with WRONG parents (heads of unrelated chains) but a valid signature.
    const wrongA = buildCloneChain('x', ['mem-x']);
    const wrongB = buildCloneChain('y', ['mem-y']);
    appendSignedMergeAnchor(mockRepo(mergedRows), anchorPath, {
      tenantId: 'local',
      parents: [headOf(wrongA), headOf(wrongB)],
      lamportClock: 1,
      privateKeyHex: keys.privateKeyHex,
      publicKeyHex: keys.publicKeyHex,
    });

    const result = verifyMergeAuditChain({
      cloneARows: cloneA,
      cloneBRows: cloneB,
      mergedRows,
      anchorPath,
    });

    expect(result.ok).toBe(false);
    expect(result.dagAnchor.breaks.map((b) => b.reason)).toContain('DAG_PARENT_MISMATCH');
  });

  it('REJECTS when no signed merge anchor exists to cross-check', () => {
    const { cloneA, cloneB, mergedRows } = buildScenario();
    // Do NOT anchor - anchorPath does not exist.
    const result = verifyMergeAuditChain({
      cloneARows: cloneA,
      cloneBRows: cloneB,
      mergedRows,
      anchorPath,
    });

    expect(result.ok).toBe(false);
    expect(result.dagAnchor.breaks.map((b) => b.reason)).toContain('DAG_ANCHOR_MISSING');
    // The chains themselves are clean - only the missing anchor sinks it.
    expect(result.cloneA.breaks).toHaveLength(0);
    expect(result.mergedChain.breaks).toHaveLength(0);
  });
});
