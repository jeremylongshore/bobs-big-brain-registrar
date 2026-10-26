import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendAnchor,
  readAnchors,
  verifyAnchors,
  verifyAnchorRecords,
  parseAnchorLog,
} from './audit-anchor.js';
import { computeEntryHash } from './audit-chain.js';
import { verifyAuditChain } from './audit-verify.js';
import type { AuditRepository, AuditChainRow } from './repositories/audit-repository.js';

/** Build a VALID hash chain (correct entry_hash + prev links) from a list of reasons. */
function buildChain(reasons: string[]): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: string | null = null;
  reasons.forEach((reason, i) => {
    // hash_version 2 is the current write form (timestamp excluded from the
    // canonical body); computeEntryHash defaults to it, so the row hashes
    // reproducibly regardless of the timestamp value baked in below.
    const base = {
      id: `id-${i}`,
      action: 'promoted',
      memory_id: `mem-${i}`,
      tenant_id: 'local',
      actor_json: '{"type":"ai","id":"curator"}',
      reason,
      details_json: '{}',
      timestamp: `2026-06-17T00:00:0${i}.000Z`,
      hash_version: 2 as const,
    };
    const entry_hash = computeEntryHash({ ...base, prev_entry_hash: prev });
    rows.push({ ...base, prev_entry_hash: prev, entry_hash });
    prev = entry_hash;
  });
  return rows;
}

/** Minimal AuditRepository: verifyAuditChain + the anchor module only call findAllChronological. */
function mockRepo(rows: AuditChainRow[]): AuditRepository {
  return { findAllChronological: () => rows } as unknown as AuditRepository;
}

describe('audit-anchor', () => {
  let anchorPath: string;
  beforeEach(() => {
    anchorPath = join(
      tmpdir(),
      `gsb-anchor-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
  });
  afterEach(() => {
    if (existsSync(anchorPath)) rmSync(anchorPath);
  });

  it('appendAnchor snapshots the chain head and links the log', () => {
    const rows = buildChain(['a', 'b', 'c']);
    const repo = mockRepo(rows);

    const first = appendAnchor(repo, anchorPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    expect(first.chainedRows).toBe(3);
    expect(first.chainHead).toBe(rows[2]!.entry_hash);
    expect(first.prevAnchorHash).toBeNull();

    const grown = mockRepo(buildChain(['a', 'b', 'c', 'd', 'e']));
    const second = appendAnchor(grown, anchorPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T02:00:00.000Z',
    });
    expect(second.chainedRows).toBe(5);
    expect(second.prevAnchorHash).toBe(first.anchorHash);
    expect(readAnchors(anchorPath)).toHaveLength(2);
  });

  it('appendAnchor is a no-op on an UNCHANGED head — a no-op run adds no anchor (jfv.2.5c)', () => {
    const repo = mockRepo(buildChain(['a', 'b', 'c']));
    const first = appendAnchor(repo, anchorPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    // Same head, same row count (a no-op govern run) → returns the last record,
    // writes NO new anchor line and no new chain link.
    const again = appendAnchor(repo, anchorPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T02:00:00.000Z',
    });
    expect(again).toEqual(first);
    expect(readAnchors(anchorPath)).toHaveLength(1);
    // But a REAL new write still anchors.
    const grown = mockRepo(buildChain(['a', 'b', 'c', 'd']));
    appendAnchor(grown, anchorPath, { tenantId: 'local', nowFn: () => '2026-06-17T03:00:00.000Z' });
    expect(readAnchors(anchorPath)).toHaveLength(2);
  });

  it('verifyAnchors passes on a clean chain + intact log', () => {
    const repo = mockRepo(buildChain(['a', 'b', 'c']));
    appendAnchor(repo, anchorPath, { tenantId: 'local' });
    const result = verifyAnchors(repo, anchorPath);
    expect(result.ok).toBe(true);
    expect(result.chain.breaks).toHaveLength(0);
    expect(result.anchorBreaks).toHaveLength(0);
  });

  it('catches a SILENT FULL REWRITE that verifyAuditChain alone passes clean', () => {
    // Anchor a clean 3-row chain.
    const original = mockRepo(buildChain(['a', 'b', 'c']));
    appendAnchor(original, anchorPath, { tenantId: 'local' });

    // Attacker edits the FIRST event and re-hashes the whole chain forward.
    const rewritten = buildChain(['TAMPERED', 'b', 'c']);
    const rewrittenRepo = mockRepo(rewritten);

    // verifyAuditChain is fooled — the rewrite is internally consistent.
    expect(verifyAuditChain(rewrittenRepo).breaks).toHaveLength(0);

    // verifyAnchors is NOT fooled — the anchored head no longer matches.
    const result = verifyAnchors(rewrittenRepo, anchorPath);
    expect(result.ok).toBe(false);
    expect(result.anchorBreaks.map((b) => b.reason)).toContain('HISTORY_REWRITTEN');
  });

  it('flags a truncated chain (rows deleted since anchor)', () => {
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c'])), anchorPath, { tenantId: 'local' });
    const result = verifyAnchors(mockRepo(buildChain(['a', 'b'])), anchorPath);
    expect(result.ok).toBe(false);
    expect(result.anchorBreaks.map((b) => b.reason)).toContain('HISTORY_TRUNCATED');
  });

  it('flags an edited anchor record (anchor log itself tampered)', () => {
    const repo = mockRepo(buildChain(['a', 'b', 'c']));
    appendAnchor(repo, anchorPath, { tenantId: 'local' });

    // Edit the anchored chainHead without recomputing anchorHash.
    const rec = JSON.parse(readFileSync(anchorPath, 'utf8').trim()) as Record<string, unknown>;
    rec['chainHead'] = 'forged';
    writeFileSync(anchorPath, JSON.stringify(rec) + '\n');

    const result = verifyAnchors(repo, anchorPath);
    expect(result.ok).toBe(false);
    expect(result.anchorBreaks.map((b) => b.reason)).toContain('ANCHOR_HASH_MISMATCH');
  });

  it('verifies the captured snapshot after its original path changes, without altering records', () => {
    const repo = mockRepo(buildChain(['a', 'b', 'c']));
    appendAnchor(repo, anchorPath, { tenantId: 'local' });
    const bytes = readFileSync(anchorPath, 'utf8');
    const records = parseAnchorLog(bytes);
    const expected = verifyAnchors(repo, anchorPath);
    for (const record of records) Object.freeze(record);
    Object.freeze(records);
    writeFileSync(anchorPath, 'invalid replacement snapshot');
    expect(() => verifyAnchors(repo, anchorPath)).toThrow(SyntaxError);
    expect(verifyAnchorRecords(repo, records)).toEqual(expected);
    expect(JSON.stringify(records)).toBe(JSON.stringify(parseAnchorLog(bytes)));
    expect(readFileSync(anchorPath, 'utf8')).toBe('invalid replacement snapshot');
    rmSync(anchorPath);
    expect(verifyAnchorRecords(repo, records)).toEqual(expected);
    expect(existsSync(anchorPath)).toBe(false);
  });

  it.each(['', '\n \n\t\n'])('preserves canonical empty snapshot parsing for %j', (bytes) => {
    const repo = mockRepo(buildChain(['a']));
    writeFileSync(anchorPath, bytes);
    expect(parseAnchorLog(bytes)).toEqual([]);
    expect(verifyAnchorRecords(repo, parseAnchorLog(bytes))).toEqual(
      verifyAnchors(repo, anchorPath),
    );
  });

  it.each(['{', '{}\n{', 'not JSON'])(
    'rejects malformed or truncated JSONL snapshots %j',
    (bytes) => {
      writeFileSync(anchorPath, bytes);
      expect(() => parseAnchorLog(bytes)).toThrow(SyntaxError);
      expect(() => readAnchors(anchorPath)).toThrow(SyntaxError);
    },
  );

  it.each(['rewrite', 'truncate', 'anchor-edit', 'splice', 'fork'] as const)(
    'shares canonical path and snapshot refusal for %s',
    (kind) => {
      const rows = buildChain(['a', 'b', 'c']);
      const original = mockRepo(rows);
      appendAnchor(original, anchorPath, { tenantId: 'local' });
      appendAnchor(mockRepo(buildChain(['a', 'b', 'c', 'd'])), anchorPath, { tenantId: 'local' });
      const records = readAnchors(anchorPath);
      let current = mockRepo(buildChain(['a', 'b', 'c', 'd']));
      if (kind === 'rewrite') current = mockRepo(buildChain(['changed', 'b', 'c', 'd']));
      if (kind === 'truncate') current = mockRepo(buildChain(['a']));
      if (kind === 'anchor-edit') records[0]!.chainHead = 'forged';
      if (kind === 'splice') records.reverse();
      if (kind === 'fork') {
        const fork = buildChain(['a', 'b', 'c', 'd']);
        fork[2]!.prev_entry_hash = fork[0]!.entry_hash;
        fork[2]!.entry_hash = computeEntryHash(fork[2]!);
        fork[3]!.prev_entry_hash = fork[2]!.entry_hash;
        fork[3]!.entry_hash = computeEntryHash(fork[3]!);
        current = mockRepo(fork);
      }
      const bytes = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
      writeFileSync(anchorPath, bytes);
      const captured = parseAnchorLog(bytes);
      const before = JSON.stringify(captured);
      const result = verifyAnchorRecords(current, captured);
      expect(result).toEqual(verifyAnchors(current, anchorPath));
      expect(result.ok).toBe(false);
      if (kind === 'fork')
        expect(result.chain.breaks.some((entry) => entry.reason === 'CHAIN_FORK')).toBe(true);
      else {
        const reason = {
          rewrite: 'HISTORY_REWRITTEN',
          truncate: 'HISTORY_TRUNCATED',
          'anchor-edit': 'ANCHOR_HASH_MISMATCH',
          splice: 'ANCHOR_LINK_MISMATCH',
        }[kind];
        expect(result.anchorBreaks.some((entry) => entry.reason === reason)).toBe(true);
      }
      expect(JSON.stringify(captured)).toBe(before);
    },
  );
});
