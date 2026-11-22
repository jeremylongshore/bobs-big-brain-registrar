import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '@qmd-team-intent-kb/store';
import {
  AuditRepository,
  createDatabase,
  MemoryRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import {
  auditEventSnapshotDigest,
  ESTATE_STALENESS_RULES,
  inspectRecoveryStore,
  reviewedStalenessDigest,
  reviewedStalenessSnapshot,
  stalenessDigest,
} from '@qmd-team-intent-kb/curator';
import type { ReviewedStalenessManifest, StalenessRule } from '@qmd-team-intent-kb/curator';
import { makeMemory } from './fixtures.js';
import { buildApp } from '../app.js';
import type { TokenRecord } from '../auth/token-registry.js';

const source = Buffer.from('Synthetic retirement decision; not live approval.');
const sourceHash = createHash('sha256').update(source).digest('hex');
const token: TokenRecord = {
  token: 'fixture-reviewer-token',
  actor: 'fixture-reviewer',
  role: 'admin',
  owner: true,
  tenants: ['tenant-1'],
};
let root: string;
let db: Database.Database;
let app: FastifyInstance | undefined;
let approvalFile: string;
let manifest: ReviewedStalenessManifest;
let rule: StalenessRule;
let approval: Record<string, unknown>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'staleness-api-'));
  db = createDatabase({ path: join(root, 'teamkb.db') });
  chmodSync(db.name, 0o600);
  const memory = makeMemory({
    tenantId: 'tenant-1',
    content: 'Use BigQuery for this estate warehouse.',
  });
  new MemoryRepository(db).insert(memory);
  rule = {
    ...structuredClone(ESTATE_STALENESS_RULES[0]!),
    id: 'fixture-rule',
    authority: {
      ...ESTATE_STALENESS_RULES[0]!.authority!,
      sources: [
        {
          repository: 'fixture/estate',
          path: 'decision.md',
          revision: 'a'.repeat(40),
          sha256: sourceHash,
          visibility: 'private',
          locator: 'synthetic fixture',
        },
      ],
    },
  };
  manifest = {
    version: 1,
    runId: randomUUID(),
    tenantId: 'tenant-1',
    operation: 'deprecate',
    actor: { type: 'human', id: token.actor },
    role: 'owner',
    reason: 'Private synthetic review reason',
    reviewedAt: '2020-01-01T00:00:00.000Z',
    selections: [
      {
        ...reviewedStalenessSnapshot(db, memory.id),
        ruleId: rule.id,
        ruleDigest: stalenessDigest(rule),
        scope: 'intent-solutions-estate',
        scopeEvidenceRef: 'fixture://scope',
      },
    ],
  };
  approvalFile = join(root, 'approval.json');
  approval = {
    version: 1,
    manifestDigest: reviewedStalenessDigest(manifest),
    actorId: token.actor,
    role: 'owner',
    tenantId: 'tenant-1',
    expiresAt: '2099-01-01T00:00:00.000Z',
    store: inspectRecoveryStore(db.name),
    sources: [{ sha256: sourceHash, base64: source.toString('base64') }],
  };
  saveApproval();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function saveApproval() {
  writeFileSync(approvalFile, JSON.stringify(approval), { mode: 0o600 });
}
function start(tokens: TokenRecord[] = [token], enabled = true, lockTimeoutMs = 0) {
  app = buildApp({
    db,
    silent: true,
    tokens,
    reviewedStaleness: enabled ? { approvalFile, rules: [rule], lockTimeoutMs } : undefined,
  });
  return app;
}
function request(body: unknown = manifest, bearer: string | null = token.token) {
  return app!.inject({
    method: 'POST',
    url: '/api/memories/reviewed-staleness',
    payload: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
  });
}
function snapshot() {
  return {
    memories: db.prepare('SELECT * FROM curated_memories ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM audit_events ORDER BY seq').all(),
  };
}

describe('authenticated reviewed staleness HTTP caller', () => {
  it('settles only approved selection and replays without duplicate receipts', async () => {
    start();
    const first = await request();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      ok: true,
      committed: true,
      appliedNow: true,
      settlement: { replay: false },
      postcommit: { anchors: 'not_verified', index: 'not_verified' },
    });
    const after = snapshot();
    const replay = await request();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      committed: true,
      appliedNow: false,
      settlement: { replay: true },
    });
    expect(snapshot()).toEqual(after);
    expect(new MemoryRepository(db).findById(manifest.selections[0]!.memoryId)?.lifecycle).toBe(
      'deprecated',
    );
    expect(verifyAuditChain(new AuditRepository(db))).toMatchObject({
      breaks: [],
      unverifiedRows: 0,
    });
    expect(first.body).not.toContain(manifest.reason);
    expect(first.body).not.toContain(source.toString());
    expect(first.body).not.toContain(root);
  });
  it('is absent unless configured and refuses missing bearer when configured', async () => {
    start([token], false);
    expect((await request()).statusCode).toBe(404);
    await app!.close();
    start();
    expect((await request(manifest, null)).statusCode).toBe(401);
  });
  it.each([
    ['dev', []],
    ['shared', [{ ...token, actor: 'shared' }]],
    ['member', [{ ...token, role: 'member' as const }]],
    ['agent', [{ ...token, agent: true }]],
    ['legacy agent', [{ ...token, actor: 'teamkb-review-agent' }]],
    ['other actor', [{ ...token, actor: 'other-reviewer' }]],
    ['other role', [{ ...token, owner: false }]],
    ['other tenant', [{ ...token, tenants: ['other'] }]],
  ])('refuses %s authority without writes', async (_name, tokens) => {
    start(tokens);
    const before = snapshot();
    expect((await request()).statusCode).toBe(403);
    expect(snapshot()).toEqual(before);
  });
  it.each(['manifestDigest', 'actorId', 'role', 'tenantId', 'expiresAt'])(
    'refuses changed approval %s',
    async (field) => {
      approval[field] =
        field === 'manifestDigest'
          ? '0'.repeat(64)
          : field === 'expiresAt'
            ? '2000-01-01T00:00:00.000Z'
            : 'other';
      saveApproval();
      start();
      const before = snapshot();
      const result = await request();
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(snapshot()).toEqual(before);
      expect(result.body).not.toContain(root);
    },
  );
  it('refuses a client-supplied store or approval path', async () => {
    start();
    const before = snapshot();
    expect((await request({ ...manifest, databasePath: db.name, approvalFile })).statusCode).toBe(
      403,
    );
    expect(snapshot()).toEqual(before);
  });
  it('refuses missing source bytes and physical-store witness changes', async () => {
    approval.sources = [];
    saveApproval();
    start();
    const before = snapshot();
    expect((await request()).statusCode).toBe(409);
    expect(snapshot()).toEqual(before);
    approval.sources = [{ sha256: sourceHash, base64: source.toString('base64') }];
    approval.store = { ...inspectRecoveryStore(db.name), databaseInode: 0 };
    saveApproval();
    expect((await request()).statusCode).toBe(409);
    expect(snapshot()).toEqual(before);
  });
});

// A separate OS process owns the real flock while the synchronous caller waits.
async function holdLock(action = '', delayMs = 700) {
  const child = spawn(
    '/usr/bin/flock',
    [
      '--exclusive',
      join(root, '.write.lock'),
      process.execPath,
      '-e',
      `const fs = require('node:fs'); process.stdout.write('locked\\n'); setTimeout(() => { ${action} }, ${delayMs});`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  return { exited };
}

describe('reviewed staleness failure boundaries', () => {
  it('rechecks token expiry after blocking on the physical lock', async () => {
    start([{ ...token, expiresAt: new Date(Date.now() + 2000).toISOString() }], true, 5000);
    const before = snapshot();
    const { exited } = await holdLock('', 2500);
    const result = await request();
    await exited;
    expect(result.statusCode).toBe(403);
    expect(result.json()).toMatchObject({ committed: false, failedStage: 'authorization' });
    expect(snapshot()).toEqual(before);
  });
  it('reports a committed write truthfully and releases the lock when close fails', async () => {
    const original = store.openExistingDatabase;
    vi.spyOn(store, 'openExistingDatabase').mockImplementation((options) => {
      const connection = original(options);
      const close = connection.close.bind(connection);
      connection.close = () => {
        close();
        throw new Error('private cleanup detail');
      };
      return connection;
    });
    start();
    const result = await request();
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({
      committed: true,
      appliedNow: true,
      failedStage: 'finalization',
    });
    expect(result.body).not.toContain('private cleanup detail');
    expect(new MemoryRepository(db).findById(manifest.selections[0]!.memoryId)?.lifecycle).toBe(
      'deprecated',
    );
    expect(
      spawnSync('/usr/bin/flock', ['--nonblock', join(root, '.write.lock'), 'true']).status,
    ).toBe(0);
  });

  it('refuses actual flock contention, then succeeds after release', async () => {
    start();
    const before = snapshot();
    const { exited } = await holdLock();
    expect((await request()).statusCode).toBe(409);
    expect(snapshot()).toEqual(before);
    await exited;
    expect((await request()).statusCode).toBe(200);
  });
  it('refuses lock inode substitution during the wait', async () => {
    start([token], true, 2500);
    const before = snapshot();
    const path = JSON.stringify(join(root, '.write.lock'));
    const { exited } = await holdLock(
      `fs.renameSync(${path}, ${path} + '.old'); fs.writeFileSync(${path}, '', {mode: 384});`,
    );
    expect((await request()).statusCode).toBe(409);
    await exited;
    expect(snapshot()).toEqual(before);
  });
  it('refuses withdrawn approval after waiting for the lock', async () => {
    start([token], true, 2500);
    const before = snapshot();
    const { exited } = await holdLock(`fs.unlinkSync(${JSON.stringify(approvalFile)});`);
    expect((await request()).statusCode).toBe(409);
    await exited;
    expect(snapshot()).toEqual(before);
  });
  it('refuses replaced database without modifying its replacement', async () => {
    start();
    const before = snapshot();
    renameSync(db.name, db.name + '.old');
    writeFileSync(db.name, 'unrelated fixture', { mode: 0o600 });
    expect((await request()).statusCode).toBe(409);
    expect(readFileSync(db.name, 'utf8')).toBe('unrelated fixture');
    expect(snapshot()).toEqual(before);
  });
  it('refuses captured source bytes that do not match their approved hash', async () => {
    approval.sources = [{ sha256: sourceHash, base64: Buffer.from('changed').toString('base64') }];
    saveApproval();
    start();
    const before = snapshot();
    expect((await request()).statusCode).toBe(409);
    expect(snapshot()).toEqual(before);
  });
  it('refuses a broken audit chain without rewriting it', async () => {
    start();
    expect((await request()).statusCode).toBe(200);
    db.exec("UPDATE audit_events SET reason='tampered fixture'");
    const before = snapshot();
    expect((await request()).statusCode).toBe(409);
    expect(snapshot()).toEqual(before);
  });
  it('rolls back lifecycle and receipts when the run receipt fails', async () => {
    start();
    db.exec(
      "CREATE TRIGGER refuse_run BEFORE INSERT ON audit_events WHEN NEW.action='governed' BEGIN SELECT RAISE(ABORT, 'private fixture failure'); END",
    );
    const before = snapshot();
    const result = await request();
    expect(result.statusCode).toBe(409);
    expect(result.body).not.toContain('private fixture failure');
    expect(snapshot()).toEqual(before);
    db.exec('DROP TRIGGER refuse_run');
    expect((await request()).statusCode).toBe(200);
  });
  it('requires fresh reviewed approval to reverse and replays the reversal', async () => {
    start();
    expect((await request()).statusCode).toBe(200);
    const memoryId = manifest.selections[0]!.memoryId;
    const event = new AuditRepository(db)
      .findByMemoryAndTenant(memoryId, manifest.tenantId)
      .find((item) => item.action === 'demoted')!;
    manifest = {
      ...manifest,
      runId: randomUUID(),
      operation: 'reactivate',
      selections: [
        {
          ...manifest.selections[0]!,
          ...reviewedStalenessSnapshot(db, memoryId),
          scope: 'external',
          deprecationReceipt: { id: event.id, snapshotDigest: auditEventSnapshotDigest(event) },
        },
      ],
    };
    expect((await request()).statusCode).toBe(403);
    approval.manifestDigest = reviewedStalenessDigest(manifest);
    saveApproval();
    expect((await request()).statusCode).toBe(200);
    expect(new MemoryRepository(db).findById(memoryId)?.lifecycle).toBe('active');
    const after = snapshot();
    expect((await request()).statusCode).toBe(200);
    expect(snapshot()).toEqual(after);
  });
});
