/**
 * Governed redaction (Epic K bead K3, expanded scope): the `redactMemory`
 * service and `curator-cli redact`, end to end on a FILE-backed SQLite store.
 *
 * The store is seeded the way the 2026-10-04 incident happened: a candidate
 * whose text carries a secret is in `candidates`, was promoted through the real
 * promoter (so it has a content-derived id and a `promoted` receipt), and other
 * governance activity surrounds it on the audit chain.
 *
 * Every secret-shaped value is SYNTHETIC and assembled from parts.
 *
 * @module __tests__/redact-memory.test
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { computeContentHash, deriveCandidateId, deriveMemoryId } from '@qmd-team-intent-kb/common';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  RedactedContentReingestError,
  createDatabase,
  createTestDatabase,
  storeFilesOf,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type CuratorCliDeps } from '../cli.js';
import { Curator } from '../curator.js';
import { promote } from '../promotion/promoter.js';
import { walkProvenance } from '../provenance/provenance-walk.js';
import { lineRangesToSpans } from '../redaction/redact-cli.js';
import { redactMemory, REDACTION_MARKER } from '../redaction/redact-memory.js';
import { makeCandidate, TENANT } from './fixtures.js';

// --- Synthetic secrets -----------------------------------------------------

/** A value no scan pattern recognizes on its own: stated in a sentence, like the incident. */
const PROSE_SECRET = 'zq' + 'Synth' + 'Harbor' + '7H2kQ9vX4mB8';
/** A value the deterministic scan DOES recognize (env-style assignment). */
const ENV_SECRET_VALUE = 'zq' + 'Synth' + 'Lantern' + '3Kd8Wp1Zr6Ty';
const ENV_SECRET = 'SERVICE_' + 'PASSWORD=' + ENV_SECRET_VALUE;

const PROSE_CONTENT = [
  '## Credential migration',
  '',
  'The migration to the new admin account is complete.',
  `The account passphrase we set is ${PROSE_SECRET} for now.`,
  'Rotate it after the cutover window closes.',
].join('\n');

const ENV_CONTENT = [
  '## Service bootstrap',
  '',
  'Export the following before starting the worker:',
  ENV_SECRET,
  'Then run the bootstrap script from the repo root.',
].join('\n');

const REPLACEMENT =
  '[REDACTED 2026-10-04] This memory held plaintext credentials. The content was removed by a governed redaction and the credentials were rotated.';

const SECRETS = [PROSE_SECRET, ENV_SECRET_VALUE];

// --- Scaffolding -----------------------------------------------------------

let dir: string;
let dbPath: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let createDb: ReturnType<typeof vi.fn<CuratorCliDeps['createDb']>>;
let deps: CuratorCliDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'redact-memory-'));
  dbPath = join(dir, 'teamkb.db');
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  createDb = vi.fn<CuratorCliDeps['createDb']>(({ dbPath: p, readonly }) =>
    p !== undefined
      ? createDatabase({ path: p, readonly: readonly ?? false })
      : createTestDatabase(),
  );
  deps = { createDb };
});

afterEach(() => {
  // No run of any test may have printed a synthetic secret.
  const printed = allOutput();
  for (const secret of SECRETS) expect(printed).not.toContain(secret);
  rmSync(dir, { recursive: true, force: true });
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

const text = (spy: ReturnType<typeof vi.spyOn>): string =>
  (spy.mock.calls as unknown as Array<[unknown]>).map((c) => String(c[0])).join('');
const stdoutText = (): string => text(stdoutSpy);
const stderrText = (): string => text(stderrSpy);
const allOutput = (): string => stdoutText() + stderrText();
function lastJson<T>(): T {
  const lines = stdoutText().trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as T;
}

const approved = (candidateId: string): PipelineResult => ({
  candidateId,
  outcome: 'approved',
  evaluations: [],
});

/**
 * Write a candidate row directly, bypassing the insert-time disclosure gate —
 * this is the incident shape: text admitted BEFORE a pattern recognized it.
 */
function insertLegacyCandidate(db: Database.Database, candidate: MemoryCandidate): void {
  db.prepare(
    `INSERT INTO candidates (id, status, source, content, title, category, trust_level,
       author_json, tenant_id, metadata_json, pre_policy_flags_json, content_hash, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    candidate.id,
    'promoted',
    candidate.source,
    candidate.content,
    candidate.title,
    candidate.category,
    candidate.trustLevel,
    JSON.stringify(candidate.author),
    candidate.tenantId,
    JSON.stringify(candidate.metadata),
    JSON.stringify(candidate.prePolicyFlags),
    computeContentHash(candidate.content),
    candidate.capturedAt,
  );
}

interface Seeded {
  memoryId: string;
  candidateId: string;
  oldHash: string;
}

/** Seed a promoted memory holding `content`, with neighbours on the audit chain. */
function seed(content: string, overrides: Record<string, unknown> = {}): Seeded {
  const db = createDatabase({ path: dbPath });
  try {
    const memories = new MemoryRepository(db);
    const audit = new AuditRepository(db);
    const candidates = new CandidateRepository(db);

    // Neighbours first, so the chain has history before the leaked memory.
    for (let i = 0; i < 3; i++) {
      const neighbour = makeCandidate({
        content:
          `An ordinary convention number ${i} that sits before the leak on the chain. `.repeat(20),
        title: `Ordinary convention ${i}`,
      });
      candidates.insert(neighbour, computeContentHash(neighbour.content));
      promote(
        {
          candidate: neighbour,
          contentHash: computeContentHash(neighbour.content),
          pipelineResult: approved(neighbour.id),
        },
        memories,
        audit,
      );
    }

    const candidate = makeCandidate({
      content,
      title: 'Complete credential migration',
      ...overrides,
    });
    insertLegacyCandidate(db, candidate);
    const oldHash = computeContentHash(candidate.content);
    const memory = promote(
      { candidate, contentHash: oldHash, pipelineResult: approved(candidate.id) },
      memories,
      audit,
    );

    // …and one after it.
    const later = makeCandidate({
      content: 'A later, unrelated decision recorded after the leak.',
    });
    candidates.insert(later, computeContentHash(later.content));
    promote(
      {
        candidate: later,
        contentHash: computeContentHash(later.content),
        pipelineResult: approved(later.id),
      },
      memories,
      audit,
    );
    return { memoryId: memory.id, candidateId: candidate.id, oldHash };
  } finally {
    db.close();
  }
}

function open<T>(fn: (db: Database.Database) => T, readonly = true): T {
  const db = createDatabase({ path: dbPath, readonly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Every text value in every table (and FTS shadow table) of the store, joined. */
function dumpAllTables(db: Database.Database): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const parts: string[] = [];
  for (const { name } of tables) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all() as Array<
      Record<string, unknown>
    >) {
      for (const value of Object.values(row)) {
        parts.push(Buffer.isBuffer(value) ? value.toString('latin1') : String(value));
      }
    }
  }
  return parts.join('\n');
}

const bytesContain = (needle: string): boolean =>
  storeFilesOf(dbPath).some(
    (file) => existsSync(file) && readFileSync(file).includes(Buffer.from(needle, 'utf8')),
  );

const fileSha = (): string => createHash('sha256').update(readFileSync(dbPath)).digest('hex');

/** Audit rows as stored, for a byte-for-byte before/after comparison. */
const chainRows = (db: Database.Database): string[] =>
  new AuditRepository(db).findAllChronological().map((r) => JSON.stringify(r));

function cli(memoryId: string, ...rest: string[]): string[] {
  return [
    'redact',
    '--db',
    dbPath,
    '--tenant',
    TENANT,
    '--memory-id',
    memoryId,
    '--actor',
    'jeremy',
    '--reason',
    'plaintext credentials promoted on 2026-10-04',
    ...rest,
  ];
}

interface RedactJson {
  ok: boolean;
  dry_run: boolean;
  status: string;
  code?: string;
  error?: string;
  old_content_hash: string;
  new_content_hash: string;
  pattern_names: string[];
  candidate_ids: string[];
  audit_event_ids: string[];
  next_steps: string[];
  physical_scrub: null | {
    complete: boolean;
    fts_rebuilt: boolean;
    wal_truncated: boolean;
    vacuumed: boolean;
    secure_delete: boolean;
    errors: string[];
    fragments_checked: number;
    residual_fragments: number;
    unexplained_residual_fragments: number;
    rows_still_containing_removed_text: Array<{ table: string; id: string }>;
  };
}

// --- The redaction itself --------------------------------------------------

describe('curator-cli redact — replacement text (the incident shape)', () => {
  it('replaces the content everywhere, receipts it, and the old text is gone', async () => {
    const seeded = seed(PROSE_CONTENT);
    const before = open((db) => ({
      rows: chainRows(db),
      verify: verifyAuditChain(new AuditRepository(db)),
    }));
    expect(before.verify.breaks).toEqual([]);
    expect(bytesContain(PROSE_SECRET)).toBe(true);

    const rc = await dispatch(
      cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--json'),
      deps,
    );
    expect(rc).toBe(0);
    const out = lastJson<RedactJson>();
    expect(out).toMatchObject({
      ok: true,
      dry_run: false,
      status: 'redacted',
      old_content_hash: seeded.oldHash,
      new_content_hash: computeContentHash(REPLACEMENT),
      candidate_ids: [seeded.candidateId],
    });
    expect(out.audit_event_ids).toHaveLength(2);
    expect(out.next_steps.join(' ')).toMatch(/Rotate the credential/);
    expect(out.next_steps.join(' ')).toMatch(/backup/);
    expect(out.physical_scrub).toMatchObject({
      complete: true,
      secure_delete: true,
      fts_rebuilt: true,
      wal_truncated: true,
      vacuumed: true,
      errors: [],
      residual_fragments: 0,
      unexplained_residual_fragments: 0,
    });
    expect(out.physical_scrub!.fragments_checked).toBeGreaterThan(0);

    open((db) => {
      const memories = new MemoryRepository(db);
      const audit = new AuditRepository(db);
      const candidates = new CandidateRepository(db);

      // The memory: same id, new content, recomputed hash, bumped version.
      const memory = memories.findById(seeded.memoryId)!;
      expect(memory.content).toBe(REPLACEMENT);
      expect(memory.contentHash).toBe(computeContentHash(REPLACEMENT));
      expect(memory.version).toBe(2);
      expect(memory.candidateId).toBe(seeded.candidateId);

      // The candidate copy is redacted too, with a matching stored hash.
      expect(candidates.findById(seeded.candidateId)!.content).toBe(REPLACEMENT);
      expect(
        candidates.findByContentHashAndTenant(computeContentHash(REPLACEMENT), TENANT)?.id,
      ).toBe(seeded.candidateId);

      // The chain: every earlier row is byte-identical, and it still verifies.
      const after = chainRows(db);
      expect(after.slice(0, before.rows.length)).toEqual(before.rows);
      expect(after).toHaveLength(before.rows.length + 2);
      const verify = verifyAuditChain(audit);
      expect(verify.breaks).toEqual([]);
      expect(verify.cleanRows).toBe(before.verify.cleanRows + 2);

      // The receipts: forward-chained, hashes and names only.
      const [memoryReceipt] = audit.findRedactionsFor(seeded.memoryId);
      expect(memoryReceipt).toMatchObject({
        target: 'memory',
        oldContentHash: seeded.oldHash,
        newContentHash: computeContentHash(REPLACEMENT),
      });
      const event = audit.findByMemory(seeded.memoryId).find((e) => e.action === 'redacted')!;
      expect(event.actor).toEqual({ type: 'human', id: 'jeremy' });
      expect(event.reason).toBe('plaintext credentials promoted on 2026-10-04');
      expect(event.details).toMatchObject({
        target: 'memory',
        mode: 'replacement',
        candidateIds: [seeded.candidateId],
        titleChanged: false,
      });
      expect(audit.findRedactionsFor(seeded.candidateId)[0]).toMatchObject({
        target: 'candidate',
        oldContentHash: seeded.oldHash,
      });
      const tip = audit.findChainTip()!;
      expect(tip.sequence).toBe(before.rows.length + 2);

      // Old text: in no table, no FTS shadow table, no receipt.
      const dump = dumpAllTables(db);
      expect(dump).not.toContain(PROSE_SECRET);
      expect(dump).not.toContain('account passphrase we set');
      expect(memories.searchByText('passphrase')).toEqual([]);
    });

    // …and in no byte of the database, WAL or shm file.
    expect(bytesContain(PROSE_SECRET)).toBe(false);
    expect(bytesContain('account passphrase we set')).toBe(false);
  });

  it('is idempotent: a second identical run writes nothing', async () => {
    const seeded = seed(PROSE_CONTENT);
    expect(await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT), deps)).toBe(0);
    const after1 = open((db) => chainRows(db));

    expect(
      await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--json'), deps),
    ).toBe(0);
    const out = lastJson<RedactJson>();
    expect(out).toMatchObject({
      ok: true,
      status: 'unchanged',
      audit_event_ids: [],
      candidate_ids: [],
    });
    expect(open((db) => chainRows(db))).toEqual(after1);
    open((db) => {
      expect(new MemoryRepository(db).findById(seeded.memoryId)!.version).toBe(2);
      expect(new AuditRepository(db).findRedactionsFor(seeded.memoryId)).toHaveLength(1);
    });
  });

  it('prints a human summary with the operator steps and no content', async () => {
    const seeded = seed(PROSE_CONTENT);
    expect(
      await dispatch(cli(seeded.memoryId, '--replacement-file', writeTemp(REPLACEMENT)), deps),
    ).toBe(0);
    const out = stdoutText();
    expect(out).toContain('redact: redacted');
    expect(out).toContain(`Old hash:      ${seeded.oldHash}`);
    expect(out).toContain('Physical scrub: complete');
    expect(out).toContain('Still to do:');
    expect(out).toContain('Rotate the credential');
    expect(out).toContain('reconcile');
    expect(out).toContain('Reindex');
    expect(out).toContain('(none recognized by the scan)');
    expect(out).not.toContain('content line(s)');
    expect(out).not.toContain('Credential migration');
  });

  it('--show-title prints the title for target confirmation, and only then', async () => {
    const seeded = seed(PROSE_CONTENT);
    const dry = ['--replacement-text', REPLACEMENT, '--dry-run'];
    await dispatch(cli(seeded.memoryId, ...dry), deps);
    expect(stdoutText()).not.toContain('Complete credential migration');

    await dispatch(cli(seeded.memoryId, ...dry, '--show-title'), deps);
    expect(stdoutText()).toContain('Title:         Complete credential migration');
    await dispatch(cli(seeded.memoryId, ...dry, '--show-title', '--json'), deps);
    expect(lastJson<{ title: string }>().title).toBe('Complete credential migration');
  });

  it('--show-title withholds a title the scan fires on or that is being replaced', async () => {
    const flagged = seed(PROSE_CONTENT, { title: `Bootstrap ${ENV_SECRET}` });
    // Scan mode redacts the title too; the title the scan fired on is never shown.
    await dispatch(cli(flagged.memoryId, '--scan', '--dry-run', '--show-title'), deps);
    expect(stdoutText()).toContain('Title:         (withheld)');
    expect(stdoutText()).toContain('Title changed: true');

    await dispatch(
      cli(
        flagged.memoryId,
        '--replacement-text',
        REPLACEMENT,
        '--replacement-title',
        'Bootstrap (redacted)',
        '--dry-run',
        '--show-title',
        '--json',
      ),
      deps,
    );
    expect(lastJson<{ title: string }>().title).toBe('(withheld)');
  });

  it('also replaces a title that holds the secret', async () => {
    const seeded = seed(PROSE_CONTENT, { title: `Passphrase ${PROSE_SECRET} for the admin box` });
    const rc = await dispatch(
      cli(
        seeded.memoryId,
        '--replacement-text',
        REPLACEMENT,
        '--replacement-title',
        'Credential migration (redacted)',
        '--json',
      ),
      deps,
    );
    expect(rc).toBe(0);
    open((db) => {
      expect(new MemoryRepository(db).findById(seeded.memoryId)!.title).toBe(
        'Credential migration (redacted)',
      );
      expect(new CandidateRepository(db).findById(seeded.candidateId)!.title).toBe(
        'Credential migration (redacted)',
      );
      expect(dumpAllTables(db)).not.toContain(PROSE_SECRET);
    });
    expect(bytesContain(PROSE_SECRET)).toBe(false);
  });
});

function writeTemp(content: string): string {
  const path = join(dir, `replacement-${randomUUID()}.txt`);
  writeFileSync(path, content);
  return path;
}

describe('curator-cli redact — scan mode', () => {
  it('removes what the deterministic scan recognizes and names the pattern', async () => {
    const seeded = seed(ENV_CONTENT);
    const rc = await dispatch(cli(seeded.memoryId, '--scan', '--json'), deps);
    expect(rc).toBe(0);
    const out = lastJson<RedactJson>();
    expect(out.status).toBe('redacted');
    expect(out.pattern_names).toContain('Environment Variable Secret');
    expect((out as RedactJson & { pattern_lines: Record<string, number[]> }).pattern_lines).toEqual(
      {
        'Environment Variable Secret': [4],
      },
    );
    expect(out.physical_scrub).toMatchObject({ complete: true, unexplained_residual_fragments: 0 });

    open((db) => {
      const memory = new MemoryRepository(db).findById(seeded.memoryId)!;
      expect(memory.content).toContain('[REDACTED:env-secret]');
      expect(memory.content).toContain('Then run the bootstrap script from the repo root.');
      expect(memory.content).not.toContain(ENV_SECRET_VALUE);
      const event = new AuditRepository(db)
        .findByMemory(seeded.memoryId)
        .find((e) => e.action === 'redacted')!;
      expect(event.details).toMatchObject({ mode: 'scan' });
      expect(event.details['patternNames']).toContain('Environment Variable Secret');
      expect(event.details['patternIds']).toContain('env-secret');
      expect(JSON.stringify(event)).not.toContain(ENV_SECRET_VALUE);
      expect(dumpAllTables(db)).not.toContain(ENV_SECRET_VALUE);
    });
    expect(bytesContain(ENV_SECRET_VALUE)).toBe(false);
  });

  it('removes a password stated in prose — the 2026-10-04 incident shape', async () => {
    const value = 'zq' + 'Synth' + 'Anchor' + '6Fg2Hs9Lp4Wn';
    const content = [
      '## Credential migration',
      '',
      'The migration to the new admin account is complete.',
      'The sudo password for the migration box is `' + value + '` until Friday.',
    ].join('\n');
    const seeded = seed(content);

    const rc = await dispatch(cli(seeded.memoryId, '--scan', '--json'), deps);
    expect(rc).toBe(0);
    const out = lastJson<RedactJson & { pattern_lines: Record<string, number[]> }>();
    expect(out.status).toBe('redacted');
    expect(out.pattern_names).toContain('Password Stated in Prose');
    // Where it fired is reported as a line number, never as text.
    expect(out.pattern_lines['Password Stated in Prose']).toEqual([4]);
    open((db) => {
      const memory = new MemoryRepository(db).findById(seeded.memoryId)!;
      expect(memory.content).toContain('[REDACTED:prose-password]');
      expect(memory.content).toContain('The migration to the new admin account is complete.');
      expect(dumpAllTables(db)).not.toContain(value);
    });
    expect(bytesContain(value)).toBe(false);
    expect(allOutput()).not.toContain(value);
  });

  it('a second scan run on an already-redacted memory is an idempotent no-op', async () => {
    const seeded = seed(ENV_CONTENT);
    expect(await dispatch(cli(seeded.memoryId, '--scan'), deps)).toBe(0);
    expect(await dispatch(cli(seeded.memoryId, '--scan', '--json'), deps)).toBe(0);
    expect(lastJson<RedactJson>().status).toBe('unchanged');
    open((db) =>
      expect(new AuditRepository(db).findRedactionsFor(seeded.memoryId)).toHaveLength(1),
    );
  });

  it('refuses when the scan finds nothing — a scan miss is not a clean bill', async () => {
    const seeded = seed('A perfectly ordinary note about how the build cache is laid out.');
    const before = fileSha();
    const rc = await dispatch(cli(seeded.memoryId, '--scan', '--json'), deps);
    expect(rc).toBe(3);
    expect(lastJson<RedactJson>()).toMatchObject({
      ok: false,
      status: 'refused',
      code: 'nothing_to_redact',
    });
    open((db) => expect(new AuditRepository(db).findByAction('redacted')).toEqual([]));
    expect(before).toBeDefined();
  });

  it('refuses when a secret still fires after the scan-mode rewrite', async () => {
    // A key split across a newline: the scan's collapsed view sees it, but the
    // redactor cannot remove it. Success here would be a false claim.
    const split = [
      'The key is AKIA' + 'IOSF',
      'ODNN7' + 'EXAMPLE and it is used by the uploader.',
    ].join('\n');
    const seeded = seed(split);
    const rc = await dispatch(cli(seeded.memoryId, '--scan', '--json'), deps);
    expect(rc).toBe(3);
    const out = lastJson<RedactJson>();
    expect(out).toMatchObject({ ok: false, code: 'residual_secret' });
    expect(out.error).toContain('AWS Access Key');
    expect(out.error).toContain('Nothing was written');
    open((db) => {
      expect(new MemoryRepository(db).findById(seeded.memoryId)!.content).toBe(split);
      expect(new AuditRepository(db).findByAction('redacted')).toEqual([]);
    });
  });
});

describe('curator-cli redact — caller-supplied lines', () => {
  it('replaces the named lines and keeps the rest', async () => {
    const seeded = seed(PROSE_CONTENT);
    const rc = await dispatch(cli(seeded.memoryId, '--lines', '4', '--json'), deps);
    expect(rc).toBe(0);
    expect(lastJson<RedactJson>().physical_scrub).toMatchObject({ complete: true });
    open((db) => {
      const memory = new MemoryRepository(db).findById(seeded.memoryId)!;
      expect(memory.content.split('\n')).toEqual([
        '## Credential migration',
        '',
        'The migration to the new admin account is complete.',
        REDACTION_MARKER,
        'Rotate it after the cutover window closes.',
      ]);
      expect(dumpAllTables(db)).not.toContain(PROSE_SECRET);
    });
    expect(bytesContain(PROSE_SECRET)).toBe(false);
  });

  it.each([
    ['2', 'line 2 is empty'],
    ['9', 'past the end of the content'],
    ['0', 'not a valid 1-based range'],
    ['4-3', 'not a valid 1-based range'],
    ['abc', 'is not N or N-M'],
  ])('rejects --lines %s as a usage error', async (ranges, message) => {
    const seeded = seed(PROSE_CONTENT);
    expect(await dispatch(cli(seeded.memoryId, '--lines', ranges), deps)).toBe(2);
    expect(stderrText()).toContain(message);
    open((db) => expect(new AuditRepository(db).findByAction('redacted')).toEqual([]));
  });

  it('lineRangesToSpans maps ranges to exact character spans', () => {
    const content = 'alpha\nbravo\ncharlie';
    const result = lineRangesToSpans(content, '1, 2-3');
    expect(result).toEqual({
      ok: true,
      spans: [
        { start: 0, end: 5 },
        { start: 6, end: 11 },
        { start: 12, end: 19 },
      ],
    });
    expect(lineRangesToSpans(content, '1-200000')).toMatchObject({ ok: false });
  });
});

// --- Dry-run ---------------------------------------------------------------

describe('curator-cli redact — dry-run', () => {
  it('opens the store read-only, reports the plan and writes nothing', async () => {
    const seeded = seed(PROSE_CONTENT);
    const before = fileSha();
    const rc = await dispatch(
      cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--dry-run', '--json'),
      deps,
    );
    expect(rc).toBe(0);
    expect(createDb).toHaveBeenCalledWith({ dbPath, readonly: true });
    const out = lastJson<RedactJson>();
    expect(out).toMatchObject({
      ok: true,
      dry_run: true,
      status: 'would_redact',
      old_content_hash: seeded.oldHash,
      new_content_hash: computeContentHash(REPLACEMENT),
      candidate_ids: [seeded.candidateId],
      audit_event_ids: [],
      physical_scrub: null,
      next_steps: [],
    });
    expect(fileSha()).toBe(before);
    open((db) => {
      expect(new MemoryRepository(db).findById(seeded.memoryId)!.content).toBe(PROSE_CONTENT);
      expect(new AuditRepository(db).findByAction('redacted')).toEqual([]);
    });
  });

  it('a dry-run refusal is still a refusal', async () => {
    const seeded = seed(PROSE_CONTENT);
    const rc = await dispatch(cli(seeded.memoryId, '--scan', '--dry-run'), deps);
    expect(rc).toBe(3);
    expect(stdoutText()).toContain('redact refused [nothing_to_redact]');
  });

  it('prints a dry-run headline in text mode', async () => {
    const seeded = seed(PROSE_CONTENT);
    await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--dry-run'), deps);
    expect(stdoutText()).toContain('dry-run — nothing written');
    expect(stdoutText()).not.toContain('Still to do');
  });
});

// --- Refusals --------------------------------------------------------------

describe('redaction refusals', () => {
  it('refuses an unknown id and a memory in another tenant, identically', async () => {
    const seeded = seed(PROSE_CONTENT);
    expect(
      await dispatch(cli(randomUUID(), '--replacement-text', REPLACEMENT, '--json'), deps),
    ).toBe(3);
    expect(lastJson<RedactJson>()).toMatchObject({ ok: false, code: 'not_found' });

    const otherTenant = cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--json');
    otherTenant[4] = 'some-other-tenant';
    expect(await dispatch(otherTenant, deps)).toBe(3);
    expect(lastJson<RedactJson>()).toMatchObject({ ok: false, code: 'not_found' });
    open((db) =>
      expect(new MemoryRepository(db).findById(seeded.memoryId)!.content).toBe(PROSE_CONTENT),
    );
  });

  it('reveals nothing about a memory in another tenant, even with --lines', async () => {
    const seeded = seed(PROSE_CONTENT);
    const args = cli(seeded.memoryId, '--lines', '99', '--show-title', '--json');
    args[4] = 'some-other-tenant';
    // Line 99 does not exist — but that must not be reported for a foreign row.
    expect(await dispatch(args, deps)).toBe(3);
    expect(lastJson<RedactJson>()).toMatchObject({ ok: false, code: 'not_found' });
    expect(allOutput()).not.toContain('past the end');
    expect(allOutput()).not.toContain('Complete credential migration');
  });

  it('records the stored hash when it had already drifted from the content', () => {
    const seeded = seed(PROSE_CONTENT);
    open((db) => {
      db.prepare('UPDATE curated_memories SET content_hash = ? WHERE id = ?').run(
        'e'.repeat(64),
        seeded.memoryId,
      );
      const auditRepo = new AuditRepository(db);
      const { result } = redactMemory(
        {
          memoryId: seeded.memoryId,
          tenantId: TENANT,
          actor: 'jeremy',
          reason: 'r',
          mode: { kind: 'replacement', content: REPLACEMENT },
        },
        {
          memoryRepo: new MemoryRepository(db),
          candidateRepo: new CandidateRepository(db),
          auditRepo,
        },
      );
      // The receipt's old hash is the hash of the old TEXT (what dedup matches)…
      expect(result).toMatchObject({ ok: true, oldContentHash: seeded.oldHash });
      const event = auditRepo.findByMemory(seeded.memoryId).find((e) => e.action === 'redacted')!;
      // …and the drifted stored value is kept alongside it.
      expect(event.details['storedContentHash']).toBe('e'.repeat(64));
      expect(auditRepo.findRedactionByOldContentHash(seeded.oldHash, TENANT)).not.toBeNull();
    }, false);
  });

  it('refuses a missing reason, actor, db or mode as usage errors', async () => {
    const base = ['redact', '--db', dbPath, '--tenant', TENANT, '--memory-id', randomUUID()];
    const run = async (...rest: string[]): Promise<number> => dispatch([...base, ...rest], deps);
    expect(await run('--actor', 'j', '--scan')).toBe(2);
    expect(stderrText()).toContain('missing required flag: --reason');
    expect(await run('--reason', 'r', '--scan')).toBe(2);
    expect(stderrText()).toContain('missing required flag: --actor');
    expect(await run('--actor', 'j', '--reason', '   ', '--scan')).toBe(2);
    expect(await run('--actor', 'j', '--reason', 'r')).toBe(2);
    expect(stderrText()).toContain('exactly one of --replacement-text');
    expect(await run('--actor', 'j', '--reason', 'r', '--scan', '--lines', '1')).toBe(2);
    expect(
      await dispatch(
        [
          'redact',
          '--tenant',
          TENANT,
          '--memory-id',
          'x',
          '--actor',
          'j',
          '--reason',
          'r',
          '--scan',
        ],
        deps,
      ),
    ).toBe(2);
    expect(stderrText()).toContain('missing required flag: --db');
    expect(
      await run('--actor', 'j', '--reason', 'r', '--replacement-file', join(dir, 'missing.txt')),
    ).toBe(2);
    expect(stderrText()).toContain('cannot read --replacement-file');
  });

  it('refuses a reason that quotes a secret — the reason is written to the receipt', async () => {
    const seeded = seed(PROSE_CONTENT);
    const args = cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--json');
    args[args.indexOf('--reason') + 1] = `removing ${ENV_SECRET}`;
    expect(await dispatch(args, deps)).toBe(3);
    expect(lastJson<RedactJson>()).toMatchObject({ ok: false, code: 'secret_in_reason' });
    open((db) => expect(new AuditRepository(db).findByAction('redacted')).toEqual([]));
  });

  it('refuses replacement text that itself carries a secret or PII', async () => {
    const seeded = seed(PROSE_CONTENT);
    expect(
      await dispatch(
        cli(seeded.memoryId, '--replacement-text', `rotated; new value ${ENV_SECRET}`, '--json'),
        deps,
      ),
    ).toBe(3);
    expect(lastJson<RedactJson>()).toMatchObject({ ok: false, code: 'residual_secret' });

    expect(
      await dispatch(
        cli(
          seeded.memoryId,
          '--replacement-text',
          'Removed. Her SSN is 078-05-1120 per the form.',
          '--json',
        ),
        deps,
      ),
    ).toBe(3);
    expect(lastJson<RedactJson>().ok).toBe(false);

    expect(await dispatch(cli(seeded.memoryId, '--replacement-text', '   ', '--json'), deps)).toBe(
      3,
    );
    expect(lastJson<RedactJson>()).toMatchObject({ code: 'empty_replacement' });

    open((db) => {
      expect(new MemoryRepository(db).findById(seeded.memoryId)!.content).toBe(PROSE_CONTENT);
      expect(new AuditRepository(db).findByAction('redacted')).toEqual([]);
    });
  });

  it('service: blank reason / actor, bad spans and an empty title are refusals', () => {
    const seeded = seed(PROSE_CONTENT);
    open((db) => {
      const repos = {
        memoryRepo: new MemoryRepository(db),
        candidateRepo: new CandidateRepository(db),
        auditRepo: new AuditRepository(db),
      };
      const base = {
        memoryId: seeded.memoryId,
        tenantId: TENANT,
        actor: 'jeremy',
        reason: 'r',
        mode: { kind: 'replacement' as const, content: REPLACEMENT },
      };
      const code = (input: Parameters<typeof redactMemory>[0]): string | undefined => {
        const { result, removedFragments } = redactMemory(input, repos);
        expect(removedFragments).toEqual([]);
        return result.ok ? undefined : result.code;
      };
      expect(code({ ...base, reason: ' ' })).toBe('missing_reason');
      expect(code({ ...base, actor: '' })).toBe('missing_actor');
      expect(code({ ...base, replacementTitle: '  ' })).toBe('empty_replacement');
      const spans = (s: Array<{ start: number; end: number }>) =>
        code({ ...base, mode: { kind: 'spans', spans: s } });
      expect(spans([])).toBe('invalid_spans');
      expect(spans([{ start: 5, end: 5 }])).toBe('invalid_spans');
      expect(spans([{ start: -1, end: 3 }])).toBe('invalid_spans');
      expect(spans([{ start: 0, end: 99999 }])).toBe('invalid_spans');
      expect(spans([{ start: 0.5, end: 3 }])).toBe('invalid_spans');
      expect(
        spans([
          { start: 10, end: 20 },
          { start: 15, end: 25 },
        ]),
      ).toBe('invalid_spans');
      expect(new AuditRepository(db).findByAction('redacted')).toEqual([]);
    }, false);
  });

  it('rolls everything back when the candidate copy fails the disclosure gate', () => {
    // The candidate row's own title carries PII; an unchanged-title redaction
    // keeps it, so the candidate rewrite is refused by the disclosure scan.
    const seeded = seed(PROSE_CONTENT);
    open((db) => {
      db.prepare(`UPDATE candidates SET title = ? WHERE id = ?`).run(
        'Form scan, SSN 078-05-1120',
        seeded.candidateId,
      );
      const { result } = redactMemory(
        {
          memoryId: seeded.memoryId,
          tenantId: TENANT,
          actor: 'jeremy',
          reason: 'r',
          mode: { kind: 'replacement', content: REPLACEMENT },
        },
        {
          memoryRepo: new MemoryRepository(db),
          candidateRepo: new CandidateRepository(db),
          auditRepo: new AuditRepository(db),
        },
      );
      expect(result).toMatchObject({ ok: false, code: 'disclosure_in_replacement' });
      // The memory row was rolled back with the rest of the transaction.
      expect(new MemoryRepository(db).findById(seeded.memoryId)!.content).toBe(PROSE_CONTENT);
      expect(new AuditRepository(db).findByAction('redacted')).toEqual([]);
    }, false);
  });
});

// --- What redaction must not break ----------------------------------------

describe('after a redaction', () => {
  it('provenance-walk still passes: the id is verified against the receipt’s old hash', async () => {
    const seeded = seed(PROSE_CONTENT);
    // Before: the plain derivation holds.
    open((db) => {
      const walk = walkProvenance(db, seeded.memoryId, {
        spoolDirs: [],
        brainDir: join(dir, 'brain'),
      });
      expect(walk.links.find((l) => l.link === 'memory-id-derivation')!.status).toBe('PASS');
    });

    expect(await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT), deps)).toBe(0);
    // A second, different redaction: the trail has two links.
    expect(
      await dispatch(cli(seeded.memoryId, '--replacement-text', `${REPLACEMENT} Reviewed.`), deps),
    ).toBe(0);

    open((db) => {
      const walk = walkProvenance(db, seeded.memoryId, {
        spoolDirs: [],
        brainDir: join(dir, 'brain'),
      });
      const link = walk.links.find((l) => l.link === 'memory-id-derivation')!;
      expect(link.status).toBe('PASS');
      expect(link.evidence).toContain('governed-redacted 2 time(s)');
      expect(walk.failCount).toBe(0);
      expect(walk.links.find((l) => l.link === 'promotion-receipt')!.status).toBe('PASS');
      // The id really is the ORIGINAL derivation, not the current one.
      expect(deriveMemoryId(seeded.candidateId, seeded.oldHash)).toBe(seeded.memoryId);
    });
  });

  it('provenance-walk passes the candidate-id link for a redacted spool-derived candidate', async () => {
    const brainDir = join(dir, 'brain');
    mkdirSync(join(brainDir, 'audit', 'traces'), { recursive: true });
    const relPath = 'wiki/concepts/credential-migration.md';
    const candidateId = deriveCandidateId(
      basename(brainDir),
      relPath,
      computeContentHash(PROSE_CONTENT),
    );
    const seeded = seed(PROSE_CONTENT, {
      id: candidateId,
      source: 'import',
      metadata: { filePaths: [relPath], projectContext: 'ico', tags: [] },
    });
    expect(await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT), deps)).toBe(0);

    open((db) => {
      const walk = walkProvenance(db, seeded.memoryId, { spoolDirs: [], brainDir });
      const link = walk.links.find((l) => l.link === 'candidate-id-derivation')!;
      expect(link.status).toBe('PASS');
      expect(link.evidence).toContain('governed-redacted');
      expect(walk.failCount).toBe(0);
    });
  });

  it('provenance-walk still FAILS a row changed outside a governed redaction', () => {
    const seeded = seed(PROSE_CONTENT);
    open((db) => {
      // A raw rewrite with a self-consistent hash but no receipt…
      db.prepare(`UPDATE curated_memories SET content = ?, content_hash = ? WHERE id = ?`).run(
        'tampered',
        computeContentHash('tampered'),
        seeded.memoryId,
      );
      const walk = walkProvenance(db, seeded.memoryId, {
        spoolDirs: [],
        brainDir: join(dir, 'brain'),
      });
      expect(walk.links.find((l) => l.link === 'memory-id-derivation')!.status).toBe('FAIL');
    }, false);
  });

  it('provenance-walk FAILS when the receipts do not account for the current hash', async () => {
    const seeded = seed(PROSE_CONTENT);
    expect(await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT), deps)).toBe(0);
    open((db) => {
      // …a raw rewrite AFTER a real redaction: the trail no longer ends here.
      db.prepare(`UPDATE curated_memories SET content = ?, content_hash = ? WHERE id = ?`).run(
        'tampered',
        computeContentHash('tampered'),
        seeded.memoryId,
      );
      const walk = walkProvenance(db, seeded.memoryId, {
        spoolDirs: [],
        brainDir: join(dir, 'brain'),
      });
      const link = walk.links.find((l) => l.link === 'memory-id-derivation')!;
      expect(link.status).toBe('FAIL');
      expect(link.evidence).toContain('outside a governed redaction');
    }, false);
  });

  it('dedup still blocks re-ingesting the ORIGINAL content on every path', async () => {
    const seeded = seed(PROSE_CONTENT);
    expect(await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT), deps)).toBe(0);

    open((db) => {
      const memoryRepo = new MemoryRepository(db);
      const candidateRepo = new CandidateRepository(db);
      const auditRepo = new AuditRepository(db);
      const curator = new Curator(
        { candidateRepo, memoryRepo, policyRepo: new PolicyRepository(db), auditRepo },
        { tenantId: TENANT },
      );
      const count = memoryRepo.count();

      // The stored hash changed, so a plain hash lookup no longer finds it…
      expect(memoryRepo.findByContentHashAndTenant(seeded.oldHash, TENANT)).toBeNull();
      // …but the curator still refuses the original, single and batch.
      const comeback = makeCandidate({ content: PROSE_CONTENT });
      const single = curator.processSingle(comeback);
      expect(single.outcome).toBe('duplicate');
      expect(single.reason).toContain('governed redaction');
      expect(single.reason).not.toContain(PROSE_SECRET);
      const batch = curator.processBatch([makeCandidate({ content: PROSE_CONTENT })]);
      expect(batch).toMatchObject({ promoted: 0, duplicates: 1 });
      expect(memoryRepo.count()).toBe(count);

      // The candidate insert choke point refuses it as well.
      expect(() => candidateRepo.insert(comeback, seeded.oldHash)).toThrow(
        RedactedContentReingestError,
      );

      // The redacted replacement is an ordinary duplicate of the memory now.
      expect(curator.processSingle(makeCandidate({ content: REPLACEMENT })).outcome).toBe(
        'duplicate',
      );
      // Another tenant is unaffected by this tenant's redaction.
      const other = new Curator(
        { candidateRepo, memoryRepo, policyRepo: new PolicyRepository(db), auditRepo },
        { tenantId: 'other-tenant', dryRun: true },
      );
      expect(
        other.processSingle(makeCandidate({ content: PROSE_CONTENT, tenantId: 'other-tenant' }))
          .outcome,
      ).toBe('promoted');
    }, false);
  });

  it('corpus accounting still passes: the memory keeps its promoted receipt', async () => {
    const seeded = seed(PROSE_CONTENT);
    expect(await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT), deps)).toBe(0);
    expect(await dispatch(['verify-corpus-accounting', '--db', dbPath, '--json'], deps)).toBe(0);
    expect(await dispatch(['verify-audit-chain', '--db', dbPath, '--json'], deps)).toBe(0);
  });

  it('redacts a duplicate candidate row that holds the same text', async () => {
    const seeded = seed(PROSE_CONTENT);
    const twin = makeCandidate({
      content: PROSE_CONTENT,
      title: 'A second capture of the same text',
    });
    open((db) => insertLegacyCandidate(db, twin), false);

    expect(
      await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--json'), deps),
    ).toBe(0);
    const out = lastJson<RedactJson>();
    expect(out.candidate_ids.sort()).toEqual([seeded.candidateId, twin.id].sort());
    expect(out.audit_event_ids).toHaveLength(3);
    open((db) => {
      expect(new CandidateRepository(db).findById(twin.id)!.content).toBe(REPLACEMENT);
      expect(dumpAllTables(db)).not.toContain(PROSE_SECRET);
    });
    expect(bytesContain(PROSE_SECRET)).toBe(false);
  });

  it('reaches a legacy candidate row that no longer parses as a MemoryCandidate', async () => {
    const seeded = seed(PROSE_CONTENT);
    open(
      (db) =>
        db
          .prepare(`UPDATE candidates SET metadata_json = ? WHERE id = ?`)
          .run(JSON.stringify({ filePaths: [], tags: ['Not A Valid Tag'] }), seeded.candidateId),
      false,
    );
    expect(
      await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--json'), deps),
    ).toBe(0);
    expect(lastJson<RedactJson>().candidate_ids).toEqual([seeded.candidateId]);
    open((db) => expect(dumpAllTables(db)).not.toContain(PROSE_SECRET));
    expect(bytesContain(PROSE_SECRET)).toBe(false);
  });

  it('works when the candidate row no longer exists', async () => {
    const seeded = seed(PROSE_CONTENT);
    open((db) => db.prepare('DELETE FROM candidates WHERE id = ?').run(seeded.candidateId), false);
    expect(
      await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--json'), deps),
    ).toBe(0);
    const out = lastJson<RedactJson>();
    expect(out.candidate_ids).toEqual([]);
    expect(out.audit_event_ids).toHaveLength(1);
  });
});

// --- Physical scrub reporting ---------------------------------------------

describe('physical scrub reporting', () => {
  it('names another current row that still holds the removed text', async () => {
    const seeded = seed(PROSE_CONTENT);
    // A second memory holding the same secret line, under a different candidate.
    const other = open((db) => {
      const twin = makeCandidate({
        content: `Unrelated note.\nThe account passphrase we set is ${PROSE_SECRET} for now.`,
      });
      insertLegacyCandidate(db, twin);
      return promote(
        {
          candidate: twin,
          contentHash: computeContentHash(twin.content),
          pipelineResult: approved(twin.id),
        },
        new MemoryRepository(db),
        new AuditRepository(db),
      ).id;
    }, false);

    const rc = await dispatch(
      cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--json'),
      deps,
    );
    // The redaction is complete for ITS row; the residue is explained by a live row.
    expect(rc).toBe(0);
    const scrub = lastJson<RedactJson>().physical_scrub!;
    expect(scrub.complete).toBe(true);
    expect(scrub.residual_fragments).toBeGreaterThan(0);
    expect(scrub.unexplained_residual_fragments).toBe(0);
    expect(scrub.rows_still_containing_removed_text).toEqual(
      expect.arrayContaining([{ table: 'curated_memories', id: other }]),
    );
  });

  it('exits 4 when the scrub is blocked — the redaction itself is committed', async () => {
    const seeded = seed(PROSE_CONTENT);
    const reader = createDatabase({ path: dbPath, readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM curated_memories').get();
    const fastFail: CuratorCliDeps = {
      createDb: ({ dbPath: p, readonly }) => {
        const db = createDatabase({ path: p!, readonly: readonly ?? false });
        db.pragma('busy_timeout = 50');
        return db;
      },
    };
    try {
      const rc = await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT), fastFail);
      expect(rc).toBe(4);
      expect(stdoutText()).toContain('Physical scrub: INCOMPLETE');
      expect(stdoutText()).toContain('scrub step failed');
      expect(stdoutText()).toContain('re-run the same command');
    } finally {
      reader.exec('COMMIT');
      reader.close();
    }
    open((db) => {
      expect(new MemoryRepository(db).findById(seeded.memoryId)!.content).toBe(REPLACEMENT);
      expect(new AuditRepository(db).findRedactionsFor(seeded.memoryId)).toHaveLength(1);
    });

    // Re-running once the store is free completes the scrub without a new receipt.
    stdoutSpy.mockClear();
    expect(
      await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--json'), deps),
    ).toBe(0);
    expect(lastJson<RedactJson>()).toMatchObject({
      status: 'unchanged',
      physical_scrub: { complete: true },
    });
    expect(bytesContain(PROSE_SECRET)).toBe(false);
    open((db) =>
      expect(new AuditRepository(db).findRedactionsFor(seeded.memoryId)).toHaveLength(1),
    );
  });

  it('--skip-scrub commits the redaction and says the bytes remain', async () => {
    const seeded = seed(PROSE_CONTENT);
    const rc = await dispatch(
      cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--skip-scrub', '--json'),
      deps,
    );
    expect(rc).toBe(0);
    expect(lastJson<RedactJson>()).toMatchObject({ status: 'redacted', physical_scrub: null });
    open((db) => expect(dumpAllTables(db)).not.toContain('account passphrase we set'));
  });

  it('exits 1 when the store cannot be opened, and on an unexpected failure', async () => {
    const seeded = seed(PROSE_CONTENT);
    const broken: CuratorCliDeps = {
      createDb: () => {
        throw new Error('disk gone');
      },
    };
    expect(await dispatch(cli(seeded.memoryId, '--scan'), broken)).toBe(1);
    expect(stderrText()).toContain('redact failed: disk gone');

    // A read-only handle on a live run: the write throws -> exit 1, both formats.
    const readonlyDeps: CuratorCliDeps = {
      createDb: ({ dbPath: p }) => createDatabase({ path: p!, readonly: true }),
    };
    expect(
      await dispatch(
        cli(seeded.memoryId, '--replacement-text', REPLACEMENT, '--json'),
        readonlyDeps,
      ),
    ).toBe(1);
    expect(stdoutText()).toContain('REDACT_FAILED');
    expect(
      await dispatch(cli(seeded.memoryId, '--replacement-text', REPLACEMENT), readonlyDeps),
    ).toBe(1);
    expect(stderrText()).toContain('redact failed');
  });
});
