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
    // dmj.4: manifest-less spool files ingest cleanly, zero tampered.
    expect(parsed['tampered_count']).toBe(0);
    expect(parsed['tampered']).toEqual([]);
  });

  it('reports tampered_count + refuses ingest when a manifest mismatch is present (dmj.4)', async () => {
    const { createHash } = await import('node:crypto');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // Write a spool file + a manifest pinning a WRONG hash → tamper.
    const spoolName = 'spool-2026-05-30T090000Z.jsonl';
    await writeSpoolFile(spoolName, [makeSpoolLine()]);
    const wrong = createHash('sha256').update('not the real content', 'utf8').digest('hex');
    await writeFile(
      join(spoolDir, `${spoolName}.manifest.json`),
      JSON.stringify({ schemaVersion: '1', spoolFileSha256: wrong }),
      'utf8',
    );

    const rc = await dispatch(['ingest', spoolDir, '--tenant', 'demo-e2e', '--json'], testDeps);
    expect(rc).toBe(0); // ingest still "succeeds" — the tampered file is just refused
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ingested_count']).toBe(0); // refused
    expect(parsed['tampered_count']).toBe(1);
    const tampered = parsed['tampered'] as Array<Record<string, unknown>>;
    expect(tampered[0]!['spoolFile']).toContain(spoolName);
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

// ---------------------------------------------------------------------------
// generate-exception-manifest subcommand (bead compile-then-govern-e06.2;
// 010-AT-RISK R1/R2/R7). The generator pins each tamper-reason break's current
// stored tuple into a byte-pinned manifest, refusing to overwrite without
// --force.
// ---------------------------------------------------------------------------

describe('dispatch generate-exception-manifest', () => {
  /** Seed a chain, then tamper one row's content to produce a persistent break. */
  function seedTamperedDb(): {
    db: ReturnType<typeof createTestDatabase>;
    tamperedId: string;
  } {
    const db = createTestDatabase();
    const auditRepo = new AuditRepository(db);
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
    // Persistently tamper row 2 in the DB (stands in for a migration break row).
    db.prepare(`UPDATE audit_events SET reason = 'MIGRATION_ARTIFACT' WHERE id = ?`).run(ids[1]);
    return { db, tamperedId: ids[1]! };
  }

  it('exits 2 when --db is missing', async () => {
    const rc = await dispatch(['generate-exception-manifest'], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/missing required flag: --db/);
  });

  it('exits 2 on unknown flag', async () => {
    const rc = await dispatch(['generate-exception-manifest', '--db', 'x', '--bogus'], testDeps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/unknown flag: --bogus/);
  });

  it('lists the subcommand in help text', async () => {
    const rc = await dispatch(['help'], testDeps);
    expect(rc).toBe(0);
    expect(stdoutText()).toMatch(/generate-exception-manifest/);
  });

  it('pins the current tuple of every tamper break and round-trips through readManifest', async () => {
    const { db, tamperedId } = seedTamperedDb();
    const outPath = join(spoolDir, 'exceptions.manifest.json');

    // The CLI closes the db it was handed in its finally block, so we do the
    // downstream classify against a FRESH identical db (v2 hashes are
    // timestamp-independent and ids are fixed, so the two DBs are byte-equal).
    const rc = await dispatch(
      ['generate-exception-manifest', '--db', '/ignored', '--out', outPath, '--json'],
      { createDb: () => db },
    );
    expect(rc).toBe(0);

    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['entryCount']).toBe(1);
    expect(typeof parsed['manifestHash']).toBe('string');
    const breakdown = parsed['reasonBreakdown'] as Record<string, number>;
    expect(breakdown['ENTRY_HASH_MISMATCH']).toBe(1);

    // The written manifest loads + verifies (count-assert + hash re-check).
    const { readManifest, verifyAuditChain, classifyChainBreaks } =
      await import('@qmd-team-intent-kb/store');
    const manifest = readManifest(outPath);
    expect(manifest.entryCount).toBe(1);
    expect(manifest.entries[0]!.id).toBe(tamperedId);

    // And the manifest classifies the (byte-identical) live break as a
    // documented exception — proving the generated manifest COVERS the break it
    // was made for.
    const fresh = seedTamperedDb();
    const auditRepo = new AuditRepository(fresh.db);
    const { breaks } = verifyAuditChain(auditRepo);
    const rows = auditRepo.findAllChronological() as unknown as Array<{
      id: string;
      entry_hash: string | null;
      prev_entry_hash: string | null;
      hash_version: number | null;
      seq: number | null;
    }>;
    const rowsById = new Map(
      rows.map((r) => [
        r.id,
        {
          entry_hash: r.entry_hash,
          prev_entry_hash: r.prev_entry_hash,
          hash_version: r.hash_version ?? 1,
          seq: r.seq ?? 0,
        },
      ]),
    );
    const classified = classifyChainBreaks(breaks, manifest, rowsById);
    expect(classified.documentedExceptions.map((b) => b.id)).toEqual([tamperedId]);
    expect(classified.tamperSignatures).toHaveLength(0);
    expect(classified.verified).toBe(true);
    fresh.db.close();
  });

  it('refuses to overwrite an existing manifest without --force', async () => {
    const { db } = seedTamperedDb();
    const outPath = join(spoolDir, 'exceptions.manifest.json');
    // Pre-create the file.
    await writeFile(outPath, '{}', 'utf8');

    const rc = await dispatch(
      ['generate-exception-manifest', '--db', '/ignored', '--out', outPath, '--json'],
      { createDb: () => db },
    );
    expect(rc).toBe(1);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    expect(parsed['code']).toBe('MANIFEST_EXISTS');
    db.close();
  });

  it('overwrites an existing manifest WITH --force', async () => {
    const { db } = seedTamperedDb();
    const outPath = join(spoolDir, 'exceptions.manifest.json');
    await writeFile(outPath, '{}', 'utf8');

    const rc = await dispatch(
      ['generate-exception-manifest', '--db', '/ignored', '--out', outPath, '--force', '--json'],
      { createDb: () => db },
    );
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['entryCount']).toBe(1);
    db.close();
  });
});
