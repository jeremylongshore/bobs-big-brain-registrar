/**
 * Tests for the `secret-sweep` subcommand and its `sweepSecrets` core
 * (umbrella bead compile-then-govern-39z.17): a READ-ONLY whole-brain re-run of
 * the governance secret scan that reports memory id / title / lifecycle /
 * category / pattern names and NEVER the matched text.
 *
 * Runs against a real on-disk SQLite store in a temp directory — the sweep's
 * read-only contract is only meaningful against a file. Every credential-looking
 * value below is SYNTHETIC.
 *
 * @module __tests__/secret-sweep.test
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryRepository, createDatabase } from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type CuratorCliDeps } from '../cli.js';
import { WITHHELD_TITLE, sweepSecrets } from '../secret-sweep/secret-sweep.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const TENANT = 'team-alpha';
const OTHER_TENANT = 'team-beta';

const PROSE_VALUE = 'Tq7!vexLorn42';
const URL_VALUE = 'Pz7mossHalyard';
const TITLE_VALUE = 'Wm2$harborKite';
const OTHER_TENANT_VALUE = 'Nf8&cinderMoth';

const ID_PROSE = '11111111-1111-4111-8111-111111111111';
const ID_URL = '22222222-2222-4222-8222-222222222222';
const ID_TITLE = '33333333-3333-4333-8333-333333333333';
const ID_CLEAN = '44444444-4444-4444-8444-444444444444';
const ID_PLACEHOLDER = '55555555-5555-4555-8555-555555555555';
const ID_OTHER_TENANT = '66666666-6666-4666-8666-666666666666';

let dir: string;
let dbPath: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let createDbCalls: Array<{ dbPath?: string; readonly?: boolean }>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'curator-secret-sweep-'));
  dbPath = join(dir, 'teamkb.db');
  createDbCalls = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

function stdoutText(): string {
  const calls = stdoutSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

function stderrText(): string {
  const calls = stderrSpy.mock.calls as unknown as Array<[unknown]>;
  return calls.map((c) => String(c[0])).join('');
}

/** Production-shaped deps (same wiring as main.ts), recording every open. */
const deps: CuratorCliDeps = {
  createDb: (options) => {
    createDbCalls.push(options);
    if (options.dbPath === undefined) throw new Error('test deps require a dbPath');
    return createDatabase({ path: options.dbPath, readonly: options.readonly ?? false });
  },
};

/** Create the on-disk store and close it, so the sweep opens a quiesced file. */
function seed(build: (repo: MemoryRepository) => void): void {
  const db = createDatabase({ path: dbPath });
  try {
    build(new MemoryRepository(db));
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function seedBrainWithSecrets(): void {
  seed((repo) => {
    repo.insert(
      makeMemory({
        id: ID_PROSE,
        tenantId: TENANT,
        title: 'Migration runbook',
        category: 'reference',
        content: `Step 2.\nThe sudo password for the migration is \`${PROSE_VALUE}\`.`,
      }),
    );
    repo.insert(
      makeMemory({
        id: ID_URL,
        tenantId: TENANT,
        title: 'Old database wiring',
        category: 'architecture',
        lifecycle: 'archived',
        content: `engine = "dialect+driver://svc_app:${URL_VALUE}@db.internal:5432/app"`,
      }),
    );
    repo.insert(
      makeMemory({
        id: ID_TITLE,
        tenantId: TENANT,
        title: `the deploy password is \`${TITLE_VALUE}\``,
        category: 'decision',
        lifecycle: 'deprecated',
        content: 'Body is clean.',
      }),
    );
    repo.insert(
      makeMemory({
        id: ID_CLEAN,
        tenantId: TENANT,
        title: 'Result type convention',
        content: 'Use Result<T, E> for all fallible operations.',
      }),
    );
    repo.insert(
      makeMemory({
        id: ID_PLACEHOLDER,
        tenantId: TENANT,
        title: 'SQLAlchemy URL format',
        content: 'URLs look like dialect+driver://username:password@host:port/database',
      }),
    );
    repo.insert(
      makeMemory({
        id: ID_OTHER_TENANT,
        tenantId: OTHER_TENANT,
        title: 'Another tenant',
        content: `The root password was "${OTHER_TENANT_VALUE}" last quarter.`,
      }),
    );
  });
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function expectNoSecretText(text: string): void {
  for (const value of [PROSE_VALUE, URL_VALUE, TITLE_VALUE, OTHER_TENANT_VALUE]) {
    expect(text).not.toContain(value);
  }
  // Content is never printed either — only id / title / lifecycle / category / patterns.
  expect(text).not.toContain('svc_app');
  expect(text).not.toContain('Step 2');
}

// ---------------------------------------------------------------------------
// Argument / usage errors
// ---------------------------------------------------------------------------

describe('dispatch secret-sweep — argument errors', () => {
  it('exits 2 on an unknown flag', async () => {
    const rc = await dispatch(['secret-sweep', '--bogus'], deps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/secret-sweep: unknown flag: --bogus/);
    expect(createDbCalls).toEqual([]);
  });

  it('exits 2 when --db is omitted (refuses the implicit in-memory store)', async () => {
    const rc = await dispatch(['secret-sweep', '--tenant', TENANT], deps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/missing required --db <path>/);
    expect(createDbCalls).toEqual([]);
  });

  it('exits 2 when --tenant is omitted', async () => {
    const rc = await dispatch(['secret-sweep', '--db', dbPath], deps);
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/missing required --tenant <id>/);
    expect(createDbCalls).toEqual([]);
  });

  it('exits 2 when --pattern has no value', async () => {
    const rc = await dispatch(
      ['secret-sweep', '--db', dbPath, '--tenant', TENANT, '--pattern'],
      deps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/--pattern requires a value/);
  });

  it('exits 2 on an unknown --pattern id instead of reporting a clean brain', async () => {
    const rc = await dispatch(
      ['secret-sweep', '--db', dbPath, '--tenant', TENANT, '--pattern', 'prose-pasword'],
      deps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(
      /unknown --pattern id\(s\): prose-pasword \(known: .*prose-password/,
    );
    expect(createDbCalls).toEqual([]);
  });

  it('lists the subcommand and its options in help text', async () => {
    const rc = await dispatch(['help'], deps);
    expect(rc).toBe(0);
    expect(stdoutText()).toMatch(/secret-sweep --db <path> --tenant <id>/);
    expect(stdoutText()).toMatch(/Options for 'secret-sweep':/);
  });
});

// ---------------------------------------------------------------------------
// I/O failures
// ---------------------------------------------------------------------------

describe('dispatch secret-sweep — I/O failures', () => {
  it('exits 1 when the database cannot be opened read-only', async () => {
    const missing = join(dir, 'does-not-exist.db');
    const rc = await dispatch(['secret-sweep', '--db', missing, '--tenant', TENANT], deps);
    expect(rc).toBe(1);
    expect(stderrText()).toMatch(/secret-sweep: cannot open .*does-not-exist\.db read-only: /);
  });

  it('exits 1 with a string message when the opener throws a non-Error', async () => {
    const rc = await dispatch(['secret-sweep', '--db', dbPath, '--tenant', TENANT], {
      createDb: () => {
        throw 'locked';
      },
    });
    expect(rc).toBe(1);
    expect(stderrText()).toMatch(/read-only: locked\n$/);
  });

  it('exits 1 and still closes the db when the sweep query fails', async () => {
    const close = vi.fn();
    const rc = await dispatch(['secret-sweep', '--db', dbPath, '--tenant', TENANT], {
      createDb: () =>
        ({
          prepare: () => {
            throw new Error('no such table: curated_memories');
          },
          close,
        }) as unknown as ReturnType<CuratorCliDeps['createDb']>,
    });
    expect(rc).toBe(1);
    expect(stderrText()).toMatch(/secret-sweep: sweep failed: no such table: curated_memories\n$/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports a non-Error sweep failure and tolerates a throwing close', async () => {
    const rc = await dispatch(['secret-sweep', '--db', dbPath, '--tenant', TENANT], {
      createDb: () =>
        ({
          prepare: () => {
            throw 'boom';
          },
          close: () => {
            throw new Error('close failed');
          },
        }) as unknown as ReturnType<CuratorCliDeps['createDb']>,
    });
    expect(rc).toBe(1);
    expect(stderrText()).toMatch(/sweep failed: boom\n$/);
  });
});

// ---------------------------------------------------------------------------
// Clean store
// ---------------------------------------------------------------------------

describe('dispatch secret-sweep — clean brain', () => {
  beforeEach(() => {
    seed((repo) => {
      repo.insert(makeMemory({ id: ID_CLEAN, tenantId: TENANT }));
      repo.insert(
        makeMemory({
          id: ID_PLACEHOLDER,
          tenantId: TENANT,
          content: 'URLs look like dialect+driver://username:password@host:port/database',
        }),
      );
    });
  });

  it('exits 0 and prints the scanned count', async () => {
    const rc = await dispatch(['secret-sweep', '--db', dbPath, '--tenant', TENANT], deps);
    expect(rc).toBe(0);
    expect(stdoutText()).toBe(
      'secret sweep OK\n' +
        `Tenant:           ${TENANT}\n` +
        'Memories scanned: 2 (every lifecycle state)\n' +
        'Scope:            all patterns\n',
    );
    expect(stderrText()).toBe('');
  });

  it('emits a clean JSON envelope with --json', async () => {
    const rc = await dispatch(['secret-sweep', '--db', dbPath, '--tenant', TENANT, '--json'], deps);
    expect(rc).toBe(0);
    expect(JSON.parse(stdoutText())).toEqual({
      ok: true,
      tenantId: TENANT,
      scanned: 2,
      patternFilter: null,
      findingCount: 0,
      findings: [],
    });
  });

  it('exits 0 but warns when the tenant has no memories at all', async () => {
    const rc = await dispatch(['secret-sweep', '--db', dbPath, '--tenant', 'no-such-tenant'], deps);
    expect(rc).toBe(0);
    expect(stdoutText()).toMatch(/Memories scanned: 0 /);
    expect(stderrText()).toMatch(/warning: tenant "no-such-tenant" has no curated memories in /);
  });

  it('names the pattern scope when --pattern is given', async () => {
    const rc = await dispatch(
      ['secret-sweep', '--db', dbPath, '--tenant', TENANT, '--pattern', 'prose-password'],
      deps,
    );
    expect(rc).toBe(0);
    expect(stdoutText()).toMatch(/Scope: {12}patterns: prose-password\n/);
  });
});

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

describe('dispatch secret-sweep — findings', () => {
  beforeEach(() => {
    seedBrainWithSecrets();
  });

  it('exits 3 and reports id, title, lifecycle, category and pattern names only', async () => {
    const rc = await dispatch(['secret-sweep', '--db', dbPath, '--tenant', TENANT], deps);
    expect(rc).toBe(3);
    const err = stderrText();
    expect(err).toMatch(
      /^SECRETS_IN_BRAIN: 3 of 5 curated memories matched a secret pattern \(tenant team-alpha; all patterns\)\./,
    );
    expect(err).toContain(
      `  ${ID_PROSE}  lifecycle=active  category=reference\n` +
        '    title:    Migration runbook\n' +
        '    patterns: Password Stated in Prose\n',
    );
    expect(err).toContain(
      `  ${ID_URL}  lifecycle=archived  category=architecture\n` +
        '    title:    Old database wiring\n' +
        '    patterns: URL with Embedded Credentials\n',
    );
    expect(err).toContain(
      `  ${ID_TITLE}  lifecycle=deprecated  category=decision\n` +
        `    title:    ${WITHHELD_TITLE}\n` +
        '    patterns: Password Stated in Prose\n',
    );
    expect(err).not.toContain(ID_CLEAN);
    expect(err).not.toContain(ID_PLACEHOLDER);
    expect(err).not.toContain(ID_OTHER_TENANT);
    expect(stdoutText()).toBe('');
    expectNoSecretText(err);
  });

  it('emits the same findings as JSON with --json, still without matched text', async () => {
    const rc = await dispatch(['secret-sweep', '--db', dbPath, '--tenant', TENANT, '--json'], deps);
    expect(rc).toBe(3);
    const out = stdoutText();
    expect(JSON.parse(out)).toEqual({
      ok: false,
      tenantId: TENANT,
      scanned: 5,
      patternFilter: null,
      findingCount: 3,
      findings: [
        {
          id: ID_PROSE,
          title: 'Migration runbook',
          lifecycle: 'active',
          category: 'reference',
          patternIds: ['prose-password'],
          patterns: ['Password Stated in Prose'],
        },
        {
          id: ID_URL,
          title: 'Old database wiring',
          lifecycle: 'archived',
          category: 'architecture',
          patternIds: ['url-embedded-credentials'],
          patterns: ['URL with Embedded Credentials'],
        },
        {
          id: ID_TITLE,
          title: WITHHELD_TITLE,
          lifecycle: 'deprecated',
          category: 'decision',
          patternIds: ['prose-password'],
          patterns: ['Password Stated in Prose'],
        },
      ],
    });
    expect(stderrText()).toBe('');
    expectNoSecretText(out);
  });

  it('narrows the report to the requested --pattern ids', async () => {
    const rc = await dispatch(
      [
        'secret-sweep',
        '--db',
        dbPath,
        '--tenant',
        TENANT,
        '--pattern',
        'url-embedded-credentials',
        '--json',
      ],
      deps,
    );
    expect(rc).toBe(3);
    const envelope = JSON.parse(stdoutText()) as {
      patternFilter: string[];
      findings: Array<{ id: string }>;
    };
    expect(envelope.patternFilter).toEqual(['url-embedded-credentials']);
    expect(envelope.findings.map((f) => f.id)).toEqual([ID_URL]);
  });

  it('exits 0 when the only requested pattern has no hits', async () => {
    const rc = await dispatch(
      ['secret-sweep', '--db', dbPath, '--tenant', TENANT, '--pattern', 'aws-key'],
      deps,
    );
    expect(rc).toBe(0);
  });

  it('is tenant-scoped: another tenant is swept separately', async () => {
    const rc = await dispatch(
      ['secret-sweep', '--db', dbPath, '--tenant', OTHER_TENANT, '--json'],
      deps,
    );
    expect(rc).toBe(3);
    const envelope = JSON.parse(stdoutText()) as {
      scanned: number;
      findings: Array<{ id: string }>;
    };
    expect(envelope.scanned).toBe(1);
    expect(envelope.findings.map((f) => f.id)).toEqual([ID_OTHER_TENANT]);
  });

  it('opens the store READ-ONLY and leaves the file byte-identical', async () => {
    const before = sha256(dbPath);
    const rc = await dispatch(['secret-sweep', '--db', dbPath, '--tenant', TENANT], deps);
    expect(rc).toBe(3);
    expect(createDbCalls).toEqual([{ dbPath, readonly: true }]);
    expect(sha256(dbPath)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// sweepSecrets core
// ---------------------------------------------------------------------------

describe('sweepSecrets', () => {
  it('cannot write through the handle the CLI gives it', () => {
    seedBrainWithSecrets();
    const db = createDatabase({ path: dbPath, readonly: true });
    try {
      expect(() => db.prepare('DELETE FROM curated_memories').run()).toThrow(/readonly/i);
      expect(sweepSecrets(db, TENANT).scanned).toBe(5);
    } finally {
      db.close();
    }
  });

  it('treats an empty patternIds list as "every pattern"', () => {
    seedBrainWithSecrets();
    const db = createDatabase({ path: dbPath, readonly: true });
    try {
      const report = sweepSecrets(db, TENANT, { patternIds: [] });
      expect(report.patternFilter).toBeNull();
      expect(report.findings).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it('counts an encoded-wrapped hit under its base pattern id', () => {
    // base64 of a synthetic AWS-key-shaped id; the scanner reports it as
    // `base64-wrapped:aws-key`, which a `--pattern aws-key` filter must keep.
    const wrapped = Buffer.from('AKIAIOSFODNN7EXAMPLE', 'utf8').toString('base64');
    seed((repo) => {
      repo.insert(makeMemory({ id: ID_PROSE, tenantId: TENANT, content: `blob ${wrapped} end` }));
    });
    const db = createDatabase({ path: dbPath, readonly: true });
    try {
      const report = sweepSecrets(db, TENANT, { patternIds: ['aws-key'] });
      expect(report.findings.map((f) => f.patternIds)).toEqual([['base64-wrapped:aws-key']]);
      expect(sweepSecrets(db, TENANT, { patternIds: ['jwt'] }).findings).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('merges and sorts pattern ids found in both title and content', () => {
    seed((repo) => {
      repo.insert(
        makeMemory({
          id: ID_PROSE,
          tenantId: TENANT,
          title: `the deploy password is \`${TITLE_VALUE}\``,
          content: `sftp://ops:${URL_VALUE}@files.internal and the password is \`${PROSE_VALUE}\``,
        }),
      );
    });
    const db = createDatabase({ path: dbPath, readonly: true });
    try {
      expect(sweepSecrets(db, TENANT).findings).toEqual([
        {
          id: ID_PROSE,
          title: WITHHELD_TITLE,
          lifecycle: 'active',
          category: 'pattern',
          patternIds: ['prose-password', 'url-embedded-credentials'],
          patterns: ['Password Stated in Prose', 'URL with Embedded Credentials'],
        },
      ]);
    } finally {
      db.close();
    }
  });
});
