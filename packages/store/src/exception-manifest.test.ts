/**
 * Tests for the byte-pinned exception manifest + 3-state audit-break
 * classifier (bead `compile-then-govern-e06.2`; risk `010-AT-RISK` R1/R2/R7).
 *
 * The ADVERSARIAL R1 case ("re-touching a documented row flips it back to
 * tamper") is the hard gate: it proves the manifest cannot be used to launder
 * a fresh edit inside the known-migration window.
 *
 * @module exception-manifest.test
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeEntryHash } from './audit-chain.js';
import { verifyAuditChain, type AuditChainBreak } from './audit-verify.js';
import {
  classifyChainBreaks,
  computeManifestHash,
  readManifest,
  ExceptionManifestError,
  type ExceptionManifest,
  type ExceptionManifestEntry,
  type StoredRowTuple,
} from './exception-manifest.js';
import type { AuditRepository, AuditChainRow } from './repositories/audit-repository.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a mixed v1/v2 chain that reproduces a hash-version migration break.
 *
 * Rows 0..n are a valid v2 chain. Then we splice in a row written under v1
 * (timestamp-in-hash) whose stored `entry_hash` was minted with the v1
 * serialiser, but whose `prev_entry_hash` still chains from the v2 head — a
 * faithful shape of the real ~155 breaks: intact per-row hash under its own
 * version, but the chronological walk flags it because the recompute anchor
 * moved. Here we deliberately craft a break by storing a row whose entry_hash
 * does NOT recompute under the walk (a genuine ENTRY_HASH_MISMATCH), standing
 * in for the migration artifact — the classifier treats it the same way.
 */

/** A valid v2 row. */
function v2Row(i: number, prev: string | null): AuditChainRow {
  const base = {
    id: `id-${i}`,
    action: 'promoted',
    memory_id: `mem-${i}`,
    tenant_id: 'local',
    actor_json: '{"type":"ai","id":"curator"}',
    reason: `r${i}`,
    details_json: '{}',
    timestamp: `2026-06-17T00:00:0${i}.000Z`,
    hash_version: 2 as const,
  };
  const entry_hash = computeEntryHash({ ...base, prev_entry_hash: prev }, 2);
  return { ...base, prev_entry_hash: prev, entry_hash };
}

/**
 * Seed a chain of `n` valid v2 rows, then append one "migration break" row:
 * its stored entry_hash is a fixed known value that will NOT recompute (so the
 * walk reports ENTRY_HASH_MISMATCH), while its prev link chains correctly from
 * the previous row so the break is isolated to exactly one row. Returns the
 * rows plus the index/id of the break row.
 */
function chainWithMigrationBreak(n: number): {
  rows: AuditChainRow[];
  breakId: string;
} {
  const rows: AuditChainRow[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const r = v2Row(i, prev);
    rows.push(r);
    prev = r.entry_hash;
  }
  // The migration break row: valid prev link, but a stored entry_hash that is
  // frozen to a legacy value (simulating a v1-minted hash that the v2 walk
  // recompute won't reproduce). This yields exactly one ENTRY_HASH_MISMATCH.
  const breakId = `id-${n}`;
  const base = {
    id: breakId,
    action: 'promoted',
    memory_id: `mem-${n}`,
    tenant_id: 'local',
    actor_json: '{"type":"ai","id":"curator"}',
    reason: `r${n}`,
    details_json: '{}',
    timestamp: `2026-06-17T00:00:0${n}.000Z`,
    hash_version: 1 as const,
    prev_entry_hash: prev,
  };
  // A deterministic wrong hash: a v2 recompute of this same row (the walk uses
  // hash_version=1 for this row, so the two diverge → mismatch).
  const legacyStored = computeEntryHash({ ...base }, 2);
  rows.push({ ...base, entry_hash: legacyStored });
  return { rows, breakId };
}

function mockRepo(rows: AuditChainRow[]): AuditRepository {
  return { findAllChronological: () => rows } as unknown as AuditRepository;
}

/** Build the CURRENT-stored-tuple map the classifier reads (id → tuple). */
function rowsByIdOf(rows: AuditChainRow[]): Map<string, StoredRowTuple> {
  const m = new Map<string, StoredRowTuple>();
  for (const r of rows) {
    m.set(r.id, {
      entry_hash: r.entry_hash,
      prev_entry_hash: r.prev_entry_hash,
      hash_version: r.hash_version ?? 1,
      seq: rows.indexOf(r),
    });
  }
  return m;
}

/** Build a manifest that pins every tamper-reason break in the given breaks list. */
function manifestFor(
  breaks: AuditChainBreak[],
  rowsById: Map<string, StoredRowTuple>,
): ExceptionManifest {
  const entries: ExceptionManifestEntry[] = breaks
    .filter((b) => b.reason !== 'CHAIN_FORK')
    .map((b) => {
      const stored = rowsById.get(b.id)!;
      return {
        id: b.id,
        entryHash: stored.entry_hash!,
        prevEntryHash: stored.prev_entry_hash,
        hashVersion: stored.hash_version,
        seq: stored.seq,
        reason: b.reason,
      };
    });
  const body = {
    schemaVersion: 1 as const,
    generatedAt: '2026-06-30T00:00:00.000Z',
    entryCount: entries.length,
    entries,
  };
  return { ...body, manifestHash: computeManifestHash(body) };
}

/** Fork fixture: a v2 chain where a later row's prev link points back to a real earlier row. */
function chainWithFork(): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: string | null = null;
  for (let i = 0; i < 3; i++) {
    const r = v2Row(i, prev);
    rows.push(r);
    prev = r.entry_hash;
  }
  // A 4th row that links back to row 0's entry_hash (a real, already-walked
  // row) rather than row 2 → CHAIN_FORK (own hash intact, prev is a seen hash).
  const forkBase = {
    id: 'id-fork',
    action: 'promoted',
    memory_id: 'mem-fork',
    tenant_id: 'local',
    actor_json: '{"type":"ai","id":"curator"}',
    reason: 'fork',
    details_json: '{}',
    timestamp: '2026-06-17T00:00:09.000Z',
    hash_version: 2 as const,
    prev_entry_hash: rows[0]!.entry_hash,
  };
  const entry_hash = computeEntryHash({ ...forkBase }, 2);
  rows.push({ ...forkBase, entry_hash });
  return rows;
}

// ---------------------------------------------------------------------------
// (a) genuine known breaks classify as documentedExceptions
// ---------------------------------------------------------------------------

describe('classifyChainBreaks — documented exceptions', () => {
  it('classifies genuine known-migration breaks as documentedExceptions (verified true)', () => {
    const { rows, breakId } = chainWithMigrationBreak(3);
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));

    // Sanity: exactly one break, at the migration row.
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.id).toBe(breakId);
    expect(breaks[0]!.reason).toBe('ENTRY_HASH_MISMATCH');

    const manifest = manifestFor(breaks, rowsById);
    const result = classifyChainBreaks(breaks, manifest, rowsById);

    expect(result.documentedExceptions.map((b) => b.id)).toEqual([breakId]);
    expect(result.tamperSignatures).toHaveLength(0);
    expect(result.chainForks).toHaveLength(0);
    // Only tamper/fork gate `verified`; a documented exception does not.
    expect(result.verified).toBe(true);
  });

  it('a clean chain with no breaks verifies true with an empty manifest', () => {
    const rows: AuditChainRow[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 3; i++) {
      const r = v2Row(i, prev);
      rows.push(r);
      prev = r.entry_hash;
    }
    const { breaks } = verifyAuditChain(mockRepo(rows));
    expect(breaks).toHaveLength(0);
    const result = classifyChainBreaks(breaks, null, rowsByIdOf(rows));
    expect(result.verified).toBe(true);
    expect(result.documentedExceptions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (b) ADVERSARIAL / R1 — re-touching a documented row flips it to tamper
// ---------------------------------------------------------------------------

describe('classifyChainBreaks — ADVERSARIAL no-laundering (R1)', () => {
  it('a documented row whose stored entry_hash is MUTATED becomes a tamperSignature', () => {
    const { rows, breakId } = chainWithMigrationBreak(3);
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));
    const manifest = manifestFor(breaks, rowsById);

    // Baseline: the break is documented.
    expect(
      classifyChainBreaks(breaks, manifest, rowsById).documentedExceptions.map((b) => b.id),
    ).toEqual([breakId]);

    // ATTACK: an editor with write access edits the DOCUMENTED row and re-hashes
    // it forward. In the DB, the row's stored entry_hash is now a NEW value. The
    // manifest still pins the OLD tuple. Simulate by mutating the current stored
    // tuple the classifier reads.
    const attackedRowsById = new Map(rowsById);
    const original = attackedRowsById.get(breakId)!;
    attackedRowsById.set(breakId, { ...original, entry_hash: 'attacker-rehashed-value' });

    // The verifier still reports a break for that row (its content changed);
    // the classifier must NOT excuse it as documented — the pinned tuple no
    // longer byte-matches the live stored tuple.
    const result = classifyChainBreaks(breaks, manifest, attackedRowsById);

    expect(result.documentedExceptions).toHaveLength(0);
    expect(result.tamperSignatures.map((b) => b.id)).toEqual([breakId]);
    expect(result.verified).toBe(false);
  });

  it('drift in prev_entry_hash, hash_version, or seq alone each flips to tamper', () => {
    const { rows, breakId } = chainWithMigrationBreak(3);
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));
    const manifest = manifestFor(breaks, rowsById);
    const base = rowsById.get(breakId)!;

    for (const drift of [
      { prev_entry_hash: 'moved-prev' },
      { hash_version: 2 },
      { seq: base.seq + 100 },
    ]) {
      const attacked = new Map(rowsById);
      attacked.set(breakId, { ...base, ...drift });
      const result = classifyChainBreaks(breaks, manifest, attacked);
      expect(result.documentedExceptions).toHaveLength(0);
      expect(result.tamperSignatures.map((b) => b.id)).toEqual([breakId]);
      expect(result.verified).toBe(false);
    }
  });

  it('a documented row whose live reason CHANGED is no longer covered', () => {
    const { rows, breakId } = chainWithMigrationBreak(3);
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));
    const manifest = manifestFor(breaks, rowsById);

    // The live break now reports a DIFFERENT tamper reason than the manifest
    // minted for the same id + tuple. Reason drift => not the same exception.
    const drifted: AuditChainBreak[] = breaks.map((b) =>
      b.id === breakId ? { ...b, reason: 'PREV_LINK_MISMATCH' as const } : b,
    );
    const result = classifyChainBreaks(drifted, manifest, rowsById);
    expect(result.documentedExceptions).toHaveLength(0);
    expect(result.tamperSignatures.map((b) => b.id)).toEqual([breakId]);
  });
});

// ---------------------------------------------------------------------------
// (c) an id NOT in the manifest is a tamperSignature
// ---------------------------------------------------------------------------

describe('classifyChainBreaks — unlisted id', () => {
  it('a break whose id is absent from the manifest is a tamperSignature', () => {
    const { rows, breakId } = chainWithMigrationBreak(3);
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));

    // Empty manifest → id is not listed → tamper.
    const empty: ExceptionManifest = {
      schemaVersion: 1,
      generatedAt: '2026-06-30T00:00:00.000Z',
      entryCount: 0,
      entries: [],
      manifestHash: computeManifestHash({
        schemaVersion: 1,
        generatedAt: '2026-06-30T00:00:00.000Z',
        entryCount: 0,
        entries: [],
      }),
    };
    const result = classifyChainBreaks(breaks, empty, rowsById);
    expect(result.documentedExceptions).toHaveLength(0);
    expect(result.tamperSignatures.map((b) => b.id)).toEqual([breakId]);
    expect(result.verified).toBe(false);
  });

  it('a null manifest makes every tamper-reason break a tamperSignature', () => {
    const { rows, breakId } = chainWithMigrationBreak(3);
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));
    const result = classifyChainBreaks(breaks, null, rowsById);
    expect(result.tamperSignatures.map((b) => b.id)).toEqual([breakId]);
    expect(result.verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) CHAIN_FORK → chainForks, verified false while present
// ---------------------------------------------------------------------------

describe('classifyChainBreaks — chain forks', () => {
  it('classifies a CHAIN_FORK into chainForks and reports verified false', () => {
    const rows = chainWithFork();
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));

    const forks = breaks.filter((b) => b.reason === 'CHAIN_FORK');
    expect(forks.length).toBeGreaterThanOrEqual(1);

    const result = classifyChainBreaks(breaks, null, rowsById);
    expect(result.chainForks.length).toBe(forks.length);
    expect(result.tamperSignatures).toHaveLength(0);
    expect(result.verified).toBe(false);
  });

  it('a manifest cannot green a CHAIN_FORK (reason branch wins first)', () => {
    const rows = chainWithFork();
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));
    const forkId = breaks.find((b) => b.reason === 'CHAIN_FORK')!.id;
    const stored = rowsById.get(forkId)!;

    // Craft a (nonsensical) manifest that lists the fork id with a tamper
    // reason. It must have NO effect: the fork stays a fork.
    const body = {
      schemaVersion: 1 as const,
      generatedAt: '2026-06-30T00:00:00.000Z',
      entryCount: 1,
      entries: [
        {
          id: forkId,
          entryHash: stored.entry_hash!,
          prevEntryHash: stored.prev_entry_hash,
          hashVersion: stored.hash_version,
          seq: stored.seq,
          reason: 'ENTRY_HASH_MISMATCH' as const,
        },
      ],
    };
    const manifest: ExceptionManifest = { ...body, manifestHash: computeManifestHash(body) };
    const result = classifyChainBreaks(breaks, manifest, rowsById);
    expect(result.chainForks.map((b) => b.id)).toContain(forkId);
    expect(result.documentedExceptions.map((b) => b.id)).not.toContain(forkId);
    expect(result.verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e) readManifest integrity gates
// ---------------------------------------------------------------------------

describe('readManifest — integrity gates', () => {
  let manifestPath: string;
  beforeEach(() => {
    manifestPath = join(
      tmpdir(),
      `gsb-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
  });
  afterEach(() => {
    if (existsSync(manifestPath)) rmSync(manifestPath);
  });

  it('round-trips a valid manifest', () => {
    const { rows } = chainWithMigrationBreak(3);
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));
    const manifest = manifestFor(breaks, rowsById);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const loaded = readManifest(manifestPath);
    expect(loaded.entryCount).toBe(manifest.entryCount);
    expect(loaded.manifestHash).toBe(manifest.manifestHash);
    expect(loaded.entries.map((e) => e.id)).toEqual(manifest.entries.map((e) => e.id));
  });

  it('throws when entries.length !== entryCount (R2 hard count-assert)', () => {
    const { rows } = chainWithMigrationBreak(3);
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));
    const manifest = manifestFor(breaks, rowsById);
    // Bump entryCount so it disagrees with the array length (drop the hash check
    // out of the way by also leaving manifestHash — count-assert fires first).
    const tampered = { ...manifest, entryCount: manifest.entryCount + 1 };
    writeFileSync(manifestPath, JSON.stringify(tampered));
    expect(() => readManifest(manifestPath)).toThrow(ExceptionManifestError);
    expect(() => readManifest(manifestPath)).toThrow(/entryCount .* != entries\.length/);
  });

  it('throws when the manifest body was edited (manifestHash mismatch)', () => {
    const { rows } = chainWithMigrationBreak(3);
    const rowsById = rowsByIdOf(rows);
    const { breaks } = verifyAuditChain(mockRepo(rows));
    const manifest = manifestFor(breaks, rowsById);
    // Edit a pinned hash but keep the stale manifestHash + matching count.
    const edited = {
      ...manifest,
      entries: manifest.entries.map((e, i) => (i === 0 ? { ...e, entryHash: 'swapped' } : e)),
    };
    writeFileSync(manifestPath, JSON.stringify(edited));
    expect(() => readManifest(manifestPath)).toThrow(/manifestHash mismatch/);
  });

  it('throws on unsupported schemaVersion', () => {
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        generatedAt: 'x',
        entryCount: 0,
        entries: [],
        manifestHash: 'x',
      }),
    );
    expect(() => readManifest(manifestPath)).toThrow(/unsupported schemaVersion/);
  });

  it('throws on non-JSON content', () => {
    writeFileSync(manifestPath, 'not json at all {');
    expect(() => readManifest(manifestPath)).toThrow(/not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// computeManifestHash — determinism / order-independence
// ---------------------------------------------------------------------------

describe('computeManifestHash', () => {
  it('is independent of input entry order (entries are sorted by seq,id)', () => {
    const entries: ExceptionManifestEntry[] = [
      {
        id: 'b',
        entryHash: 'h2',
        prevEntryHash: 'h1',
        hashVersion: 1,
        seq: 2,
        reason: 'ENTRY_HASH_MISMATCH',
      },
      {
        id: 'a',
        entryHash: 'h1',
        prevEntryHash: null,
        hashVersion: 1,
        seq: 1,
        reason: 'PREV_LINK_MISMATCH',
      },
    ];
    const body1 = { schemaVersion: 1 as const, generatedAt: 't', entryCount: 2, entries };
    const body2 = {
      schemaVersion: 1 as const,
      generatedAt: 't',
      entryCount: 2,
      entries: [...entries].reverse(),
    };
    expect(computeManifestHash(body1)).toBe(computeManifestHash(body2));
  });

  it('changes when any pinned field changes', () => {
    const base = {
      schemaVersion: 1 as const,
      generatedAt: 't',
      entryCount: 1,
      entries: [
        {
          id: 'a',
          entryHash: 'h1',
          prevEntryHash: null,
          hashVersion: 1 as number,
          seq: 1,
          reason: 'ENTRY_HASH_MISMATCH' as const,
        },
      ],
    };
    const h0 = computeManifestHash(base);
    const h1 = computeManifestHash({
      ...base,
      entries: [{ ...base.entries[0]!, entryHash: 'h1-edited' }],
    });
    expect(h1).not.toBe(h0);
  });
});
