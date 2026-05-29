/**
 * Tests for the curator CLI (9jx).
 *
 * Per the bead description: "add one new test that runs the CLI entry
 * against a hand-crafted spool file." We exceed that minimum and cover
 * the load-bearing paths: usage errors, missing tenant, ingest success
 * end-to-end with a real in-memory database, and the --json envelope
 * shape that scripts/demo-e2e.sh consumes.
 *
 * @module __tests__/cli.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuditRepository, createTestDatabase } from '@qmd-team-intent-kb/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type CuratorCliDeps } from '../cli.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

let spoolDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  spoolDir = await mkdtemp(join(tmpdir(), 'curator-cli-test-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await rm(spoolDir, { recursive: true, force: true });
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

/** Tests use a fresh in-memory db per invocation. Production wires
 *  createDatabase against a file path; see ../main.ts. */
const testDeps: CuratorCliDeps = {
  createDb: () => createTestDatabase(),
};

/**
 * Build a spool JSONL line in the exact wire format ICO's emitter writes
 * (per the contract test at apps/curator/src/__tests__/
 * spool-intake-ico-contract.test.ts). Lets tests inject hand-crafted
 * candidates without going through the real ICO compile pipeline.
 */
function makeSpoolLine(overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      schemaVersion: '1',
      id: '1edb9e72-d5ff-5077-a329-2b44f8c61c4b',
      status: 'inbox',
      source: 'import',
      content: 'Hand-crafted candidate content for the curator CLI test.',
      title: 'Test candidate',
      category: 'reference',
      trustLevel: 'medium',
      author: { type: 'ai', id: 'ico', name: 'Intentional Cognition OS' },
      tenantId: 'demo-e2e',
      metadata: {
        filePaths: ['wiki/topics/test.md'],
        projectContext: 'cli-test',
        tags: ['test'],
      },
      prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
      capturedAt: '2026-05-29T08:00:00.000Z',
      ...overrides,
    }) + '\n'
  );
}

async function writeSpoolFile(filename: string, lines: string[]): Promise<void> {
  await writeFile(join(spoolDir, filename), lines.join(''), 'utf8');
}

// ---------------------------------------------------------------------------
// Usage / argument errors
// ---------------------------------------------------------------------------

describe('dispatch — usage errors', () => {
  it('exits 2 with usage on no subcommand', async () => {
    const rc = await dispatch([], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/missing subcommand/);
    expect(stderrText()).toMatch(/Usage:/);
  });

  it('exits 2 on unknown subcommand', async () => {
    const rc = await dispatch(['foobar'], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/unknown subcommand "foobar"/);
  });

  it.each(['help', '--help', '-h'])('prints usage on %s and exits 0', async (helpFlag) => {
    const rc = await dispatch([helpFlag], testDeps);
    expect(rc).toBe(0);
    expect(stdoutText()).toMatch(/Usage:/);
    expect(stdoutText()).toMatch(/ingest <spool-dir>/);
  });
});

describe('dispatch ingest — argument errors', () => {
  it('exits 2 when spool-dir is missing', async () => {
    const rc = await dispatch(['ingest', '--tenant', 't'], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/missing required positional argument/);
  });

  it('exits 2 when --tenant is missing', async () => {
    const rc = await dispatch(['ingest', spoolDir], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/missing required flag: --tenant/);
  });

  it('exits 2 when --tenant is empty string', async () => {
    const rc = await dispatch(['ingest', spoolDir, '--tenant', '   '], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/missing required flag: --tenant/);
  });

  it('exits 2 on unknown flag', async () => {
    const rc = await dispatch(['ingest', spoolDir, '--tenant', 't', '--bogus'], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/unknown flag: --bogus/);
  });

  it('exits 2 on extra positional argument', async () => {
    const rc = await dispatch(['ingest', spoolDir, 'extra-arg', '--tenant', 't'], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/unexpected positional argument: extra-arg/);
  });
});

// ---------------------------------------------------------------------------
// ingest end-to-end against a hand-crafted spool file (bead acceptance)
// ---------------------------------------------------------------------------

describe('dispatch ingest — hand-crafted spool file', () => {
  it('processes a one-candidate spool file end-to-end (human output)', async () => {
    await writeSpoolFile('spool-2026-05-29T080000Z.jsonl', [makeSpoolLine()]);
    const rc = await dispatch(['ingest', spoolDir, '--tenant', 'demo-e2e'], testDeps);
    expect(rc).toBe(0);
    const out = stdoutText();
    expect(out).toMatch(/Ingested 1 candidate/);
    expect(out).toMatch(/Tenant:\s+demo-e2e/);
    expect(out).toMatch(/Processed: 1/);
    // No policy is configured → curator falls through to promote on the
    // approved arm. (Curator.processSingle when policy === undefined.)
    expect(out).toMatch(/Promoted:\s+1/);
  });

  it('emits a parseable --json envelope on success', async () => {
    await writeSpoolFile('spool-2026-05-29T080000Z.jsonl', [makeSpoolLine()]);
    const rc = await dispatch(['ingest', spoolDir, '--tenant', 'demo-e2e', '--json'], testDeps);
    expect(rc).toBe(0);
    const out = stdoutText().trim();
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['spool_dir']).toBe(spoolDir);
    expect(parsed['tenant_id']).toBe('demo-e2e');
    expect(parsed['ingested_count']).toBe(1);
    const batch = parsed['batch'] as Record<string, unknown>;
    expect(batch['processed']).toBe(1);
    expect(batch['promoted']).toBe(1);
    expect(batch['rejected']).toBe(0);
    expect(Array.isArray(batch['results'])).toBe(true);
  });

  it('processes a multi-candidate spool file end-to-end', async () => {
    const cats = ['reference', 'pattern', 'architecture'];
    const lines = cats.map((category, i) =>
      makeSpoolLine({
        id: `00000000-0000-5000-8000-00000000000${i}`,
        category,
        title: `Candidate ${category}`,
        content: `Body for ${category} candidate ${i}.`,
      }),
    );
    await writeSpoolFile('spool-2026-05-29T080000Z.jsonl', lines);
    const rc = await dispatch(['ingest', spoolDir, '--tenant', 'demo-e2e', '--json'], testDeps);
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ingested_count']).toBe(cats.length);
    const batch = parsed['batch'] as Record<string, unknown>;
    expect(batch['processed']).toBe(cats.length);
    expect(batch['promoted']).toBe(cats.length);
  });

  it('handles an empty spool dir (zero candidates) cleanly', async () => {
    const rc = await dispatch(['ingest', spoolDir, '--tenant', 'demo-e2e', '--json'], testDeps);
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['ingested_count']).toBe(0);
    const batch = parsed['batch'] as Record<string, unknown>;
    expect(batch['processed']).toBe(0);
  });

  it('silently strips malformed lines per ingestFromSpool safeParse semantics', async () => {
    // Invalid line (missing tenantId) should be skipped without aborting
    // the ingest pass — matches the spool-intake contract semantics.
    const valid = makeSpoolLine();
    const invalid =
      JSON.stringify({
        schemaVersion: '1',
        id: '2edb9e72-d5ff-5077-a329-2b44f8c61c4b',
        status: 'inbox',
        content: 'no tenant id',
        title: 'no tenant',
      }) + '\n';
    await writeSpoolFile('spool-2026-05-29T080000Z.jsonl', [valid, invalid]);
    const rc = await dispatch(['ingest', spoolDir, '--tenant', 'demo-e2e', '--json'], testDeps);
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ingested_count']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// verify-audit-chain subcommand (bead gvt — wires the chain verifier
// surfaced in packages/store as a CLI-accessible primitive)
// ---------------------------------------------------------------------------

describe('dispatch verify-audit-chain', () => {
  it('exits 0 + reports clean on an empty database', async () => {
    const rc = await dispatch(['verify-audit-chain', '--json'], testDeps);
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['totalRows']).toBe(0);
    expect(parsed['breaks']).toEqual([]);
  });

  it('exits 0 on an intact chain populated by repo.insert', async () => {
    // Seed the chain via a shared db that the CLI then reads.
    const sharedDb = createTestDatabase();
    const auditRepo = new AuditRepository(sharedDb);
    for (let i = 0; i < 3; i++) {
      auditRepo.insert({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        action: 'promoted',
        memoryId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'demo-e2e',
        actor: { type: 'human', id: 'curator-1' },
        reason: `test ${i}`,
        details: {},
        timestamp: `2026-05-29T08:0${i}:00.000Z`,
      });
    }

    const rc = await dispatch(['verify-audit-chain', '--json'], {
      createDb: () => sharedDb,
    });
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['totalRows']).toBe(3);
    expect(parsed['cleanRows']).toBe(3);
    expect(parsed['breaks']).toEqual([]);
    sharedDb.close();
  });

  it('exits 2 + names the offending row on a tampered chain', async () => {
    const sharedDb = createTestDatabase();
    const auditRepo = new AuditRepository(sharedDb);
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    for (let i = 0; i < ids.length; i++) {
      auditRepo.insert({
        id: ids[i]!,
        action: 'promoted',
        memoryId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'demo-e2e',
        actor: { type: 'human', id: 'curator-1' },
        reason: `original ${i}`,
        details: {},
        timestamp: `2026-05-29T08:0${i}:00.000Z`,
      });
    }
    // Tamper row 2's content without updating its entry_hash.
    sharedDb.prepare(`UPDATE audit_events SET reason = 'TAMPERED' WHERE id = ?`).run(ids[1]);

    const rc = await dispatch(['verify-audit-chain', '--json'], {
      createDb: () => sharedDb,
    });
    expect(rc).toBe(2);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    const breaks = parsed['breaks'] as Array<Record<string, unknown>>;
    expect(breaks.length).toBe(1);
    expect(breaks[0]!['id']).toBe(ids[1]);
    expect(breaks[0]!['index']).toBe(1);
    sharedDb.close();
  });

  it('rejects unknown flags with exit 2', async () => {
    const rc = await dispatch(['verify-audit-chain', '--bogus'], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/unknown flag: --bogus/);
  });

  it('emits human-readable output when --json is absent', async () => {
    const rc = await dispatch(['verify-audit-chain'], testDeps);
    expect(rc).toBe(0);
    const out = stdoutText();
    expect(out).toMatch(/audit chain OK/);
    expect(out).toMatch(/Total rows:\s+0/);
  });
});

describe('dispatch usage — verify-audit-chain in help', () => {
  it('lists the verify-audit-chain subcommand in the help text', async () => {
    const rc = await dispatch(['help'], testDeps);
    expect(rc).toBe(0);
    expect(stdoutText()).toMatch(/verify-audit-chain/);
  });
});
