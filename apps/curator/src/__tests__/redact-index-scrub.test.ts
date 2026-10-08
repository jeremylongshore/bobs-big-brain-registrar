/**
 * `curator-cli redact` → derived-index scrub (umbrella bead
 * compile-then-govern-39z.19).
 *
 * The curator must not import the retrieval package (seam-independence gate),
 * so the index scrub runs as a child process. Two layers here:
 *   1. the runner against a FAKE CLI script — always runs, proves the process
 *      contract: fragments go on stdin (never argv), exit codes map to the
 *      redact exit 4, a missing tool is reported, an absent index is a no-op;
 *   2. the real `qmd-index scrub-index` from the workspace build, end to end
 *      on a file-backed store and two tenant indexes — runs whenever
 *      `packages/qmd-adapter/dist/cli.js` exists (CI builds it in the
 *      typecheck step before tests; the delete-compile seam job removes it,
 *      and the curator must still pass there).
 *
 * The index fixture is a native-FTS5-shaped file written through the store's
 * `createDatabase` (the curator has no direct better-sqlite3 dependency); its
 * extra store tables are ignored by the scrub's schema guard. Synthetic secret.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { AuditRepository, MemoryRepository, createDatabase } from '@qmd-team-intent-kb/store';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type CuratorCliDeps } from '../cli.js';
import { promote } from '../promotion/promoter.js';
import {
  defaultIndexDirs,
  resolveIndexScrubCli,
  runIndexScrub,
} from '../redaction/index-scrub-runner.js';
import { makeCandidate, TENANT } from './fixtures.js';

const SECRET = 'zq' + 'Synth' + 'Quarry' + '8Jm3Vt6Yc1Ps';
const LEAKED = [
  '## Credential handover',
  '',
  `The shared vault passphrase is ${SECRET} until the rotation lands.`,
  'Rotate it after the cutover window closes.',
].join('\n');
const SURVIVOR = 'The heliotrope naming convention for build agents stays as it is.';
const REPLACEMENT = '[REDACTED] This memory held a credential; it was removed and rotated.';

let dir: string;
let dbPath: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let deps: CuratorCliDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'redact-index-scrub-'));
  dbPath = join(dir, 'teamkb.db');
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  deps = {
    createDb: ({ dbPath: p, readonly }) =>
      createDatabase({ path: p!, readonly: readonly ?? false }),
  };
});

afterEach(() => {
  const printed = text(stdoutSpy) + text(stderrSpy);
  expect(printed).not.toContain(SECRET);
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const text = (spy: ReturnType<typeof vi.spyOn>): string =>
  (spy.mock.calls as unknown as Array<[unknown]>).map((c) => String(c[0])).join('');

function lastJson(): Record<string, unknown> {
  const lines = text(stdoutSpy).trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

const approved = (candidateId: string): PipelineResult => ({
  candidateId,
  outcome: 'approved',
  evaluations: [],
});

/** The incident shape: a candidate admitted before any pattern recognized its text. */
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

function seedLeakedMemory(): string {
  const db = createDatabase({ path: dbPath });
  try {
    const candidate = makeCandidate({ content: LEAKED, title: 'Credential handover' });
    insertLegacyCandidate(db, candidate);
    const memory = promote(
      {
        candidate,
        contentHash: computeContentHash(LEAKED),
        pipelineResult: approved(candidate.id),
      },
      new MemoryRepository(db),
      new AuditRepository(db),
    );
    return memory.id;
  } finally {
    db.close();
  }
}

/** A native-FTS5-shaped index file for one tenant, as NativeIndexManager writes it. */
function buildNativeIndex(tenant: string, docs: Array<{ id: string; content: string }>): void {
  const path = join(dir, 'qmd-index', tenant, 'native-fts5.sqlite');
  mkdirSync(join(dir, 'qmd-index', tenant), { recursive: true });
  const db = createDatabase({ path });
  try {
    db.exec(
      'CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, collection UNINDEXED, content); ' +
        'CREATE TABLE files (path TEXT PRIMARY KEY, doc_id TEXT NOT NULL, mtime_ms REAL NOT NULL)',
    );
    const insert = db.prepare('INSERT INTO docs(id, collection, content) VALUES (?, ?, ?)');
    for (const doc of docs) insert.run(doc.id, 'kb-curated', doc.content);
  } finally {
    db.close();
  }
}

function writeExport(name: string, body: string): void {
  mkdirSync(join(dir, 'kb-export', 'curated'), { recursive: true });
  writeFileSync(join(dir, 'kb-export', 'curated', name), body, 'utf8');
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

const indexFilesHolding = (needle: string): string[] =>
  filesUnder(join(dir, 'qmd-index'))
    .filter((f) => readFileSync(f).includes(Buffer.from(needle, 'utf8')))
    .map((f) => relative(join(dir, 'qmd-index'), f));

/** A stand-in CLI: records argv + stdin to a file, prints an envelope, exits `code`. */
function fakeCli(code: number, envelope: Record<string, unknown> | null): string {
  const script = join(dir, 'fake-cli.mjs');
  const record = join(dir, 'fake-cli-record.json');
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
${envelope === null ? "process.stderr.write('boom\\n');" : `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))} + '\\n');`}
process.exit(${code});
`,
  );
  return script;
}

describe('index scrub runner — process contract (fake CLI)', () => {
  it('sends the fragments on stdin, never in argv, and reads the envelope back', () => {
    mkdirSync(join(dir, 'qmd-index'), { recursive: true });
    const cli = fakeCli(0, { complete: true, tenants: [] });
    const outcome = runIndexScrub({
      indexDir: join(dir, 'qmd-index'),
      exportDir: join(dir, 'kb-export'),
      memoryId: '0a000000-0000-5000-8000-00000000000a',
      fragments: [SECRET, 'two\nlines'],
      cliPath: cli,
    });
    expect(outcome).toMatchObject({ ran: true, complete: true, exitCode: 0, note: null });
    const record = JSON.parse(readFileSync(join(dir, 'fake-cli-record.json'), 'utf8')) as {
      argv: string[];
      stdin: string;
    };
    expect(record.argv.join(' ')).not.toContain(SECRET);
    expect(record.argv).toEqual(
      expect.arrayContaining([
        'scrub-index',
        '--json',
        '--fragments-stdin',
        '--explained-residual-ok',
        '--drop-memory-id',
      ]),
    );
    expect(JSON.parse(record.stdin)).toEqual([SECRET, 'two\nlines']);
  });

  it('maps the CLI exit codes to an incomplete outcome with a reason', () => {
    mkdirSync(join(dir, 'qmd-index'), { recursive: true });
    const base = {
      indexDir: join(dir, 'qmd-index'),
      exportDir: join(dir, 'kb-export'),
      memoryId: '0a000000-0000-5000-8000-00000000000a',
      fragments: [],
    };
    const busy = runIndexScrub({ ...base, cliPath: fakeCli(4, { complete: false }) });
    expect(busy).toMatchObject({ complete: false, exitCode: 4 });
    expect(busy.note).toMatch(/busy/);
    const drift = runIndexScrub({ ...base, cliPath: fakeCli(5, { complete: false }) });
    expect(drift.note).toMatch(/qmd version drift/);
    const crash = runIndexScrub({ ...base, cliPath: fakeCli(1, null) });
    expect(crash).toMatchObject({ complete: false, exitCode: 1 });
    expect(crash.note).toMatch(/failed \(exit 1\): boom/);
    const missing = runIndexScrub({ ...base, cliPath: join(dir, 'nope.js') });
    expect(missing).toMatchObject({ ran: false, complete: false });
    expect(missing.note).toMatch(/not found/);
  });

  it('is a complete no-op when there is no index directory', () => {
    const outcome = runIndexScrub({
      indexDir: join(dir, 'qmd-index'),
      exportDir: join(dir, 'kb-export'),
      memoryId: '0a000000-0000-5000-8000-00000000000a',
      fragments: [SECRET],
      cliPath: join(dir, 'never-run.js'),
    });
    expect(outcome).toMatchObject({ ran: false, complete: true });
  });

  it('defaults the index and export dirs to siblings of the store', () => {
    expect(defaultIndexDirs('/srv/brain/teamkb.db')).toEqual({
      indexDir: '/srv/brain/qmd-index',
      exportDir: '/srv/brain/kb-export',
    });
    expect(resolveIndexScrubCli({ TEAMKB_QMD_INDEX_CLI: '/opt/x/cli.js' })).toBe('/opt/x/cli.js');
    expect(resolveIndexScrubCli({})).toMatch(/packages\/qmd-adapter\/dist\/cli\.js$/);
  });

  it('redact exits 4 when the index scrub tool is missing, and --skip-index-scrub opts out', async () => {
    const memoryId = seedLeakedMemory();
    mkdirSync(join(dir, 'qmd-index'), { recursive: true });
    const env = process.env['TEAMKB_QMD_INDEX_CLI'];
    process.env['TEAMKB_QMD_INDEX_CLI'] = join(dir, 'missing-cli.js');
    try {
      const args = [
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
        'credential in prose',
        '--replacement-text',
        REPLACEMENT,
      ];
      expect(await dispatch([...args, '--json'], deps)).toBe(4);
      expect(lastJson()['index_scrub']).toMatchObject({ ran: false, complete: false });
      // A re-run is `unchanged`; opting out of the index scrub exits 0.
      expect(await dispatch([...args, '--skip-index-scrub'], deps)).toBe(0);
    } finally {
      if (env === undefined) delete process.env['TEAMKB_QMD_INDEX_CLI'];
      else process.env['TEAMKB_QMD_INDEX_CLI'] = env;
    }
  });
});

describe.skipIf(!existsSync(resolveIndexScrubCli({})))(
  'curator-cli redact → real qmd-index scrub-index (two tenants)',
  () => {
    it('scrubs the redacted memory out of every tenant index and byte-scans them', async () => {
      const memoryId = seedLeakedMemory();
      const survivorId = '0b000000-0000-5000-8000-00000000000b';
      // The export is NOT reconciled yet — the state at redaction time.
      writeExport(`${memoryId}.md`, LEAKED);
      writeExport(`${survivorId}.md`, SURVIVOR);
      for (const tenant of ['intent-solutions', 'local']) {
        buildNativeIndex(tenant, [
          { id: `qmd://kb-curated/${memoryId}.md`, content: LEAKED },
          { id: `qmd://kb-curated/${survivorId}.md`, content: SURVIVOR },
        ]);
      }
      expect(indexFilesHolding(SECRET).length).toBeGreaterThan(0);

      const rc = await dispatch(
        [
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
          'credential in prose',
          '--replacement-text',
          REPLACEMENT,
          '--json',
        ],
        deps,
      );
      const body = lastJson();
      expect(rc).toBe(0);
      const indexScrub = body['index_scrub'] as Record<string, unknown>;
      expect(indexScrub).toMatchObject({ ran: true, complete: true, exit_code: 0 });
      const report = indexScrub['report'] as {
        tenants: Array<{
          tenant: string;
          files: Array<{ status: string; removed: Record<string, number> }>;
        }>;
        fragment_scan: Record<string, unknown>;
      };
      expect(report.tenants.map((t) => t.tenant)).toEqual(['intent-solutions', 'local']);
      for (const tenant of report.tenants) {
        expect(tenant.files[0]!.status).toBe('scrubbed');
        expect(tenant.files[0]!.removed['targeted_documents']).toBe(1);
      }
      expect(report.fragment_scan).toMatchObject({
        residual_fragments: 0,
        unexplained_residual_fragments: 0,
      });
      expect(indexFilesHolding(SECRET)).toEqual([]);
      expect(indexFilesHolding('heliotrope').length).toBeGreaterThan(0);

      // The text report scopes its verdict to this memory and points at the confirming run.
      const textRc = await dispatch(
        [
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
          'credential in prose',
          '--replacement-text',
          REPLACEMENT,
        ],
        deps,
      );
      expect(textRc).toBe(0);
      expect(text(stdoutSpy)).toMatch(/Index scrub: complete for this memory/);
      expect(text(stdoutSpy)).toMatch(/Confirm after export --reconcile/);
    }, 60_000);
  },
);
