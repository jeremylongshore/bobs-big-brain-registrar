/** Generated synthetic audit contracts. Replay fast-check failures with its seed/path. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { appendAnchor, verifyAnchors } from '../audit-anchor.js';
import { canonicalRowJson, computeEntryHash, type CanonicalAuditRow } from '../audit-chain.js';
import { verifyAuditChain } from '../audit-verify.js';
import { createTestDatabase } from '../database.js';
import {
  classifyChainBreaks,
  computeManifestHash,
  type ExceptionManifest,
  type StoredRowTuple,
} from '../exception-manifest.js';
import { AuditRepository, type AuditChainRow } from '../repositories/audit-repository.js';

const SEED = 0x6a10;
const CLOCK = '2026-01-01T00:00:00.000Z';
const OTHER_CLOCK = '2026-01-02T00:00:00.000Z';
const PURE = { seed: SEED, numRuns: 100 };
const payload = fc.record({
  reason: fc.option(fc.string({ maxLength: 32 }), { nil: null }),
  actor: fc.string({ maxLength: 24 }),
  detail: fc.string({ maxLength: 32 }),
  legacy: fc.boolean(),
});
const chainInput = fc.array(payload, { minLength: 2, maxLength: 24 });
type Payload = typeof payload extends fc.Arbitrary<infer Value> ? Value : never;
type Row = AuditChainRow & { seq: number };

// Test-owned frozen wire order, independent of the production serialisers.
function wire(row: CanonicalAuditRow, version: 1 | 2): string {
  const entries: Array<[string, unknown]> = [
    ['id', row.id],
    ['action', row.action],
    ['memory_id', row.memory_id],
    ['tenant_id', row.tenant_id],
    ['actor_json', row.actor_json],
    ['reason', row.reason],
    ['details_json', row.details_json],
  ];
  if (version === 1) entries.push(['timestamp', row.timestamp]);
  entries.push(['prev_entry_hash', row.prev_entry_hash]);
  return (
    '{' +
    entries.map(([key, value]) => JSON.stringify(key) + ':' + JSON.stringify(value)).join(',') +
    '}'
  );
}
function digest(row: CanonicalAuditRow, version: 1 | 2): string {
  return createHash('sha256').update(wire(row, version), 'utf8').digest('hex');
}
function version(row: AuditChainRow): 1 | 2 {
  return row.hash_version === 2 ? 2 : 1;
}
function rowsOf(input: Payload[]): Row[] {
  const rows: Row[] = [];
  for (const [index, item] of input.entries()) {
    const row: Row = {
      seq: index + 1,
      id: `00000000-0000-4000-8000-${(input.length - index).toString(16).padStart(12, '0')}`,
      action: 'promoted',
      memory_id: '11111111-1111-4111-8111-111111111111',
      tenant_id: 'property-tenant',
      actor_json: JSON.stringify({ type: 'human', id: item.actor }),
      reason: item.reason,
      details_json: JSON.stringify({ note: item.detail }),
      timestamp: CLOCK,
      // Always exercise both wire versions; later rows also vary legacy/null forms.
      hash_version: index === 0 ? 1 : index === 1 ? 2 : item.legacy ? null : 2,
      prev_entry_hash: rows.at(-1)?.entry_hash ?? null,
      entry_hash: null,
    };
    row.entry_hash = digest(row, version(row));
    rows.push(row);
  }
  return rows;
}
function repoOf(rows: AuditChainRow[]): AuditRepository {
  return { findAllChronological: () => rows } as unknown as AuditRepository;
}
function stored(rows: Row[]): Map<string, StoredRowTuple> {
  return new Map(
    rows.map((row) => [
      row.id,
      {
        entry_hash: row.entry_hash,
        prev_entry_hash: row.prev_entry_hash,
        hash_version: row.hash_version ?? 1,
        seq: row.seq,
      },
    ]),
  );
}
function partition(rows: Row[], manifest: ExceptionManifest | null = null) {
  return classifyChainBreaks(verifyAuditChain(repoOf(rows)).breaks, manifest, stored(rows));
}
function insertRows(db: ReturnType<typeof createTestDatabase>, rows: Row[]): void {
  const insert = db.prepare(`INSERT INTO audit_events
    (id, action, memory_id, tenant_id, actor_json, reason, details_json, timestamp,
     entry_hash, prev_entry_hash, hash_version, seq)
    VALUES (@id, @action, @memory_id, @tenant_id, @actor_json, @reason, @details_json,
      @timestamp, @entry_hash, @prev_entry_hash, @hash_version, @seq)`);
  // SQL schema requires an explicit version; null's legacy fallback is tested
  // above on raw verifier rows, while persisted legacy rows use version 1.
  for (const row of rows) insert.run({ ...row, hash_version: row.hash_version ?? 1 });
}

describe('generated audit-chain invariants (seed 0x6a10)', () => {
  it('pins independent wire bytes, mixed-version hashes, links and timestamp semantics', () => {
    const golden: CanonicalAuditRow = {
      id: 'id',
      action: 'promoted',
      memory_id: 'memory',
      tenant_id: 'tenant',
      actor_json: '{}',
      reason: null,
      details_json: '{}',
      timestamp: CLOCK,
      prev_entry_hash: null,
    };
    const v2 =
      '{"id":"id","action":"promoted","memory_id":"memory","tenant_id":"tenant","actor_json":"{}","reason":null,"details_json":"{}","prev_entry_hash":null}';
    const v1 =
      '{"id":"id","action":"promoted","memory_id":"memory","tenant_id":"tenant","actor_json":"{}","reason":null,"details_json":"{}","timestamp":"2026-01-01T00:00:00.000Z","prev_entry_hash":null}';
    expect(wire(golden, 1)).toBe(v1);
    expect(wire(golden, 2)).toBe(v2);
    fc.assert(
      fc.property(chainInput, (input) => {
        const rows = rowsOf(input);
        const before = JSON.stringify(rows);
        for (const [index, row] of rows.entries()) {
          expect(row.prev_entry_hash).toBe(index === 0 ? null : rows[index - 1]!.entry_hash);
          expect(canonicalRowJson(row, version(row))).toBe(wire(row, version(row)));
          expect(computeEntryHash(row, version(row))).toBe(row.entry_hash);
          const moved = { ...row, timestamp: OTHER_CLOCK };
          expect(computeEntryHash(moved, 2)).toBe(computeEntryHash(row, 2));
          expect(computeEntryHash(moved, 1)).not.toBe(computeEntryHash(row, 1));
        }
        expect(verifyAuditChain(repoOf(rows))).toEqual({
          totalRows: rows.length,
          unverifiedRows: 0,
          cleanRows: rows.length,
          breaks: [],
        });
        const preMigration: Row = {
          ...rows[0]!,
          id: 'pre-migration-unverified',
          seq: 0,
          entry_hash: null,
          prev_entry_hash: null,
          hash_version: null,
        };
        expect(verifyAuditChain(repoOf([preMigration, ...rows]))).toEqual({
          totalRows: rows.length + 1,
          unverifiedRows: 1,
          cleanRows: rows.length,
          breaks: [],
        });
        expect(JSON.stringify(rows)).toBe(before);
      }),
      PURE,
    );
  });

  it('detects each version-hashed field mutation without hiding it as a fork', () => {
    fc.assert(
      fc.property(chainInput, fc.nat(), (input, choice) => {
        const original = rowsOf(input);
        const index = choice % original.length;
        const row = original[index]!;
        const changes: Partial<Row>[] = [
          { id: row.id + '-changed' },
          { action: row.action + '-changed' },
          { memory_id: row.memory_id + '-changed' },
          { tenant_id: row.tenant_id + '-changed' },
          { actor_json: row.actor_json + ' ' },
          { reason: (row.reason ?? '') + '-changed' },
          { details_json: row.details_json + ' ' },
          { prev_entry_hash: 'f'.repeat(64) },
        ];
        if (version(row) === 1) changes.push({ timestamp: OTHER_CLOCK });
        for (const change of changes) {
          const rows = structuredClone(original);
          rows[index] = { ...row, ...change };
          const result = verifyAuditChain(repoOf(rows));
          expect(
            result.breaks.some(
              (failure) => failure.id === rows[index]!.id && failure.reason !== 'CHAIN_FORK',
            ),
          ).toBe(true);
          expect(partition(rows).tamperSignatures.map((failure) => failure.id)).toContain(
            rows[index]!.id,
          );
        }
      }),
      PURE,
    );
  });

  it('returns exact insertion/seq order despite timestamp collisions and reverse UUID order', () => {
    fc.assert(
      fc.property(chainInput, (input) => {
        const db = createTestDatabase();
        try {
          const repo = new AuditRepository(db);
          const rows = rowsOf(input);
          for (const [index, row] of rows.entries())
            repo.insert({
              id: row.id,
              action: 'promoted',
              memoryId: row.memory_id,
              tenantId: row.tenant_id,
              actor: { type: 'human', id: 'property-writer' },
              reason: row.reason || undefined,
              details: { note: input[index]!.detail },
              timestamp: index % 3 === 0 ? OTHER_CLOCK : CLOCK,
            });
          const first = repo.findAllChronological() as Row[];
          expect(first.map((row) => row.id)).toEqual(rows.map((row) => row.id));
          expect(first.map((row) => row.seq)).toEqual(rows.map((_, index) => index + 1));
          expect(repo.findAllChronological()).toEqual(first);
          expect(verifyAuditChain(repo).breaks).toEqual([]);
        } finally {
          db.close();
        }
      }),
      { seed: SEED, numRuns: 40 },
    );
  });

  it('classifies intact-earlier forks stably and never trusts a broken anchor', () => {
    fc.assert(
      fc.property(fc.array(payload, { minLength: 3, maxLength: 24 }), (input) => {
        const rows = rowsOf(input);
        const last = rows.at(-1)!;
        last.prev_entry_hash = rows[0]!.entry_hash;
        last.entry_hash = digest(last, version(last));
        const before = JSON.stringify(rows);
        const result = partition(rows);
        expect(result.chainForks.map((failure) => failure.id)).toEqual([last.id]);
        expect(result.tamperSignatures).toEqual([]);
        expect(result.documentedExceptions).toEqual([]);
        expect(result.verified).toBe(false);
        expect(partition(rows)).toEqual(result);
        const tuple = stored(rows).get(last.id)!;
        const body = {
          schemaVersion: 1 as const,
          generatedAt: CLOCK,
          entryCount: 1,
          entries: [
            {
              id: last.id,
              entryHash: tuple.entry_hash,
              prevEntryHash: tuple.prev_entry_hash,
              hashVersion: tuple.hash_version,
              seq: tuple.seq,
              reason: 'ENTRY_HASH_MISMATCH' as const,
            },
          ],
        };
        const forkPin = { ...body, manifestHash: computeManifestHash(body) };
        expect(partition(rows, forkPin)).toEqual(result);
        expect(JSON.stringify(rows)).toBe(before);
        rows[0]!.reason = (rows[0]!.reason ?? '') + '-changed';
        const attacked = partition(rows);
        expect(attacked.chainForks.map((failure) => failure.id)).not.toContain(last.id);
        expect(attacked.tamperSignatures.map((failure) => failure.id)).toContain(last.id);
        expect(attacked.documentedExceptions).toEqual([]);
        expect(attacked.chainForks).toEqual([]);
        expect(attacked.tamperSignatures.map((failure) => failure.id)).toEqual([
          rows[0]!.id,
          last.id,
        ]);
      }),
      PURE,
    );
  });

  it('requires every byte-pin field and live reason, including null hash pins', () => {
    fc.assert(
      fc.property(chainInput, fc.boolean(), (input, cleared) => {
        const rows = rowsOf(input);
        const last = rows.at(-1)!;
        last.entry_hash = cleared ? null : 'f'.repeat(64);
        const failures = verifyAuditChain(repoOf(rows)).breaks;
        expect(failures).toHaveLength(1);
        expect(failures[0]!.reason).toBe('ENTRY_HASH_MISMATCH');
        const tuple = stored(rows).get(last.id)!;
        const body = {
          schemaVersion: 1 as const,
          generatedAt: CLOCK,
          entryCount: 1,
          entries: [
            {
              id: last.id,
              entryHash: tuple.entry_hash,
              prevEntryHash: tuple.prev_entry_hash,
              hashVersion: tuple.hash_version,
              seq: tuple.seq,
              reason: 'ENTRY_HASH_MISMATCH' as const,
            },
          ],
        };
        const manifest = { ...body, manifestHash: computeManifestHash(body) };
        const before = JSON.stringify({ rows, manifest });
        const accepted = partition(rows, manifest);
        expect(accepted.documentedExceptions).toEqual(failures);
        expect(accepted.verified).toBe(true);
        const drifts: Partial<StoredRowTuple>[] = [
          { entry_hash: cleared ? 'a'.repeat(64) : null },
          { prev_entry_hash: null },
          { hash_version: tuple.hash_version === 1 ? 2 : 1 },
          { seq: tuple.seq + 1 },
        ];
        for (const drift of drifts) {
          const live = stored(rows);
          live.set(last.id, { ...tuple, ...drift });
          const result = classifyChainBreaks(failures, manifest, live);
          expect(result.documentedExceptions).toEqual([]);
          expect(result.tamperSignatures).toEqual(failures);
          expect(result.verified).toBe(false);
        }
        const reasonDrift = failures.map((failure) => ({
          ...failure,
          reason: 'PREV_LINK_MISMATCH' as const,
        }));
        expect(classifyChainBreaks(reasonDrift, manifest, stored(rows)).tamperSignatures).toEqual(
          reasonDrift,
        );
        expect(classifyChainBreaks(failures, null, stored(rows)).tamperSignatures).toEqual(
          failures,
        );
        expect(classifyChainBreaks(failures, manifest, new Map()).tamperSignatures).toEqual(
          failures,
        );
        expect(JSON.stringify({ rows, manifest })).toBe(before);
      }),
      PURE,
    );
  });

  it('retains an earlier real-DB anchor that exposes a fully rehashed mixed-version rewrite', () => {
    fc.assert(
      fc.property(chainInput, fc.nat(), (input, choice) => {
        const db = createTestDatabase();
        const root = mkdtempSync(join(tmpdir(), 'audit-property-anchor-'));
        try {
          const rows = rowsOf(input);
          insertRows(db, rows);
          const repo = new AuditRepository(db);
          const anchor = join(root, 'anchor.jsonl');
          appendAnchor(repo, anchor, { tenantId: 'property-tenant', nowFn: () => CLOCK });
          const retained = readFileSync(anchor);
          expect(verifyAnchors(repo, anchor).ok).toBe(true);
          const index = choice % rows.length;
          rows[index]!.reason = (rows[index]!.reason ?? '') + '-rewritten';
          const update = db.prepare(
            'UPDATE audit_events SET reason = ?, prev_entry_hash = ?, entry_hash = ? WHERE id = ?',
          );
          for (let at = index; at < rows.length; at++) {
            const row = rows[at]!;
            row.prev_entry_hash = at === 0 ? null : rows[at - 1]!.entry_hash;
            row.entry_hash = digest(row, version(row));
            update.run(row.reason, row.prev_entry_hash, row.entry_hash, row.id);
          }
          expect(verifyAuditChain(repo).breaks).toEqual([]);
          const result = verifyAnchors(repo, anchor);
          expect(result.ok).toBe(false);
          expect(result.anchorBreaks.map((failure) => failure.reason)).toContain(
            'HISTORY_REWRITTEN',
          );
          expect(readFileSync(anchor)).toEqual(retained);
        } finally {
          db.close();
          rmSync(root, { recursive: true, force: true });
        }
      }),
      { seed: SEED, numRuns: 15 },
    );
  });
});
