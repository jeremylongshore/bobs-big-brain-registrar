/**
 * Index scrub (umbrella bead compile-then-govern-39z.19) on real temp
 * directories: two tenants, each with a qmd-2.5.3-shaped BM25 cache, a native
 * FTS5 index and a dense sidecar built by the production classes. Synthetic
 * secret only.
 *
 * The qmd cache here is a SQLite file written with qmd 2.5.3's DDL so a test
 * controls its rows exactly; the real-binary path is covered by
 * index-scrub-qmd-integration.test.ts.
 */

import { readFileSync, rmSync, mkdtempSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from '../cli.js';
import { Fts5Backend } from '../native/fts5-backend.js';
import { PINNED_QMD_VERSION, QMD_INDEX_SCHEMA, checkSchema } from '../scrub/schema-guard.js';
import { scrubIndexes, discoverTenants, MASS_REMOVAL_FLOOR } from '../scrub/index-scrub.js';
import type { IndexFileReport, IndexScrubReport } from '../scrub/index-scrub.js';
import type { indexScrubJson } from '../scrub/format.js';
import { formatIndexScrub } from '../scrub/format.js';
import { isHandelizeIdentity } from '../scrub/export-truth.js';
import { parseFragmentsJson } from '../scrub/scrub-index-cli.js';
import {
  LEAKED,
  MEMORY_A,
  MEMORY_B,
  QMD_253_DDL,
  REDACTED,
  SECRET,
  SURVIVOR,
  SURVIVOR_TERM,
  buildDense,
  buildNative,
  buildQmdFixture,
  filesContaining,
  fingerprint,
  writeExport,
} from './index-scrub-fixtures.js';

const TENANTS = ['intent-solutions', 'local'];

let work: string;
let indexDir: string;
let exportDir: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'index-scrub-'));
  indexDir = join(work, 'qmd-index');
  exportDir = join(work, 'kb-export');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const qmdPath = (tenant: string): string => join(indexDir, tenant, 'cache', 'qmd', 'index.sqlite');
const nativePath = (tenant: string): string => join(indexDir, tenant, 'native-fts5.sqlite');
const densePath = (tenant: string): string => join(indexDir, tenant, 'dense-vec.sqlite');

/**
 * Index a leaked memory A and a survivor B for both tenants, then "redact":
 * the export of A is rewritten (what exporter --reconcile does) but no index
 * is rebuilt — the 2026-10-04 state.
 */
function buildLeakedBrain(): void {
  writeExport(exportDir, 'curated', `${MEMORY_A}.md`, LEAKED);
  writeExport(exportDir, 'curated', `${MEMORY_B}.md`, SURVIVOR);
  const docs = [
    { collection: 'kb-curated', name: `${MEMORY_A}.md`, content: LEAKED },
    { collection: 'kb-curated', name: `${MEMORY_B}.md`, content: SURVIVOR },
  ];
  for (const tenant of TENANTS) {
    buildQmdFixture(
      qmdPath(tenant),
      docs.map((d) => ({ collection: d.collection, path: d.name, content: d.content })),
    );
    buildNative(nativePath(tenant), exportDir);
    buildDense(densePath(tenant), docs);
  }
  writeExport(exportDir, 'curated', `${MEMORY_A}.md`, REDACTED);
}

function file(report: IndexScrubReport, tenant: string, kind: string): IndexFileReport {
  const t = report.tenants.find((x) => x.tenant === tenant)!;
  return t.files.find((f) => f.kind === kind)!;
}

describe('scrubIndexes — the 2026-10-04 incident shape', () => {
  it('removes the secret from every file of BOTH tenants and keeps the survivor searchable', () => {
    buildLeakedBrain();
    // Hold a reader open on one native index so its -wal and -shm stay on disk,
    // the way the live API holds them.
    const reader = new Database(nativePath('local'));
    reader.exec(
      "INSERT INTO docs(id, collection, content) VALUES ('qmd://kb-curated/x.md', 'kb-curated', 'wal " +
        SECRET +
        "')",
    );
    reader.exec("DELETE FROM docs WHERE id = 'qmd://kb-curated/x.md'");
    expect(existsSync(`${nativePath('local')}-wal`)).toBe(true);

    const before = filesContaining(indexDir, SECRET);
    for (const tenant of TENANTS) {
      expect(before.some((f) => f.startsWith(`${tenant}/cache/qmd/index.sqlite`))).toBe(true);
      expect(before.some((f) => f.startsWith(`${tenant}/native-fts5.sqlite`))).toBe(true);
      expect(before).toContain(`${tenant}/dense-vec.sqlite`);
    }
    expect(before).toContain('local/native-fts5.sqlite-wal');

    const report = scrubIndexes({ indexDir, exportDir, fragments: [SECRET] });
    reader.close();

    expect(report.complete).toBe(true);
    expect(report.tenants.map((t) => t.tenant)).toEqual(TENANTS);
    for (const tenant of TENANTS) {
      expect(file(report, tenant, 'qmd')).toMatchObject({
        status: 'scrubbed',
        ftsRebuilt: true,
        vacuumed: true,
        walTruncated: true,
        errors: [],
      });
      expect(file(report, tenant, 'qmd').removed).toMatchObject({
        staleDocuments: 1,
        orphanContent: 1,
        ftsRows: 1,
        cacheRows: 1,
      });
      expect(file(report, tenant, 'native').removed).toMatchObject({
        staleDocuments: 1,
        fileRows: 1,
      });
      expect(file(report, tenant, 'dense').removed).toMatchObject({
        staleDocuments: 1,
        orphanVectors: 1,
      });
    }
    expect(report.fragmentScan).toMatchObject({
      fragmentsChecked: 1,
      residualFragments: 0,
      unexplainedResidualFragments: 0,
      residualFiles: [],
    });
    // Independent check of every byte under both tenants (db, -wal, -shm).
    expect(filesContaining(indexDir, SECRET)).toEqual([]);

    // Search still works for the survivor in each kept index.
    for (const tenant of TENANTS) {
      const qmd = new Database(qmdPath(tenant), { readonly: true });
      const hits = qmd
        .prepare('SELECT filepath FROM documents_fts WHERE documents_fts MATCH ?')
        .all(SURVIVOR_TERM) as Array<{ filepath: string }>;
      qmd.close();
      expect(hits.map((h) => h.filepath)).toEqual([`kb-curated/${MEMORY_B}.md`]);
      const native = new Fts5Backend({ path: nativePath(tenant) });
      expect(native.search(SURVIVOR_TERM, 5).map((h) => h.id)).toEqual([
        `qmd://kb-curated/${MEMORY_B}.md`,
      ]);
      native.close();
    }
  });

  it('is idempotent: a second run removes nothing and stays complete', () => {
    buildLeakedBrain();
    expect(scrubIndexes({ indexDir, exportDir }).complete).toBe(true);
    const again = scrubIndexes({ indexDir, exportDir, fragments: [SECRET] });
    expect(again.complete).toBe(true);
    for (const tenant of again.tenants) {
      for (const f of tenant.files) {
        expect(f.status).toBe('scrubbed');
        expect(Object.values(f.removed).every((n) => n === 0)).toBe(true);
      }
    }
  });

  it('dry-run reports per tenant and file and writes nothing', () => {
    buildLeakedBrain();
    const before = fingerprint(indexDir);
    const report = scrubIndexes({ indexDir, exportDir, dryRun: true, fragments: [SECRET] });
    expect(fingerprint(indexDir)).toEqual(before);
    expect(report.dryRun).toBe(true);
    expect(report.complete).toBe(true);
    for (const tenant of TENANTS) {
      expect(file(report, tenant, 'qmd').status).toBe('would_scrub');
      expect(file(report, tenant, 'qmd').removed.staleDocuments).toBe(1);
      expect(file(report, tenant, 'native').removed.staleDocuments).toBe(1);
      expect(file(report, tenant, 'dense').removed.staleDocuments).toBe(1);
    }
    // The byte scan is read-only too, and still sees the text.
    expect(report.fragmentScan!.residualFragments).toBe(1);
    expect(filesContaining(indexDir, SECRET).length).toBeGreaterThan(0);
  });

  it('dry-run reads a WAL-holding index in place without changing its db or -wal bytes', () => {
    buildLeakedBrain();
    const db = nativePath('intent-solutions');
    const wal = `${db}-wal`;
    // A live writer leaves frames in the WAL (as the API does between checkpoints).
    const holder = new Database(db);
    holder.pragma('wal_autocheckpoint = 0');
    holder.exec(
      "INSERT INTO docs(id, collection, content) VALUES ('qmd://kb-curated/y.md', 'kb-curated', 'fresh words')",
    );
    const snap = (p: string): string => readFileSync(p).toString('base64');
    const beforeDb = snap(db);
    const beforeWal = snap(wal);
    expect(readFileSync(wal).length).toBeGreaterThan(0);
    try {
      const report = scrubIndexes({ indexDir, exportDir, dryRun: true });
      expect(file(report, 'intent-solutions', 'native').status).toBe('would_scrub');
      expect(snap(db)).toBe(beforeDb);
      expect(snap(wal)).toBe(beforeWal);
    } finally {
      holder.close();
    }
  });
});

describe('scrubIndexes — targeted drop for a redaction in progress', () => {
  it('drops the named memory even though kb-export still holds it, and keeps the native files row', () => {
    writeExport(exportDir, 'curated', `${MEMORY_A}.md`, LEAKED);
    writeExport(exportDir, 'curated', `${MEMORY_B}.md`, SURVIVOR);
    const docs = [
      { collection: 'kb-curated', name: `${MEMORY_A}.md`, content: LEAKED },
      { collection: 'kb-curated', name: `${MEMORY_B}.md`, content: SURVIVOR },
    ];
    buildQmdFixture(
      qmdPath('zeta'),
      docs.map((d) => ({ collection: d.collection, path: d.name, content: d.content })),
    );
    buildNative(nativePath('zeta'), exportDir);
    buildDense(densePath('zeta'), docs);

    const report = scrubIndexes({
      indexDir,
      exportDir,
      dropMemoryIds: [MEMORY_A],
      fragments: [SECRET],
      explainedResidualIsComplete: true,
    });
    expect(report.complete).toBe(true);
    for (const kind of ['qmd', 'native', 'dense']) {
      expect(file(report, 'zeta', kind).removed.targetedDocuments).toBe(1);
      expect(file(report, 'zeta', kind).removed.staleDocuments).toBe(0);
    }
    expect(filesContaining(indexDir, SECRET)).toEqual([]);
    const native = new Database(nativePath('zeta'), { readonly: true });
    const kept = native.prepare('SELECT doc_id FROM files ORDER BY doc_id').all();
    native.close();
    // Kept: a live refresh must not re-read the not-yet-reconciled export.
    expect(kept).toHaveLength(2);
  });

  it('counts a fragment another memory still exports as explained, not incomplete', () => {
    writeExport(exportDir, 'curated', `${MEMORY_A}.md`, LEAKED);
    writeExport(exportDir, 'curated', `${MEMORY_B}.md`, `${SURVIVOR}\nAlso ${SECRET}.\n`);
    buildNative(nativePath('t1'), exportDir);
    const redactRun = scrubIndexes({
      indexDir,
      exportDir,
      dropMemoryIds: [MEMORY_A],
      fragments: [SECRET],
      explainedResidualIsComplete: true,
    });
    expect(redactRun.fragmentScan).toMatchObject({
      residualFragments: 1,
      unexplainedResidualFragments: 0,
      explainedBy: [`qmd://kb-curated/${MEMORY_B}.md`],
    });
    expect(redactRun.complete).toBe(true);
    // Standalone semantics: any residual is incomplete.
    const standalone = scrubIndexes({ indexDir, exportDir, fragments: [SECRET] });
    expect(standalone.complete).toBe(false);
  });
});

describe('scrubIndexes — orphans and guards', () => {
  it('removes qmd inactive rows and orphaned content rows', () => {
    writeExport(exportDir, 'curated', `${MEMORY_B}.md`, SURVIVOR);
    buildQmdFixture(
      qmdPath('t1'),
      [
        { collection: 'kb-curated', path: `${MEMORY_B}.md`, content: SURVIVOR },
        { collection: 'kb-guides', path: `${MEMORY_A}.md`, content: LEAKED, active: false },
      ],
      [`orphan text ${SECRET}`],
    );
    const report = scrubIndexes({ indexDir, exportDir, fragments: [SECRET] });
    expect(file(report, 't1', 'qmd').removed).toMatchObject({
      inactiveDocuments: 1,
      orphanContent: 2,
      staleDocuments: 0,
    });
    expect(report.complete).toBe(true);
    const db = new Database(qmdPath('t1'), { readonly: true });
    expect(db.prepare('SELECT count(*) AS n FROM content').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM documents').get()).toEqual({ n: 1 });
    db.close();
  });

  it('refuses a file with an unexpected qmd schema and leaves it untouched', () => {
    writeExport(exportDir, 'curated', `${MEMORY_B}.md`, SURVIVOR);
    const drifted = QMD_253_DDL.replace('doc TEXT NOT NULL', 'body TEXT NOT NULL').replace(
      /CREATE TRIGGER[\s\S]*$/,
      '',
    );
    buildQmdFixture(qmdPath('t1'), [], [], drifted);
    const before = fingerprint(indexDir);
    const report = scrubIndexes({ indexDir, exportDir });
    expect(report.schemaRefused).toBe(true);
    expect(report.complete).toBe(false);
    expect(file(report, 't1', 'qmd').status).toBe('schema_refused');
    expect(file(report, 't1', 'qmd').errors.join(' ')).toMatch(/content columns/);
    expect(fingerprint(indexDir)).toEqual(before);
  });

  it('reports a busy database by name and finishes on a retry', () => {
    buildLeakedBrain();
    const holder = new Database(nativePath('local'));
    holder.exec('BEGIN IMMEDIATE');
    const report = scrubIndexes({ indexDir, exportDir, busyTimeoutMs: 20 });
    expect(report.complete).toBe(false);
    const busy = file(report, 'local', 'native');
    expect(busy.status).toBe('busy');
    expect(busy.file).toBe('local/native-fts5.sqlite');
    expect(busy.errors.join(' ')).toMatch(/busy/);
    expect(formatIndexScrub(report)).toMatch(/Stop the brain API/);
    holder.exec('ROLLBACK');
    holder.close();
    expect(scrubIndexes({ indexDir, exportDir, fragments: [SECRET] }).complete).toBe(true);
  });

  it('refuses a mass removal unless allowed, and never empties an index on a missing export', () => {
    const count = MASS_REMOVAL_FLOOR + 10;
    const docs = Array.from({ length: count }, (_, i) => ({
      collection: 'kb-guides',
      path: `${String(i).padStart(8, '0')}-0000-5000-8000-000000000000.md`,
      content: `guide ${i}`,
    }));
    buildQmdFixture(qmdPath('t1'), docs);
    writeExport(exportDir, 'curated', `${MEMORY_B}.md`, SURVIVOR);

    const refused = scrubIndexes({ indexDir, exportDir });
    expect(file(refused, 't1', 'qmd').status).toBe('mass_removal_refused');
    expect(refused.complete).toBe(false);

    const missing = scrubIndexes({ indexDir, exportDir: join(work, 'nope') });
    expect(missing.exportPresent).toBe(false);
    expect(missing.warnings.join(' ')).toMatch(/reconcile skipped/);
    expect(file(missing, 't1', 'qmd').removed.staleDocuments).toBe(0);

    const allowed = scrubIndexes({ indexDir, exportDir, allowMassRemoval: true });
    expect(file(allowed, 't1', 'qmd').removed.staleDocuments).toBe(count);
    expect(allowed.complete).toBe(true);
  });

  it('discovers tenant directories instead of naming them, and tolerates an absent index dir', () => {
    buildNative(nativePath('alpha'), exportDir);
    buildNative(nativePath('omega'), exportDir);
    expect(discoverTenants(indexDir)).toEqual(['alpha', 'omega']);
    const none = scrubIndexes({ indexDir: join(work, 'absent'), exportDir });
    expect(none).toMatchObject({ indexDirExists: false, complete: true, tenants: [] });
  });
});

describe('schema pin', () => {
  it('pins the same qmd version as the root package.json', () => {
    const root = JSON.parse(
      readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    expect(root.devDependencies['@tobilu/qmd']).toBe(PINNED_QMD_VERSION);
  });

  it('accepts the recorded qmd 2.5.3 layout', () => {
    const db = new Database(':memory:');
    db.exec(QMD_253_DDL);
    expect(checkSchema(db, QMD_INDEX_SCHEMA)).toEqual([]);
    db.close();
  });

  it('refuses an external-content FTS table', () => {
    const db = new Database(':memory:');
    db.exec(
      QMD_253_DDL.replace(
        "fts5(filepath, title, body, tokenize='porter unicode61')",
        "fts5(filepath, title, body, content='documents')",
      ).replace(/CREATE TRIGGER[\s\S]*$/, ''),
    );
    expect(checkSchema(db, QMD_INDEX_SCHEMA).join(' ')).toMatch(/external-content/);
    db.close();
  });

  it('maps only the names qmd stores verbatim', () => {
    expect(isHandelizeIdentity(`${MEMORY_A}.md`)).toBe(true);
    expect(isHandelizeIdentity('My Notes.md')).toBe(false);
    expect(isHandelizeIdentity('-lead.md')).toBe(false);
    expect(isHandelizeIdentity('a/b.md')).toBe(false);
  });
});

describe('qmd-index scrub-index CLI', () => {
  const logs: string[] = [];
  const errs: string[] = [];
  const deps = {
    env: { TEAMKB_EXPORT_DIR: '' } as NodeJS.ProcessEnv,
    log: (m: string) => logs.push(m),
    errLog: (m: string) => errs.push(m),
    makeAdapter: () => {
      throw new Error('scrub-index must not construct an adapter');
    },
  };
  beforeEach(() => {
    logs.length = 0;
    errs.length = 0;
  });

  const args = (...extra: string[]): string[] => [
    'scrub-index',
    '--index-dir',
    indexDir,
    '--export-dir',
    exportDir,
    ...extra,
  ];

  it('dry-run --json exits 0 with per-tenant counts and no fragment text', async () => {
    buildLeakedBrain();
    const fragments = join(work, 'fragments.txt');
    writeFileSync(fragments, `${SECRET}\n`, { mode: 0o600 });
    expect(await run(args('--dry-run', '--json', '--scan-fragments-file', fragments), deps)).toBe(
      0,
    );
    const out = logs.join('\n');
    expect(out).not.toContain(SECRET);
    const body = JSON.parse(out) as ReturnType<typeof indexScrubJson>;
    expect(body['dry_run']).toBe(true);
    expect((body['tenants'] as unknown[]).length).toBe(2);
    expect(body['fragment_scan']).toMatchObject({ residual_fragments: 1 });
  });

  it('exits 4 while text remains and 0 after a live scrub', async () => {
    buildLeakedBrain();
    const holder = new Database(nativePath('local'));
    holder.exec('BEGIN IMMEDIATE');
    expect(await run(args('--busy-timeout-ms', '10'), deps)).toBe(4);
    holder.exec('ROLLBACK');
    holder.close();
    expect(await run(args(), deps)).toBe(0);
    expect(logs.join('\n')).toMatch(/Index scrub: complete/);
  });

  it('exits 5 on schema drift', async () => {
    buildQmdFixture(
      qmdPath('t1'),
      [],
      [],
      QMD_253_DDL.replace('doc TEXT NOT NULL', 'body TEXT NOT NULL').replace(
        /CREATE TRIGGER[\s\S]*$/,
        '',
      ),
    );
    expect(await run(args(), deps)).toBe(5);
  });

  it('refuses a fragments file readable by others, and bad flags, with exit 2', async () => {
    const loose = join(work, 'loose.txt');
    writeFileSync(loose, `${SECRET}\n`);
    chmodSync(loose, 0o644);
    expect(await run(args('--scan-fragments-file', loose), deps)).toBe(2);
    expect(errs.join('\n')).toMatch(/must be 0600/);
    expect(errs.join('\n')).not.toContain(SECRET);
    expect(await run(args('--bogus'), deps)).toBe(2);
    expect(await run(args('--drop-memory-id', 'not-a-uuid'), deps)).toBe(2);
    expect(await run(args('--busy-timeout-ms', '-1'), deps)).toBe(2);
    expect(await run(args('--fragments-stdin', '--scan-fragments-file', loose), deps)).toBe(2);
  });

  it('parses the stdin fragment contract strictly', () => {
    expect(parseFragmentsJson(JSON.stringify([SECRET, 'two\nlines']))).toEqual({
      ok: true,
      fragments: [SECRET, 'two\nlines'],
    });
    expect(parseFragmentsJson('{"a":1}').ok).toBe(false);
    expect(parseFragmentsJson('not json').ok).toBe(false);
  });
});
