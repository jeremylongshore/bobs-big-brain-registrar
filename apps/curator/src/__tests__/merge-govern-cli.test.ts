/**
 * merge-govern CLI subcommand tests (Wave-2 E3/F3).
 *
 * Drives the real dispatch path against file-backed temp stores, mirroring how
 * an operator runs it: two clone DBs (read-only evidence), one target DB (the
 * only write surface). Covers:
 *   - the full round-trip (clone A + clone B → governed union in the target,
 *     quarantine of a secret-bearing clone row, clean audit chain after);
 *   - argument/usage refusals (missing --db / --tenant, --anchor + --dry-run,
 *     --anchor without the signing key in the environment);
 *   - dry-run writes nothing;
 *   - the signed-anchor path (F3): anchor appended, Ed25519 signature verifies,
 *     parents = the two pre-merge clone chain heads, and the embedded
 *     signerPublicKey equals the keypair's public half (derivation soundness).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDatabase,
  MemoryRepository,
  AuditRepository,
  verifyAuditChain,
  generateActorKeypair,
  readSignedMergeAnchors,
  verifySignedMergeAnchors,
} from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type CuratorCliDeps } from '../cli.js';
import { promote } from '../promotion/promoter.js';
import { makeCandidate, makeCuratedMemory, TENANT } from './fixtures.js';

const KEY_ENV = 'MERGE_ANCHOR_PRIVATE_KEY_HEX';

let workDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'merge-govern-cli-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  delete process.env[KEY_ENV];
  delete process.env['MERGE_ANCHOR_LOCK_TIMEOUT_MS'];
});

function stdoutText(): string {
  const calls = stdoutSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

function stderrText(): string {
  const calls = stderrSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

/** Production-shaped factory: real file-backed SQLite per path. */
const fileDeps: CuratorCliDeps = {
  createDb: ({ dbPath, readonly }) =>
    createDatabase({ path: dbPath ?? join(workDir, 'implicit.db'), readonly: readonly ?? false }),
};

/** Promote candidates into a fresh clone store at `path` via the CANONICAL
 *  promotion path, so every row carries a content-derived id (the merge gate's
 *  entry invariant) and a receipt on the clone's own audit chain. Pass the SAME
 *  candidate object to two clones to model the same logical memory promoted on
 *  both sides (identical content-derived id → collapsed by union id-dedup). */
function buildClone(path: string, candidates: ReturnType<typeof makeCandidate>[]): void {
  const db = createDatabase({ path });
  const memoryRepo = new MemoryRepository(db);
  const auditRepo = new AuditRepository(db);
  for (const candidate of candidates) {
    promote(
      {
        candidate,
        contentHash: computeContentHash(candidate.content),
        pipelineResult: { candidateId: candidate.id, outcome: 'approved', evaluations: [] },
      },
      memoryRepo,
      auditRepo,
    );
  }
  db.close();
}

/** Shorthand: a tenant-scoped candidate around `content`. */
function cand(content: string): ReturnType<typeof makeCandidate> {
  return makeCandidate({ content, tenantId: TENANT });
}

describe('merge-govern — argument refusals', () => {
  it('exits 2 without --db (refuses an implicit in-memory target)', async () => {
    const code = await dispatch(['merge-govern', 'a.db', 'b.db', '--tenant', TENANT], fileDeps);
    expect(code).toBe(2);
    expect(stderrText()).toContain('--db');
  });

  it('exits 2 without --tenant', async () => {
    const code = await dispatch(['merge-govern', 'a.db', 'b.db', '--db', 't.db'], fileDeps);
    expect(code).toBe(2);
    expect(stderrText()).toContain('--tenant');
  });

  it('exits 2 when --anchor is combined with --dry-run', async () => {
    const code = await dispatch(
      [
        'merge-govern',
        'a.db',
        'b.db',
        '--db',
        't.db',
        '--tenant',
        TENANT,
        '--dry-run',
        '--anchor',
        'x.jsonl',
      ],
      fileDeps,
    );
    expect(code).toBe(2);
    expect(stderrText()).toContain('--anchor cannot be combined with --dry-run');
  });

  it('exits 2 when --anchor is requested without the signing key in the environment', async () => {
    delete process.env[KEY_ENV];
    const code = await dispatch(
      ['merge-govern', 'a.db', 'b.db', '--db', 't.db', '--tenant', TENANT, '--anchor', 'x.jsonl'],
      fileDeps,
    );
    expect(code).toBe(2);
    expect(stderrText()).toContain(KEY_ENV);
  });
});

describe('merge-govern — governed round-trip', () => {
  it('governs the union of two clones into the target and quarantines a secret-bearing row', async () => {
    const aPath = join(workDir, 'clone-a.db');
    const bPath = join(workDir, 'clone-b.db');
    const targetPath = join(workDir, 'merged.db');

    // The SAME candidate promoted on both clones = the same logical memory
    // (identical content-derived id) — collapsed by the union's id-dedup.
    const shared = cand('Shared note present in both clones: pin the qmd binary by SHA-256.');
    buildClone(aPath, [
      cand('Use Result types for all fallible operations in the kernel.'),
      shared,
    ]);
    buildClone(bPath, [
      shared,
      cand('Escalate production incidents to the on-call lead within ten minutes.'),
      // A leaked credential one clone admitted — the merge gate must refuse it.
      cand('Deploy uses key AKIAIOSFODNN7EXAMPLE for the S3 bucket.'),
    ]);

    const code = await dispatch(
      ['merge-govern', aPath, bPath, '--db', targetPath, '--tenant', TENANT, '--json'],
      fileDeps,
    );
    expect(code).toBe(0);

    const out = JSON.parse(stdoutText()) as {
      ok: boolean;
      union_size: number;
      promoted_count: number;
      quarantined_count: number;
      quarantined: Array<{ category: string; reason: string }>;
    };
    expect(out.ok).toBe(true);
    // 5 rows across clones; the shared note is the same logical memory (same
    // content-derived id) → union of 4.
    expect(out.union_size).toBe(4);
    expect(out.promoted_count).toBe(3);
    expect(out.quarantined_count).toBe(1);
    expect(out.quarantined[0]!.category).toBe('disclosure');

    // Durable state: 3 governed rows in the target, chain verifies clean.
    const targetDb = createDatabase({ path: targetPath, readonly: true });
    expect(new MemoryRepository(targetDb).count()).toBe(3);
    expect(verifyAuditChain(new AuditRepository(targetDb)).breaks).toHaveLength(0);
    targetDb.close();

    // Clone stores are evidence — untouched by the merge.
    for (const clonePath of [aPath, bPath]) {
      const db = createDatabase({ path: clonePath, readonly: true });
      expect(new MemoryRepository(db).count()).toBe(clonePath === aPath ? 2 : 3);
      db.close();
    }
  });

  it('--dry-run runs the gate but writes nothing to the target', async () => {
    const aPath = join(workDir, 'clone-a.db');
    const bPath = join(workDir, 'clone-b.db');
    const targetPath = join(workDir, 'merged.db');
    buildClone(aPath, [cand('A note only clone A holds about the retrieval backend.')]);
    buildClone(bPath, [cand('A note only clone B holds about the anchor log format.')]);

    const code = await dispatch(
      ['merge-govern', aPath, bPath, '--db', targetPath, '--tenant', TENANT, '--dry-run', '--json'],
      fileDeps,
    );
    expect(code).toBe(0);
    const out = JSON.parse(stdoutText()) as { dry_run: boolean; promoted_count: number };
    expect(out.dry_run).toBe(true);
    expect(out.promoted_count).toBe(2);

    const targetDb = createDatabase({ path: targetPath, readonly: true });
    expect(new MemoryRepository(targetDb).count()).toBe(0);
    targetDb.close();
  });
});

describe('merge-govern — signed merge anchor (F3)', () => {
  it('appends a verifying Ed25519 anchor whose parents are the pre-merge clone heads', async () => {
    const aPath = join(workDir, 'clone-a.db');
    const bPath = join(workDir, 'clone-b.db');
    const targetPath = join(workDir, 'merged.db');
    const anchorPath = join(workDir, 'signed-merge-anchors.jsonl');

    buildClone(aPath, [cand('Clone A note: the exporter skips confidential rows.')]);
    buildClone(bPath, [cand('Clone B note: the policy hash is pinned in CI.')]);

    // Pre-merge clone chain heads, read the same way the CLI reads them.
    const heads: string[] = [];
    for (const p of [aPath, bPath]) {
      const db = createDatabase({ path: p, readonly: true });
      const rows = new AuditRepository(db)
        .findAllChronological()
        .filter((r) => r.entry_hash !== null);
      heads.push(rows.length > 0 ? (rows[rows.length - 1]!.entry_hash ?? '') : '');
      db.close();
    }

    const keypair = generateActorKeypair();
    process.env[KEY_ENV] = keypair.privateKeyHex;

    const code = await dispatch(
      [
        'merge-govern',
        aPath,
        bPath,
        '--db',
        targetPath,
        '--tenant',
        TENANT,
        '--anchor',
        anchorPath,
        '--json',
      ],
      fileDeps,
    );
    expect(code).toBe(0);
    expect(existsSync(anchorPath)).toBe(true);

    const anchors = readSignedMergeAnchors(anchorPath);
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    // Parents bind the merged head to the two PRE-merge clone heads (a set).
    expect([...anchor.parents].sort()).toEqual([...heads].sort());
    expect(anchor.lamportClock).toBe(1);
    // The CLI derives the public key from the private half — it must equal the
    // keypair's own public half (a mismatch would break auditor comparison
    // against the committed public key).
    expect(anchor.signerPublicKey).toBe(keypair.publicKeyHex);

    // Signature + hash + log linkage + head-consistency all verify against the
    // live merged chain.
    const targetDb = createDatabase({ path: targetPath, readonly: true });
    const verify = verifySignedMergeAnchors(new AuditRepository(targetDb), anchorPath, heads);
    targetDb.close();
    expect(verify.breaks).toHaveLength(0);
    expect(verify.ok).toBe(true);

    const out = JSON.parse(stdoutText()) as {
      anchor: { verified: boolean; lamport_clock: number };
    };
    expect(out.anchor.verified).toBe(true);
    // The critical-section lock is released after a successful run.
    expect(existsSync(`${anchorPath}.lock`)).toBe(false);
  });

  it('records a valid --commit SHA in the anchor, and refuses non-SHA refs at parse time', async () => {
    const aPath = join(workDir, 'clone-a.db');
    const bPath = join(workDir, 'clone-b.db');
    const targetPath = join(workDir, 'merged.db');
    const anchorPath = join(workDir, 'signed-merge-anchors.jsonl');
    buildClone(aPath, [cand('Clone A note for the commit-pinning case.')]);
    buildClone(bPath, [cand('Clone B note for the commit-pinning case.')]);
    process.env[KEY_ENV] = generateActorKeypair().privateKeyHex;

    // Movable refs must be refused (exit 2, usage error) BEFORE any database
    // is opened — a branch name or HEAD would resolve differently over time,
    // poisoning the durable anchor record.
    for (const badRef of ['main', 'HEAD', 'feat/branch-name', 'v1.2.3']) {
      const code = await dispatch(
        // prettier-ignore
        ['merge-govern', aPath, bPath, '--db', targetPath, '--tenant', TENANT, '--anchor', anchorPath, '--commit', badRef],
        fileDeps,
      );
      expect(code).toBe(2);
      expect(stderrText()).toContain('--commit must be a 7-40 character lowercase hex commit SHA');
    }
    expect(existsSync(anchorPath)).toBe(false); // nothing anchored by refusals

    // A real 40-hex SHA is accepted and lands verbatim in the anchor record.
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const code = await dispatch(
      // prettier-ignore
      ['merge-govern', aPath, bPath, '--db', targetPath, '--tenant', TENANT, '--anchor', anchorPath, '--commit', sha],
      fileDeps,
    );
    expect(code).toBe(0);
    const anchors = readSignedMergeAnchors(anchorPath);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.commitHash).toBe(sha);
  });

  it('waits on a held anchor lock and fails loud on timeout instead of minting a duplicate clock', async () => {
    const aPath = join(workDir, 'clone-a.db');
    const bPath = join(workDir, 'clone-b.db');
    const targetPath = join(workDir, 'merged.db');
    const anchorPath = join(workDir, 'signed-merge-anchors.jsonl');
    buildClone(aPath, [cand('Clone A note for the held-lock case.')]);
    buildClone(bPath, [cand('Clone B note for the held-lock case.')]);
    process.env[KEY_ENV] = generateActorKeypair().privateKeyHex;
    process.env['MERGE_ANCHOR_LOCK_TIMEOUT_MS'] = '300';

    // A FRESH lock (another invocation mid-anchor) blocks this one: rather
    // than reading the same log tail and minting a duplicate Lamport clock,
    // the command waits, then fails loud with exit 1 and no anchor written.
    writeFileSync(`${anchorPath}.lock`, '99999\n');
    const code = await dispatch(
      // prettier-ignore
      ['merge-govern', aPath, bPath, '--db', targetPath, '--tenant', TENANT, '--anchor', anchorPath],
      fileDeps,
    );
    expect(code).toBe(1);
    expect(stderrText()).toContain('anchor lock');
    expect(existsSync(anchorPath)).toBe(false);
  });

  it('steals a STALE anchor lock (crashed holder) and completes the anchor', async () => {
    const aPath = join(workDir, 'clone-a.db');
    const bPath = join(workDir, 'clone-b.db');
    const targetPath = join(workDir, 'merged.db');
    const anchorPath = join(workDir, 'signed-merge-anchors.jsonl');
    buildClone(aPath, [cand('Clone A note for the stale-lock case.')]);
    buildClone(bPath, [cand('Clone B note for the stale-lock case.')]);
    process.env[KEY_ENV] = generateActorKeypair().privateKeyHex;

    // A lock whose mtime is far past the staleness threshold belongs to a
    // crashed holder — it is stolen and the anchor proceeds.
    const lockPath = `${anchorPath}.lock`;
    writeFileSync(lockPath, '99999\n');
    const old = (Date.now() - 10 * 60_000) / 1000; // 10 minutes ago
    utimesSync(lockPath, old, old);

    const code = await dispatch(
      // prettier-ignore
      ['merge-govern', aPath, bPath, '--db', targetPath, '--tenant', TENANT, '--anchor', anchorPath],
      fileDeps,
    );
    expect(code).toBe(0);
    expect(readSignedMergeAnchors(anchorPath)).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false); // released after the run
  });
});

describe('merge-govern — id-invariant abort path (MergeIdInvariantError)', () => {
  it('aborts the whole merge on a non-content-derived clone id: exit 1, EMPTY target, clones untouched', async () => {
    const aPath = join(workDir, 'clone-a.db');
    const bPath = join(workDir, 'clone-b.db');
    const targetPath = join(workDir, 'merged.db');

    // Clone A is clean (canonical promotion). Clone B holds one canonical row
    // PLUS one row inserted via a raw store write with a random (v4) id — the
    // signature of a row that bypassed the promoter. Its id cannot reproduce
    // under deriveMemoryId(candidateId, contentHash).
    buildClone(aPath, [cand('Clean clone A row for the abort-path case.')]);
    buildClone(bPath, [cand('Clean clone B row for the abort-path case.')]);
    const bDb = createDatabase({ path: bPath });
    new MemoryRepository(bDb).insert(
      makeCuratedMemory({ content: 'Row smuggled in with a random id.', tenantId: TENANT }),
    );
    bDb.close();

    const code = await dispatch(
      ['merge-govern', aPath, bPath, '--db', targetPath, '--tenant', TENANT],
      fileDeps,
    );

    // The gate validates the ENTIRE union before any promotion, so a single
    // bad row aborts the merge with nothing written — the runbook's
    // load-bearing safety property.
    expect(code).toBe(1);
    expect(stderrText()).toContain('not content-derived');

    // Target store is EMPTY: no memories, no audit events.
    const targetDb = createDatabase({ path: targetPath, readonly: true });
    expect(new MemoryRepository(targetDb).count()).toBe(0);
    expect(new AuditRepository(targetDb).findAllChronological()).toHaveLength(0);
    targetDb.close();

    // Clone stores are untouched evidence: A keeps 1 row, B keeps 2.
    for (const [clonePath, expected] of [
      [aPath, 1],
      [bPath, 2],
    ] as const) {
      const db = createDatabase({ path: clonePath, readonly: true });
      expect(new MemoryRepository(db).count()).toBe(expected);
      db.close();
    }
  });
});
