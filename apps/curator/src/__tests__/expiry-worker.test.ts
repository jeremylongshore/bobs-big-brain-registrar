import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import * as store from '@qmd-team-intent-kb/store';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  createDatabase,
} from '@qmd-team-intent-kb/store';
import { inspectRecoveryStore } from '../recovery/filesystem-boundary.js';
import { placeHold, expireHolds, recommendOnHold } from '../hold/hold.js';
import { runHoldExpiryWorker } from '../hold/expiry-worker.js';
import { makeCandidate, TENANT } from './fixtures.js';

let root: string;
let db: ReturnType<typeof createDatabase>;
let configPath: string;
let config: Record<string, unknown>;
let candidateId: string;
let calls: string;
let payload: string;
const NOW = '2026-11-01T00:00:00.000Z';
function repositories() {
  return {
    candidateRepo: new CandidateRepository(db),
    memoryRepo: new MemoryRepository(db),
    auditRepo: new AuditRepository(db),
  };
}
function save() {
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
}
function transport(body: string) {
  const executable = join(root, 'transport');
  const script = `#!${process.execPath}\nlet text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{const request=JSON.parse(text);const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'call\\n');fs.writeFileSync(${JSON.stringify(payload)},text);${body}});\n`;
  writeFileSync(executable, script, { mode: 0o700 });
  return { executable, sha256: createHash('sha256').update(script).digest('hex'), timeoutMs: 3000 };
}
const DELIVER =
  "process.stdout.write(JSON.stringify({version:1,mode:'live',attemptId:request.attemptId,destinationId:request.destinationId,outcome:'delivered'}));";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), 'expiry-worker-'));
  db = createDatabase({ path: join(root, 'brain.db') });
  chmodSync(db.name, 0o600);
  configPath = join(root, 'worker.json');
  calls = join(root, 'calls');
  payload = join(root, 'payload');
  const candidate = makeCandidate({
    title: 'Private held title',
    content: 'Private held content must stay inside its authorized store.',
  });
  candidateId = candidate.id;
  const repos = repositories();
  repos.candidateRepo.insert(candidate, computeContentHash(candidate.content));
  placeHold(
    candidate,
    {
      triggers: ['sensitivity_gate_flag'],
      declaredAudience: 'tenant',
      recommendedAudience: 'admins',
      basis: 'pii',
      matchedPatterns: [],
      triggerRuleIds: [],
      otherFlags: [],
    },
    repos,
    { now: '2026-10-31T12:00:00.000Z', limits: { ttlDays: 1 } },
  );
  config = {
    version: 1,
    tenantId: TENANT,
    expiresAt: '2099-01-01T00:00:00.000Z',
    destinationId: 'fixture-owner',
    reviewExecutable: '/fixture/curator-cli',
    operatorId: 'fixture-reviewer',
    store: inspectRecoveryStore(db.name),
    transport: transport(DELIVER),
  };
  save();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
function state() {
  return {
    rows: db.prepare('SELECT * FROM candidates').all(),
    events: repositories().auditRepo.findAllChronological(),
  };
}
function callCount() {
  return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0;
}

describe('independent hold expiry worker on disposable stores', () => {
  it('rejects an oversized review command before persisting intent or invoking transport', async () => {
    config.reviewExecutable = '/' + 'a'.repeat(8192);
    save();
    const before = state();
    expect(await runHoldExpiryWorker(configPath, true)).toMatchObject({
      ok: false,
      startedNew: false,
      outcomeRecorded: false,
    });
    expect(state()).toEqual(before);
    expect(callCount()).toBe(0);
  });
  it('previews without creating a lock, receipt or transport process', async () => {
    const before = state();
    const result = await runHoldExpiryWorker(configPath);
    expect(result).toMatchObject({
      ok: true,
      action: 'preview',
      startedNew: false,
      outcomeRecorded: false,
    });
    expect(result.plans).toHaveLength(1);
    expect(state()).toEqual(before);
    expect(callCount()).toBe(0);
    expect(existsSync(join(root, '.write.lock'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Private');
  });
  it('records intent before one delivery, binds its receipt, and does not resend on restart', async () => {
    const first = await runHoldExpiryWorker(configPath, true);
    expect(first).toMatchObject({
      ok: true,
      action: 'attempted',
      startedNew: true,
      outcomeRecorded: true,
      transport: { outcome: 'delivered' },
    });
    const after = state();
    expect(callCount()).toBe(1);
    const request = JSON.parse(readFileSync(payload, 'utf8'));
    expect(request.destinationId).toBe('fixture-owner');
    expect(request.message).toContain('--dry-run');
    expect(request.message).toContain(candidateId);
    expect(request.message).not.toContain('Private');
    expect(after.events.filter((e) => e.action === 'hold_escalated')).toHaveLength(2);
    const outcome = repositories()
      .auditRepo.findByMemoryAndTenant(candidateId, TENANT)
      .find((e) => e.id === first.outcomeReceiptId)!;
    expect(outcome.details['transportBinding']).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.details['transportReceiptDigest']).toBe(first.transport!.receiptDigest);
    expect(await runHoldExpiryWorker(configPath, true)).toMatchObject({
      ok: true,
      action: 'idle',
      startedNew: false,
    });
    expect(callCount()).toBe(1);
    expect(state()).toEqual(after);
    expect(repositories().memoryRepo.count()).toBe(0);
  });
  it('does not blindly resend when delivery happened but outcome persistence failed', async () => {
    db.exec(
      "CREATE TRIGGER refuse_outcome BEFORE INSERT ON audit_events WHEN NEW.action='hold_escalated' AND json_extract(NEW.details_json,'$.outcome') IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    const first = await runHoldExpiryWorker(configPath, true);
    expect(first).toMatchObject({
      ok: false,
      startedNew: true,
      outcomeRecorded: false,
      transport: { outcome: 'delivered' },
    });
    db.exec('DROP TRIGGER refuse_outcome');
    const retry = await runHoldExpiryWorker(configPath, true);
    expect(retry).toMatchObject({ ok: true, action: 'reconciliation_required', startedNew: false });
    expect(retry.reconciliationRequired).toEqual([first.attemptId]);
    expect(callCount()).toBe(1);
  });
  it('preserves uncertain process results and refuses automatic repeat', async () => {
    config.transport = transport('process.exitCode=1;');
    save();
    expect(await runHoldExpiryWorker(configPath, true)).toMatchObject({
      ok: true,
      outcomeRecorded: true,
      transport: { outcome: 'unknown' },
    });
    expect(await runHoldExpiryWorker(configPath, true)).toMatchObject({
      action: 'reconciliation_required',
      startedNew: false,
    });
    expect(callCount()).toBe(1);
  });
  it('requires reconciliation after the approved destination changes', async () => {
    const first = await runHoldExpiryWorker(configPath, true);
    expect(first.ok).toBe(true);
    config.destinationId = 'other-approved-target';
    save();
    expect(await runHoldExpiryWorker(configPath, true)).toMatchObject({
      action: 'reconciliation_required',
      startedNew: false,
    });
    expect(callCount()).toBe(1);
  });
  it('refuses invalid executable approval before writing intent', async () => {
    config.transport = { ...(config.transport as object), sha256: '0'.repeat(64) };
    save();
    const before = state();
    expect(await runHoldExpiryWorker(configPath, true)).toMatchObject({
      ok: false,
      startedNew: false,
      outcomeRecorded: false,
    });
    expect(state()).toEqual(before);
    expect(callCount()).toBe(0);
  });
  it('refuses expired approval and changed physical store witness without sends', async () => {
    config.expiresAt = '2000-01-01T00:00:00.000Z';
    save();
    const before = state();
    expect((await runHoldExpiryWorker(configPath, true)).ok).toBe(false);
    config.expiresAt = '2099-01-01T00:00:00.000Z';
    config.store = { ...inspectRecoveryStore(db.name), databaseInode: 0 };
    save();
    expect((await runHoldExpiryWorker(configPath, true)).ok).toBe(false);
    expect(state()).toEqual(before);
    expect(callCount()).toBe(0);
  });
  it('records a separate final attempt and permits the ordinary expiry sweep without promoting', async () => {
    const repos = repositories();
    recommendOnHold(
      {
        candidateId,
        tenantId: TENANT,
        actor: { type: 'human', id: 'fixture-reviewer' },
        verdict: 'release',
        reasoning: 'reviewed fixture',
        now: NOW,
      },
      repos,
    );
    expect((await runHoldExpiryWorker(configPath, true)).ok).toBe(true);
    vi.setSystemTime('2026-11-01T12:00:00.000Z');
    expect(expireHolds(TENANT, repos)[0]?.escalationRequired).toBe(true);
    const final = await runHoldExpiryWorker(configPath, true);
    expect(final).toMatchObject({
      ok: true,
      outcomeRecorded: true,
      transport: { outcome: 'delivered' },
    });
    expect(callCount()).toBe(2);
    expect(JSON.parse(readFileSync(payload, 'utf8')).message).toContain(
      'release window has closed',
    );
    expect(expireHolds(TENANT, repos)[0]?.auditEventId).toBeTruthy();
    expect(repos.memoryRepo.count()).toBe(0);
    expect(repos.candidateRepo.findById(candidateId)?.status).toBe('rejected');
  });
  it('compiled independent CLI defaults to preview without invoking transport', () => {
    const before = state();
    const child = spawnSync(
      process.execPath,
      [resolve('apps/curator/dist/hold/expiry-main.js'), '--config', configPath],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      ok: true,
      action: 'preview',
      startedNew: false,
    });
    expect(state()).toEqual(before);
    expect(callCount()).toBe(0);
  });
  it('respects a real competing process holding the shared write lock', async () => {
    const child = spawn(
      '/usr/bin/flock',
      [
        '--exclusive',
        join(root, '.write.lock'),
        process.execPath,
        '-e',
        "process.stdout.write('held\\n');setTimeout(()=>{},700)",
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    await once(child.stdout, 'data');
    const before = state();
    const result = await runHoldExpiryWorker(configPath, true);
    await exited;
    expect(result).toMatchObject({ ok: false, startedNew: false, outcomeRecorded: false });
    expect(state()).toEqual(before);
    expect(callCount()).toBe(0);
    expect((await runHoldExpiryWorker(configPath, true)).ok).toBe(true);
  });
  it('preserves committed outcome and releases the lock even if connection close fails', async () => {
    const original = store.openExistingDatabase;
    vi.spyOn(store, 'openExistingDatabase').mockImplementation((options) => {
      const connection = original(options);
      const close = connection.close.bind(connection);
      connection.close = () => {
        close();
        throw new Error('private close detail');
      };
      return connection;
    });
    const result = await runHoldExpiryWorker(configPath, true);
    expect(result).toMatchObject({
      ok: false,
      startedNew: true,
      outcomeRecorded: true,
      transport: { outcome: 'delivered' },
    });
    expect(JSON.stringify(result)).not.toContain('private close detail');
    expect(
      spawnSync('/usr/bin/flock', ['--nonblock', join(root, '.write.lock'), 'true']).status,
    ).toBe(0);
  });
});
