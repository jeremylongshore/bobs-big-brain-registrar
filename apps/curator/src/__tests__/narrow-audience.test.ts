/**
 * Governed audience narrowing (Epic K bead K3): the `narrowAudience` service
 * and `curator-cli narrow-audience`, on a FILE-backed SQLite store so
 * re-opening it proves what was durably written.
 *
 * @module __tests__/narrow-audience.test
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuditRepository,
  MemoryRepository,
  createDatabase,
  createTestDatabase,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { narrowAudience } from '../audience/narrow-audience.js';
import { dispatch, type CuratorCliDeps } from '../cli.js';
import { makeMemory, TENANT } from './fixtures.js';

let dir: string;
let dbPath: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let createDb: ReturnType<typeof vi.fn<CuratorCliDeps['createDb']>>;
let deps: CuratorCliDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'narrow-audience-'));
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
  rmSync(dir, { recursive: true, force: true });
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

const text = (spy: ReturnType<typeof vi.spyOn>): string =>
  (spy.mock.calls as unknown as Array<[unknown]>).map((c) => String(c[0])).join('');
const stdoutText = (): string => text(stdoutSpy);
const stderrText = (): string => text(stderrSpy);

const withAudience = (audience?: 'tenant' | 'admins' | 'owner'): CuratedMemory['metadata'] =>
  audience === undefined ? { filePaths: [], tags: [] } : { filePaths: [], tags: [], audience };

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

function inspect<T>(fn: (r: { memories: MemoryRepository; audit: AuditRepository }) => T): T {
  const db = createDatabase({ path: dbPath, readonly: true });
  try {
    return fn({ memories: new MemoryRepository(db), audit: new AuditRepository(db) });
  } finally {
    db.close();
  }
}

const fileSha = (): string => createHash('sha256').update(readFileSync(dbPath)).digest('hex');

function cli(...rest: string[]): string[] {
  return ['narrow-audience', '--db', dbPath, '--tenant', TENANT, ...rest];
}
const WHO = ['--actor', 'jeremy', '--reason', 'contains a customer contact'];

describe('narrowAudience service', () => {
  it('narrows and writes the receipt in one transaction', () => {
    const [memory] = seed({ metadata: withAudience() });
    const db = createDatabase({ path: dbPath });
    const memories = new MemoryRepository(db);
    const audit = new AuditRepository(db);

    const result = narrowAudience(
      {
        memoryId: memory!.id,
        tenantId: TENANT,
        to: 'admins',
        actor: 'jeremy',
        reason: 'contains a customer contact',
        now: '2026-10-04T12:00:00.000Z',
      },
      memories,
      audit,
    );

    expect(result).toMatchObject({ ok: true, from: 'tenant', to: 'admins' });
    const after = memories.findById(memory!.id)!;
    expect(after.metadata.audience).toBe('admins');
    expect(after.updatedAt).toBe('2026-10-04T12:00:00.000Z');
    // Narrowing changes audience only — never content, hash or lifecycle.
    expect(after.content).toBe(memory!.content);
    expect(after.contentHash).toBe(memory!.contentHash);
    expect(after.lifecycle).toBe(memory!.lifecycle);

    const events = audit.findByMemory(memory!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'audience_narrowed',
      actor: { type: 'human', id: 'jeremy' },
      reason: 'contains a customer contact',
      details: { from: 'tenant', to: 'admins' },
      timestamp: '2026-10-04T12:00:00.000Z',
    });
    expect(result.ok && result.auditEventId).toBe(events[0]!.id);
    expect(verifyAuditChain(audit).breaks).toEqual([]);
    db.close();
  });

  it('rolls the audience change back when the receipt cannot be written', () => {
    const [memory] = seed({ metadata: withAudience('tenant') });
    const db = createDatabase({ path: dbPath });
    const memories = new MemoryRepository(db);
    const audit = new AuditRepository(db);
    vi.spyOn(audit, 'insert').mockImplementation(() => {
      throw new Error('receipt write failed');
    });

    expect(() =>
      narrowAudience(
        { memoryId: memory!.id, tenantId: TENANT, to: 'owner', actor: 'jeremy', reason: 'r' },
        memories,
        audit,
      ),
    ).toThrow('receipt write failed');
    expect(memories.findById(memory!.id)!.metadata.audience).toBe('tenant');
    db.close();
  });

  it.each([
    ['admins', 'tenant', 'widening'],
    ['owner', 'admins', 'widening'],
    ['owner', 'tenant', 'widening'],
    ['admins', 'admins', 'same'],
    ['tenant', 'board', 'unknown_to'],
  ] as const)('refuses %s -> %s as %s and writes nothing', (from, to, code) => {
    const [memory] = seed({ metadata: withAudience(from) });
    const db = createDatabase({ path: dbPath });
    const memories = new MemoryRepository(db);
    const audit = new AuditRepository(db);
    const result = narrowAudience(
      { memoryId: memory!.id, tenantId: TENANT, to, actor: 'jeremy', reason: 'r' },
      memories,
      audit,
    );
    expect(result).toMatchObject({ ok: false, code });
    expect(memories.findById(memory!.id)!.metadata.audience).toBe(from);
    expect(audit.findByMemory(memory!.id)).toEqual([]);
    db.close();
  });

  it('refuses an unknown id, another tenant, a blank reason and a blank actor', () => {
    const [memory] = seed({ metadata: withAudience() });
    const db = createDatabase({ path: dbPath });
    const memories = new MemoryRepository(db);
    const audit = new AuditRepository(db);
    const base = { memoryId: memory!.id, tenantId: TENANT, to: 'owner', actor: 'j', reason: 'r' };

    expect(narrowAudience({ ...base, memoryId: randomUUID() }, memories, audit)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(narrowAudience({ ...base, tenantId: 'other' }, memories, audit)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(narrowAudience({ ...base, reason: '   ' }, memories, audit)).toMatchObject({
      ok: false,
      code: 'missing_reason',
    });
    expect(narrowAudience({ ...base, actor: '' }, memories, audit)).toMatchObject({
      ok: false,
      code: 'missing_actor',
    });
    expect(audit.findByMemory(memory!.id)).toEqual([]);
    db.close();
  });

  it('narrowing in two steps reaches owner and leaves two chained receipts', () => {
    const [memory] = seed({ metadata: withAudience() });
    const db = createDatabase({ path: dbPath });
    const memories = new MemoryRepository(db);
    const audit = new AuditRepository(db);
    const base = { memoryId: memory!.id, tenantId: TENANT, actor: 'jeremy', reason: 'r' };
    expect(narrowAudience({ ...base, to: 'admins' }, memories, audit).ok).toBe(true);
    expect(narrowAudience({ ...base, to: 'owner' }, memories, audit).ok).toBe(true);
    // The way back is closed.
    expect(narrowAudience({ ...base, to: 'tenant' }, memories, audit)).toMatchObject({
      code: 'widening',
    });
    expect(memories.findById(memory!.id)!.metadata.audience).toBe('owner');
    expect(audit.findByMemory(memory!.id).map((e) => e.details)).toEqual([
      { from: 'tenant', to: 'admins' },
      { from: 'admins', to: 'owner' },
    ]);
    expect(verifyAuditChain(audit).breaks).toEqual([]);
    db.close();
  });
});

describe('curator-cli narrow-audience', () => {
  it('narrows one memory by full id and reports the receipt', async () => {
    const [memory] = seed({ metadata: withAudience() });
    const rc = await dispatch(
      cli('--to', 'admins', '--memory-id', memory!.id, ...WHO, '--json'),
      deps,
    );
    expect(rc).toBe(0);
    const out = JSON.parse(stdoutText()) as {
      ok: boolean;
      narrowed: number;
      results: Array<{ status: string; from: string; to: string; audit_event_id: string }>;
    };
    expect(out).toMatchObject({ ok: true, dry_run: false, narrowed: 1, refused: 0 });
    expect(out.results[0]).toMatchObject({ status: 'narrowed', from: 'tenant', to: 'admins' });
    inspect(({ memories, audit }) => {
      expect(memories.findById(memory!.id)!.metadata.audience).toBe('admins');
      expect(audit.findByMemory(memory!.id)[0]!.id).toBe(out.results[0]!.audit_event_id);
    });
  });

  it('resolves a unique id prefix', async () => {
    const [memory] = seed({ metadata: withAudience() });
    const rc = await dispatch(
      cli('--to', 'owner', '--memory-id', memory!.id.slice(0, 8), ...WHO),
      deps,
    );
    expect(rc).toBe(0);
    expect(stdoutText()).toContain(`${memory!.id}  tenant -> owner`);
    expect(stdoutText()).toContain('reconcile');
    inspect(({ memories }) =>
      expect(memories.findById(memory!.id)!.metadata.audience).toBe('owner'),
    );
  });

  it('refuses an ambiguous prefix, a short prefix and a prefix that matches nothing', async () => {
    seed(
      { id: 'aaaaaaaa-0000-4000-8000-000000000001' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002' },
    );
    expect(await dispatch(cli('--to', 'owner', '--memory-id', 'aaaaaaaa', ...WHO), deps)).toBe(2);
    expect(stderrText()).toContain('more than one memory');
    expect(await dispatch(cli('--to', 'owner', '--memory-id', 'aaaa', ...WHO), deps)).toBe(2);
    expect(stderrText()).toContain('at least 8 hex characters');
    expect(await dispatch(cli('--to', 'owner', '--memory-id', 'bbbbbbbb', ...WHO), deps)).toBe(2);
    expect(stderrText()).toContain('no memory in tenant');
  });

  it('--ids-file narrows each memory in its own transaction with its own receipt', async () => {
    const [a, b, c] = seed(
      { metadata: withAudience() },
      { metadata: withAudience('admins') },
      { metadata: withAudience('owner') },
    );
    const missing = randomUUID();
    const idsFile = join(dir, 'ids.txt');
    writeFileSync(
      idsFile,
      `# narrowing batch\n${a!.id}\n\n${b!.id}\n${c!.id}\n${missing}\n${a!.id}\n`,
    );

    const rc = await dispatch(cli('--to', 'admins', '--ids-file', idsFile, ...WHO, '--json'), deps);
    expect(rc).toBe(3);
    const out = JSON.parse(stdoutText()) as {
      narrowed: number;
      refused: number;
      results: Array<{ memory_id: string; status: string; code?: string }>;
    };
    expect(out).toMatchObject({ ok: false, narrowed: 1, refused: 3 });
    const byId = new Map(out.results.map((r) => [r.memory_id, r]));
    expect(byId.get(a!.id)).toMatchObject({ status: 'narrowed' });
    expect(byId.get(b!.id)).toMatchObject({ status: 'refused', code: 'same' });
    expect(byId.get(c!.id)).toMatchObject({ status: 'refused', code: 'widening' });
    expect(byId.get(missing)).toMatchObject({ status: 'refused', code: 'not_found' });
    // A duplicated id in the file is applied once.
    expect(out.results).toHaveLength(4);
    inspect(({ memories, audit }) => {
      expect(memories.findById(a!.id)!.metadata.audience).toBe('admins');
      expect(memories.findById(b!.id)!.metadata.audience).toBe('admins');
      expect(memories.findById(c!.id)!.metadata.audience).toBe('owner');
      expect(audit.findByAction('audience_narrowed')).toHaveLength(1);
    });
  });

  it('--dry-run opens the store read-only and writes nothing', async () => {
    const [memory] = seed({ metadata: withAudience() });
    const before = fileSha();
    const rc = await dispatch(
      cli('--to', 'owner', '--memory-id', memory!.id, ...WHO, '--dry-run', '--json'),
      deps,
    );
    expect(rc).toBe(0);
    expect(createDb).toHaveBeenCalledWith({ dbPath, readonly: true });
    const out = JSON.parse(stdoutText()) as { dry_run: boolean; results: Array<object> };
    expect(out.dry_run).toBe(true);
    expect(out.results[0]).toMatchObject({ status: 'would_narrow', audit_event_id: null });
    expect(fileSha()).toBe(before);
    inspect(({ memories, audit }) => {
      expect(memories.findById(memory!.id)!.metadata.audience).toBeUndefined();
      expect(audit.findByAction('audience_narrowed')).toEqual([]);
    });
  });

  it('a live run is not opened read-only', async () => {
    const [memory] = seed({ metadata: withAudience() });
    await dispatch(cli('--to', 'owner', '--memory-id', memory!.id, ...WHO), deps);
    expect(createDb).toHaveBeenCalledWith({ dbPath, readonly: false });
  });

  it('refuses widening with a clear message and exit 3', async () => {
    const [memory] = seed({ metadata: withAudience('owner') });
    const rc = await dispatch(cli('--to', 'tenant', '--memory-id', memory!.id, ...WHO), deps);
    expect(rc).toBe(3);
    expect(stdoutText()).toContain('[widening]');
    expect(stdoutText()).toContain('Refusing to widen audience "owner" -> "tenant"');
    inspect(({ memories }) =>
      expect(memories.findById(memory!.id)!.metadata.audience).toBe('owner'),
    );
  });

  it('reports what the K3 rule recommends for the content, without applying it', async () => {
    const [memory] = seed({
      content: 'Escalate billing disputes to dana.whitfield@customer-example.com first.',
      metadata: withAudience(),
    });
    const rc = await dispatch(
      cli('--to', 'owner', '--memory-id', memory!.id, ...WHO, '--dry-run', '--json'),
      deps,
    );
    expect(rc).toBe(0);
    const out = JSON.parse(stdoutText()) as {
      results: Array<{ rule_recommended_audience: string }>;
    };
    expect(out.results[0]!.rule_recommended_audience).toBe('admins');
  });

  it.each([
    [['--to', 'admins', '--memory-id', 'x', '--actor', 'j'], 'missing required flag: --reason'],
    [['--to', 'admins', '--memory-id', 'x', '--reason', 'r'], 'missing required flag: --actor'],
    [['--memory-id', 'x', '--actor', 'j', '--reason', 'r'], 'missing required flag: --to'],
    [
      ['--to', 'admins', '--actor', 'j', '--reason', 'r'],
      'exactly one of --memory-id or --ids-file',
    ],
    [
      ['--to', 'admins', '--actor', 'j', '--reason', 'r', '--memory-id', 'x', '--ids-file', 'y'],
      'exactly one of --memory-id or --ids-file',
    ],
    [
      ['--to', 'admins', '--actor', 'j', '--reason', 'r', '--memory-id'],
      '--memory-id requires a value',
    ],
    [['--to', 'admins', '--actor', 'j', '--reason', 'r', '--bogus'], 'unknown flag: --bogus'],
  ])('usage error %#: exit 2 and nothing opened', async (rest, message) => {
    const rc = await dispatch(cli(...rest), deps);
    expect(rc).toBe(2);
    expect(stderrText()).toContain(message);
    expect(createDb).not.toHaveBeenCalled();
  });

  it('refuses a missing --db rather than using an in-memory store', async () => {
    const rc = await dispatch(
      ['narrow-audience', '--tenant', TENANT, '--to', 'owner', '--memory-id', 'x', ...WHO],
      deps,
    );
    expect(rc).toBe(2);
    expect(stderrText()).toContain('missing required flag: --db');
  });

  it('rejects a malformed or empty ids file as a usage error', async () => {
    seed({});
    const bad = join(dir, 'bad.txt');
    writeFileSync(bad, 'not-a-uuid\n');
    expect(await dispatch(cli('--to', 'owner', '--ids-file', bad, ...WHO), deps)).toBe(2);
    expect(stderrText()).toContain('line 1 is not a UUID');
    const empty = join(dir, 'empty.txt');
    writeFileSync(empty, '# nothing\n');
    expect(await dispatch(cli('--to', 'owner', '--ids-file', empty, ...WHO), deps)).toBe(2);
    expect(
      await dispatch(cli('--to', 'owner', '--ids-file', join(dir, 'nope'), ...WHO), deps),
    ).toBe(2);
    expect(stderrText()).toContain('cannot read --ids-file');
  });

  it('exits 1 when the store cannot be opened or a write fails', async () => {
    const [memory] = seed({ metadata: withAudience() });
    const broken: CuratorCliDeps = {
      createDb: () => {
        throw new Error('disk gone');
      },
    };
    expect(await dispatch(cli('--to', 'owner', '--memory-id', memory!.id, ...WHO), broken)).toBe(1);
    expect(stderrText()).toContain('disk gone');

    // A dry-run handle is read-only; forcing a live write through it fails -> exit 1.
    const readonlyDeps: CuratorCliDeps = {
      createDb: ({ dbPath: p }) => createDatabase({ path: p!, readonly: true }),
    };
    expect(
      await dispatch(
        cli('--to', 'owner', '--memory-id', memory!.id, ...WHO, '--json'),
        readonlyDeps,
      ),
    ).toBe(1);
    expect(stdoutText()).toContain('NARROW_AUDIENCE_FAILED');
    expect(
      await dispatch(cli('--to', 'owner', '--memory-id', memory!.id, ...WHO), readonlyDeps),
    ).toBe(1);
    expect(stderrText()).toContain('narrow-audience failed');
  });
});
