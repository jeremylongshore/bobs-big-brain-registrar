/**
 * Tests for the `verify-corpus-accounting` subcommand (Track G2 substrate
 * guard): every curated_memories row must carry a row-creating audit receipt
 * (action 'promoted'). A raw SQL INSERT that bypasses the curator promoter —
 * the substrate bypass — must be DETECTABLE.
 *
 * The legitimate row is planted via the REAL promoter path (`promote()`, the
 * only non-test call site of MemoryRepository.insert), exactly as
 * promoter.test.ts drives it. The bypass row is planted with a direct db
 * handle, mimicking an operator running raw SQL against the store.
 *
 * @module __tests__/verify-corpus-accounting.test
 */

import { randomUUID } from 'node:crypto';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import { AuditRepository, MemoryRepository, createTestDatabase } from '@qmd-team-intent-kb/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type CuratorCliDeps } from '../cli.js';
import { promote } from '../promotion/promoter.js';

import { makeCandidate } from './fixtures.js';

// ---------------------------------------------------------------------------
// Scaffolding (same pattern as cli.test.ts)
// ---------------------------------------------------------------------------

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function stdoutText(): string {
  const calls = stdoutSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

function stderrText(): string {
  const calls = stderrSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

const testDeps: CuratorCliDeps = {
  createDb: () => createTestDatabase(),
};

function makePipelineResult(candidateId: string): PipelineResult {
  return { candidateId, outcome: 'approved', evaluations: [] };
}

/** Promote one candidate through the REAL promoter path into `db`. */
function promoteOne(db: ReturnType<typeof createTestDatabase>): string {
  const memoryRepo = new MemoryRepository(db);
  const auditRepo = new AuditRepository(db);
  const candidate = makeCandidate();
  const contentHash = computeContentHash(candidate.content);
  const memory = promote(
    { candidate, contentHash, pipelineResult: makePipelineResult(candidate.id) },
    memoryRepo,
    auditRepo,
  );
  return memory.id;
}

/** Plant a curated_memories row via a direct db handle — the substrate bypass.
 *  No promoter, no transaction, no 'promoted' receipt. */
function plantBypassRow(db: ReturnType<typeof createTestDatabase>): string {
  const id = randomUUID();
  const author = JSON.stringify({ type: 'human', id: 'rogue-operator' });
  db.prepare(
    `INSERT INTO curated_memories (
       id, candidate_id, source, content, title, category,
       trust_level, sensitivity, author_json, tenant_id,
       metadata_json, lifecycle, content_hash,
       policy_evaluations_json, supersession_json,
       promoted_at, promoted_by_json, updated_at, version
     ) VALUES (
       ?, ?, 'manual', 'Row inserted behind the promoter', 'Bypass row', 'reference',
       'medium', 'internal', ?, 'team-alpha',
       '{}', 'active', ?,
       '[]', NULL,
       '2026-07-19T00:00:00.000Z', ?, '2026-07-19T00:00:00.000Z', 1
     )`,
  ).run(id, randomUUID(), author, computeContentHash(`bypass-${id}`), author);
  return id;
}

// ---------------------------------------------------------------------------
// Argument / usage errors
// ---------------------------------------------------------------------------

describe('dispatch verify-corpus-accounting — argument errors', () => {
  it('exits 2 on unknown flag', async () => {
    const rc = await dispatch(['verify-corpus-accounting', '--bogus'], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/unknown flag: --bogus/);
  });

  it('exits 2 when --db is omitted (refuses the implicit in-memory store)', async () => {
    const rc = await dispatch(['verify-corpus-accounting'], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/missing required --db/);
  });

  it('lists the subcommand in help text', async () => {
    const rc = await dispatch(['help'], testDeps);
    expect(rc).toBe(0);
    expect(stdoutText()).toMatch(/verify-corpus-accounting/);
  });
});

// ---------------------------------------------------------------------------
// Clean store — every row carries its receipt
// ---------------------------------------------------------------------------

describe('dispatch verify-corpus-accounting — clean store', () => {
  it('exits 0 on a store whose only rows came through the real promoter', async () => {
    const db = createTestDatabase();
    promoteOne(db);

    const rc = await dispatch(['verify-corpus-accounting', '--db', '/ignored'], {
      createDb: () => db,
    });
    expect(rc).toBe(0);
    const out = stdoutText();
    expect(out).toMatch(/corpus accounting OK/);
    expect(out).toMatch(/Total rows:\s+1/);
    expect(out).toMatch(/Accounted rows:\s+1/);
    expect(out).toMatch(/Accepted receipt classes: promoted/);
  });

  it('exits 0 with an ok JSON envelope on an empty store', async () => {
    const rc = await dispatch(['verify-corpus-accounting', '--db', '/ignored', '--json'], testDeps);
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['totalRows']).toBe(0);
    expect(parsed['orphanCount']).toBe(0);
    expect(parsed['acceptedActions']).toEqual(['promoted']);
  });
});

// ---------------------------------------------------------------------------
// Substrate bypass — a raw INSERT behind the promoter is detected
// ---------------------------------------------------------------------------

describe('dispatch verify-corpus-accounting — substrate bypass detection', () => {
  it('reports exactly the planted orphan and exits nonzero (human output)', async () => {
    const db = createTestDatabase();
    const promotedId = promoteOne(db);
    const bypassId = plantBypassRow(db);

    const rc = await dispatch(['verify-corpus-accounting', '--db', '/ignored'], {
      createDb: () => db,
    });
    expect(rc).toBe(2);
    const err = stderrText();
    expect(err).toMatch(/CORPUS_UNACCOUNTED: 1 of 2/);
    expect(err).toContain(bypassId);
    expect(err).not.toContain(promotedId);
  });

  it('lists exactly the planted orphan in the JSON envelope', async () => {
    const db = createTestDatabase();
    const promotedId = promoteOne(db);
    const bypassId = plantBypassRow(db);

    const rc = await dispatch(['verify-corpus-accounting', '--db', '/ignored', '--json'], {
      createDb: () => db,
    });
    expect(rc).toBe(2);
    const parsed = JSON.parse(stdoutText().trim()) as {
      ok: boolean;
      totalRows: number;
      accountedRows: number;
      orphanCount: number;
      orphans: Array<{ id: string; tenantId: string }>;
      acceptedActions: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.totalRows).toBe(2);
    expect(parsed.accountedRows).toBe(1);
    expect(parsed.orphanCount).toBe(1);
    expect(parsed.orphans.map((o) => o.id)).toEqual([bypassId]);
    expect(parsed.orphans.map((o) => o.id)).not.toContain(promotedId);
    expect(parsed.acceptedActions).toEqual(['promoted']);
  });

  it('does not treat lifecycle receipts (e.g. superseded) as row-creating', async () => {
    // A bypass row that ALSO has a non-creating receipt attached must still be
    // flagged — only 'promoted' accounts for a row's existence.
    const db = createTestDatabase();
    const bypassId = plantBypassRow(db);
    new AuditRepository(db).insert({
      id: randomUUID(),
      action: 'recategorized',
      memoryId: bypassId,
      tenantId: 'team-alpha',
      actor: { type: 'human', id: 'rogue-operator' },
      reason: 'laundering attempt',
      details: {},
      timestamp: '2026-07-19T00:00:01.000Z',
    });

    const rc = await dispatch(['verify-corpus-accounting', '--db', '/ignored', '--json'], {
      createDb: () => db,
    });
    expect(rc).toBe(2);
    const parsed = JSON.parse(stdoutText().trim()) as {
      orphans: Array<{ id: string }>;
    };
    expect(parsed.orphans.map((o) => o.id)).toEqual([bypassId]);
  });
});
