/**
 * Tests for `curator-cli batch-transition` (bead 5kw.2): the receipted batch
 * lifecycle-transition command. Covers the refusal patterns (mandatory --db,
 * at-least-one-criterion, --to superseded, malformed ids file), dry-run
 * read-only semantics, the per-memory one-transaction-one-receipt contract,
 * criteria matching (source / category / imported-before / ids-file), and
 * skipped-illegal reporting.
 *
 * Uses a FILE-backed database (the production wiring) so re-opening the store
 * after dispatch proves what was durably written.
 *
 * @module __tests__/cli-batch-transition.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuditRepository,
  MemoryRepository,
  createDatabase,
  createTestDatabase,
} from '@qmd-team-intent-kb/store';
import { makeMemory, DEFAULT_TENANT } from '@qmd-team-intent-kb/test-fixtures';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, type CuratorCliDeps } from '../cli.js';

let dir: string;
let dbPath: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

/** Production-shaped deps: file path → real database, honoring readonly. */
const fileDeps: CuratorCliDeps = {
  createDb: ({ dbPath: p, readonly }) =>
    p !== undefined
      ? createDatabase({ path: p, readonly: readonly ?? false })
      : createTestDatabase(),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cli-batch-transition-'));
  dbPath = join(dir, 'teamkb.db');
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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

/** Seed memories into the file-backed store and return them. */
function seed(...memories: Partial<CuratedMemory>[]): CuratedMemory[] {
  const db = createDatabase({ path: dbPath });
  try {
    const repo = new MemoryRepository(db);
    return memories.map((overrides) => {
      const memory = makeMemory(overrides);
      repo.insert(memory);
      return memory;
    });
  } finally {
    db.close();
  }
}

/** Re-open the store read-only for assertions after dispatch has run. */
function inspect<T>(
  fn: (repos: { memoryRepo: MemoryRepository; auditRepo: AuditRepository }) => T,
): T {
  const db = createDatabase({ path: dbPath, readonly: true });
  try {
    return fn({ memoryRepo: new MemoryRepository(db), auditRepo: new AuditRepository(db) });
  } finally {
    db.close();
  }
}

const BASE = ['batch-transition', '--db', '', '--tenant', DEFAULT_TENANT];
function args(...rest: string[]): string[] {
  const a = [...BASE];
  a[2] = dbPath;
  return [...a, ...rest];
}

describe('batch-transition — refusal patterns', () => {
  it('refuses a missing --db (no implicit in-memory store)', async () => {
    const rc = await dispatch(
      [
        'batch-transition',
        '--tenant',
        't',
        '--to',
        'deprecated',
        '--reason',
        'r',
        '--actor',
        'a',
        '--source',
        'import',
      ],
      fileDeps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/refusing to transition an implicit in-memory store/);
  });

  it('refuses a criterion-less invocation (tenant-wide mass transition)', async () => {
    const rc = await dispatch(
      args('--to', 'deprecated', '--reason', 'r', '--actor', 'a'),
      fileDeps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/at least one criterion is required/);
  });

  it('refuses --to superseded (needs a per-memory supersededBy)', async () => {
    const rc = await dispatch(
      args('--to', 'superseded', '--reason', 'r', '--actor', 'a', '--source', 'import'),
      fileDeps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/superseded is not batchable/);
  });

  it('refuses an invalid --source / --category / --imported-before', async () => {
    let rc = await dispatch(
      args('--to', 'deprecated', '--reason', 'r', '--actor', 'a', '--source', 'bogus'),
      fileDeps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/invalid --source "bogus"/);

    rc = await dispatch(
      args('--to', 'deprecated', '--reason', 'r', '--actor', 'a', '--category', 'bogus'),
      fileDeps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/invalid --category "bogus"/);

    rc = await dispatch(
      args(
        '--to',
        'deprecated',
        '--reason',
        'r',
        '--actor',
        'a',
        '--imported-before',
        'not-a-date',
      ),
      fileDeps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/invalid --imported-before/);
  });

  it('refuses missing --reason / --actor', async () => {
    let rc = await dispatch(
      args('--to', 'deprecated', '--actor', 'a', '--source', 'import'),
      fileDeps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/missing required flag: --reason/);

    rc = await dispatch(
      args('--to', 'deprecated', '--reason', 'r', '--source', 'import'),
      fileDeps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/missing required flag: --actor/);
  });

  it('refuses an ids file with a malformed line (never silently drops it)', async () => {
    const idsFile = join(dir, 'ids.txt');
    await writeFile(idsFile, '# sweep targets\nnot-a-uuid\n', 'utf8');
    const rc = await dispatch(
      args('--to', 'deprecated', '--reason', 'r', '--actor', 'a', '--ids-file', idsFile),
      fileDeps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toMatch(/line 2 is not a UUID/);
  });
});

describe('batch-transition — dry-run', () => {
  it('reports what would transition and writes NOTHING (db opened read-only)', async () => {
    const [a, b] = seed(
      { source: 'import', lifecycle: 'active' },
      { source: 'import', lifecycle: 'active' },
    );
    seed({ source: 'claude_session', lifecycle: 'active' });

    const rc = await dispatch(
      args(
        '--to',
        'deprecated',
        '--reason',
        'sweep',
        '--actor',
        'jeremy',
        '--source',
        'import',
        '--dry-run',
        '--json',
      ),
      fileDeps,
    );
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['dry_run']).toBe(true);
    expect(parsed['matched']).toBe(2);
    expect(parsed['transitioned']).toBe(2);
    const transitions = parsed['transitions'] as Array<Record<string, unknown>>;
    expect(new Set(transitions.map((t) => t['memory_id']))).toEqual(new Set([a!.id, b!.id]));
    // Dry-run receipts are honestly null — no audit event was written.
    expect(transitions.every((t) => t['audit_event_id'] === null)).toBe(true);

    inspect(({ memoryRepo, auditRepo }) => {
      expect(memoryRepo.findByTenant(DEFAULT_TENANT).every((m) => m.lifecycle === 'active')).toBe(
        true,
      );
      expect(auditRepo.findByTenant(DEFAULT_TENANT)).toEqual([]);
    });
  });
});

describe('batch-transition — receipted transitions', () => {
  it('transitions matched rows with ONE audit receipt per memory', async () => {
    const [a, b] = seed(
      { source: 'import', lifecycle: 'active' },
      { source: 'import', lifecycle: 'active' },
    );
    const [untouched] = seed({ source: 'claude_session', lifecycle: 'active' });

    const rc = await dispatch(
      args(
        '--to',
        'deprecated',
        '--reason',
        'gcp junk sweep',
        '--actor',
        'jeremy',
        '--source',
        'import',
        '--json',
      ),
      fileDeps,
    );
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['transitioned']).toBe(2);

    inspect(({ memoryRepo, auditRepo }) => {
      // Lifecycle flipped for the matched rows only.
      const rows = memoryRepo.findByTenant(DEFAULT_TENANT);
      expect(rows.find((m) => m.id === a!.id)?.lifecycle).toBe('deprecated');
      expect(rows.find((m) => m.id === b!.id)?.lifecycle).toBe('deprecated');
      expect(rows.find((m) => m.id === untouched!.id)?.lifecycle).toBe('active');

      // One receipt PER memory (never one giant batch receipt), each with the
      // house action mapping, the actor, the reason, and the batch criteria.
      for (const m of [a!, b!]) {
        const events = auditRepo.findByMemory(m.id);
        expect(events.length).toBe(1);
        const event = events[0]!;
        expect(event.action).toBe('demoted');
        expect(event.actor).toEqual({ type: 'human', id: 'jeremy' });
        expect(event.reason).toBe('gcp junk sweep');
        const details = event.details as Record<string, unknown>;
        expect(details['from']).toBe('active');
        expect(details['to']).toBe('deprecated');
        expect(details['batch']).toBe(true);
        expect(details['criteria']).toEqual({ source: 'import' });
      }
      // Distinct receipts.
      const ids = [a!, b!].map((m) => auditRepo.findByMemory(m.id)[0]!.id);
      expect(new Set(ids).size).toBe(2);
      // The untouched row got no receipt.
      expect(auditRepo.findByMemory(untouched!.id)).toEqual([]);
    });
  });

  it('skips rows whose current lifecycle cannot legally reach the target', async () => {
    const [archived] = seed({ source: 'import', lifecycle: 'archived' });
    const [active] = seed({ source: 'import', lifecycle: 'active' });

    const rc = await dispatch(
      args('--to', 'deprecated', '--reason', 'r', '--actor', 'a', '--source', 'import', '--json'),
      fileDeps,
    );
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['transitioned']).toBe(1);
    const skipped = parsed['skipped'] as Array<Record<string, unknown>>;
    expect(skipped.length).toBe(1);
    expect(skipped[0]!['memory_id']).toBe(archived!.id);
    expect(skipped[0]!['why']).toMatch(/not a legal lifecycle transition/);

    inspect(({ memoryRepo }) => {
      const rows = memoryRepo.findByTenant(DEFAULT_TENANT);
      expect(rows.find((m) => m.id === archived!.id)?.lifecycle).toBe('archived');
      expect(rows.find((m) => m.id === active!.id)?.lifecycle).toBe('deprecated');
    });
  });

  it('matches on --imported-before (strictly before, against promoted_at)', async () => {
    const [old] = seed({
      source: 'import',
      lifecycle: 'active',
      promotedAt: '2026-07-01T00:00:00.000Z',
    });
    const [recent] = seed({
      source: 'import',
      lifecycle: 'active',
      promotedAt: '2026-07-18T00:00:00.000Z',
    });

    const rc = await dispatch(
      args(
        '--to',
        'archived',
        '--reason',
        'r',
        '--actor',
        'a',
        '--imported-before',
        '2026-07-10T00:00:00.000Z',
        '--json',
      ),
      fileDeps,
    );
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['matched']).toBe(1);

    inspect(({ memoryRepo, auditRepo }) => {
      const rows = memoryRepo.findByTenant(DEFAULT_TENANT);
      expect(rows.find((m) => m.id === old!.id)?.lifecycle).toBe('archived');
      expect(rows.find((m) => m.id === recent!.id)?.lifecycle).toBe('active');
      expect(auditRepo.findByMemory(old!.id)[0]?.action).toBe('archived');
    });
  });

  it('AND-combines an ids file with other criteria, separating not-found from criteria-excluded', async () => {
    const [imported] = seed({ source: 'import', lifecycle: 'active' });
    const [session] = seed({ source: 'claude_session', lifecycle: 'active' });
    const unknownId = '00000000-0000-4000-8000-000000000000';

    const idsFile = join(dir, 'ids.txt');
    await writeFile(
      idsFile,
      `# sweep targets\n${imported!.id}\n${session!.id}\n${unknownId}\n\n`,
      'utf8',
    );

    const rc = await dispatch(
      args(
        '--to',
        'deprecated',
        '--reason',
        'r',
        '--actor',
        'a',
        '--ids-file',
        idsFile,
        '--source',
        'import',
        '--json',
      ),
      fileDeps,
    );
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    // Only the import-source id both appears in the file AND matches --source.
    expect(parsed['transitioned']).toBe(1);
    // The two buckets are distinct (PR #309 finding 2): the session id EXISTS in
    // the tenant but was filtered by --source (criteria_excluded); the unknown id
    // is genuinely not in the corpus (not_found). An operator can tell a
    // correctly-filtered id from a typo.
    expect(parsed['not_found_ids']).toEqual([unknownId]);
    expect(parsed['criteria_excluded_ids']).toEqual([session!.id.toLowerCase()]);

    inspect(({ memoryRepo }) => {
      const rows = memoryRepo.findByTenant(DEFAULT_TENANT);
      expect(rows.find((m) => m.id === imported!.id)?.lifecycle).toBe('deprecated');
      expect(rows.find((m) => m.id === session!.id)?.lifecycle).toBe('active');
    });
  });

  it('reports already-in-target rows as skipped no-ops', async () => {
    seed({ source: 'import', lifecycle: 'deprecated' });
    const rc = await dispatch(
      args('--to', 'deprecated', '--reason', 'r', '--actor', 'a', '--source', 'import', '--json'),
      fileDeps,
    );
    expect(rc).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as Record<string, unknown>;
    expect(parsed['transitioned']).toBe(0);
    const skipped = parsed['skipped'] as Array<Record<string, unknown>>;
    expect(skipped[0]!['why']).toBe('already in target state');
  });

  it('reactivates deprecated rows with --to active (category-scoped)', async () => {
    const [deprecated] = seed({ source: 'import', category: 'reference', lifecycle: 'deprecated' });
    const rc = await dispatch(
      args('--to', 'active', '--reason', 'restore', '--actor', 'a', '--category', 'reference'),
      fileDeps,
    );
    expect(rc).toBe(0);
    expect(stdoutText()).toMatch(/Transitioned: 1/);
    inspect(({ memoryRepo, auditRepo }) => {
      expect(memoryRepo.findByTenant(DEFAULT_TENANT)[0]?.lifecycle).toBe('active');
      expect(auditRepo.findByMemory(deprecated!.id)[0]?.action).toBe('promoted');
    });
  });
});
