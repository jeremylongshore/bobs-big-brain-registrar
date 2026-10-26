import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  openExistingDatabase,
  MemoryRepository,
  CandidateRepository,
  PolicyRepository,
} from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { makeCandidate, makeMemory, makePolicy, TENANT } from './fixtures.js';
import { memorySnapshotDigest } from '../recovery/source-archive.js';
import { runRecoveryCommand } from '../recovery/command.js';
import { executeRecoveryEnvelope } from '../recovery/recovery-execution.js';
import type {
  RecoveryReadinessContext,
  TrustedRecoveryReadiness,
} from '../recovery/recovery-execution.js';
import { acquireRecoveryWriteLock, inspectRecoveryStore } from '../recovery/filesystem-boundary.js';
import { readPrivateRecoveryFile } from '../recovery/private-files.js';

let root: string;
let databasePath: string;
let requestPath: string;
let planPath: string;
let keyPath: string;
const cliPath = resolve('apps/curator/dist/recovery/main.js');
const SECRET = 'fixture-command-origin';
interface CommandOutput {
  ok: boolean;
  reviewedDigest: string;
  committed: boolean | string;
  alreadyApplied: boolean;
  warnings: string[];
  status: { state: string; entries: { archived: boolean }[] };
  recoveryComplete: boolean;
  postcommit: Record<string, string>;
}
function command(args: string[]): { code: number | null; output: CommandOutput; text: string } {
  const child = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe('');
  return {
    code: child.status,
    output: JSON.parse(child.stdout) as CommandOutput,
    text: child.stdout,
  };
}
function plan(fresh = true): string {
  const result = command([
    'plan',
    '--request',
    requestPath,
    '--out',
    planPath,
    ...(fresh ? ['--origin-secret-file', keyPath, '--origin-channel', 'local-mcp'] : []),
  ]);
  expect(result.code).toBe(0);
  expect(result.output.ok).toBe(true);
  return result.output.reviewedDigest;
}
function apply(digest: string) {
  return command([
    'apply',
    '--plan',
    planPath,
    '--digest',
    digest,
    '--origin-secret-file',
    keyPath,
  ]);
}
function snapshot(): unknown {
  const db = openExistingDatabase({ path: databasePath, readonly: true });
  try {
    return Object.fromEntries(
      ['candidates', 'curated_memories', 'audit_events', 'memory_links', 'governance_policies'].map(
        (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
      ),
    );
  } finally {
    db.close();
  }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recovery-command-'));
  databasePath = join(root, 'teamkb.db');
  requestPath = join(root, 'request.json');
  planPath = join(root, 'plan.json');
  keyPath = join(root, 'origin.key');
  const db = createDatabase({ path: databasePath });
  const memories = new MemoryRepository(db);
  new PolicyRepository(db).insert(makePolicy({ name: 'Private orchard policy marker' }));
  const source = makeMemory({
    tenantId: 'local',
    source: 'import',
    title: 'Orchard water guide',
    content: 'Water orchard trees regularly.',
    sensitivity: 'internal',
    metadata: { filePaths: ['orchard.md'], tags: ['orchard'], audience: 'owner' },
  });
  const excluded = makeMemory({
    tenantId: 'local',
    title: 'Excluded tidal guide',
    content: 'Retain the tidal guide.',
  });
  memories.insert(source);
  memories.insert(excluded);
  const queued = makeCandidate({ content: 'Keep the other inbox candidate queued.' });
  new CandidateRepository(db).insert(queued, computeContentHash(queued.content));
  db.close();
  writeFileSync(
    requestPath,
    JSON.stringify({
      runId: randomUUID(),
      createdAt: '2026-10-26T04:40:00.000Z',
      storeLocator: databasePath,
      sourceTenantId: 'local',
      targetTenantId: TENANT,
      selections: [{ id: source.id, snapshotDigest: memorySnapshotDigest(source) }],
      exclusions: [{ id: excluded.id, snapshotDigest: memorySnapshotDigest(excluded) }],
      actor: { type: 'human', id: 'fixture-operator' },
      role: 'owner',
      reason: 'Review explicit command fixture recovery.',
    }),
    { mode: 0o600 },
  );
  writeFileSync(keyPath, SECRET, { mode: 0o600 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('actual recovery maintenance command', () => {
  it('plans, applies and reports status through compiled command without exposing content or tokens', () => {
    const before = snapshot();
    const digest = plan();
    expect(snapshot()).toEqual(before);
    const envelope = JSON.parse(readFileSync(planPath, 'utf8')) as {
      plan: { entries: { proposal: { origin: { tokenHmac: string } } }[] };
    };
    expect(statSync(planPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(root, '.write.lock'))).toBe(false);
    const result = apply(digest);
    expect(result.code).toBe(0);
    expect(result.output.committed).toBe(true);
    expect(result.output.warnings).toEqual(['dormant_policy_rules']);
    expect(result.text).not.toContain('Private orchard policy marker');
    expect(result.output.status.state).toBe('complete');
    expect(result.output.recoveryComplete).toBe(false);
    expect(result.output.postcommit).toEqual({
      anchor: 'pending',
      exports: 'pending',
      index: 'pending',
    });
    expect(result.text).not.toContain(SECRET);
    expect(result.text).not.toContain('Water orchard');
    expect(result.text).not.toContain(envelope.plan.entries[0]!.proposal.origin.tokenHmac);
    const after = snapshot();
    const replay = apply(digest);
    expect(replay.code).toBe(0);
    expect(replay.output.alreadyApplied).toBe(true);
    expect(replay.output.committed).toBe(false);
    expect(snapshot()).toEqual(after);
    const status = command(['status', '--plan', planPath, '--digest', digest]);
    expect(status.output.status.state).toBe('complete');
    expect(status.output.recoveryComplete).toBe(false);
  });
  it('plan/status preserve database bytes and modes, ignored default key modes and absence of lock file', () => {
    const implicitKey = join(root, '.origin-secret');
    writeFileSync(implicitKey, 'intentionally-unread-key', { mode: 0o640 });
    const hash = computeContentHash(readFileSync(databasePath).toString('hex'));
    const dbMode = statSync(databasePath).mode;
    const digest = plan(false);
    expect(command(['status', '--plan', planPath, '--digest', digest]).code).toBe(0);
    expect(computeContentHash(readFileSync(databasePath).toString('hex'))).toBe(hash);
    expect(statSync(databasePath).mode).toBe(dbMode);
    expect(statSync(implicitKey).mode & 0o777).toBe(0o640);
    expect(existsSync(join(root, '.write.lock'))).toBe(false);
  });
  it('refuses writerless FIFO request, plan, key and database files without blocking', () => {
    const fifo = join(root, 'private.fifo');
    expect(spawnSync('/usr/bin/mkfifo', ['-m', '600', fifo]).status).toBe(0);
    const digest = plan();
    for (const args of [
      ['plan', '--request', fifo, '--out', join(root, 'fifo-plan.json')],
      ['status', '--plan', fifo, '--digest', digest],
      ['apply', '--plan', fifo, '--digest', digest],
      ['apply', '--plan', planPath, '--digest', digest, '--origin-secret-file', fifo],
    ]) {
      expect(command(args).code).toBe(1);
    }
    // The exported opener is exercised in its own bounded process: a regression
    // must fail the test rather than indefinitely block the test worker.
    const opener = resolve('packages/store/dist/index.js');
    const program = `import { openExistingDatabase } from ${JSON.stringify(opener)};
      try { openExistingDatabase({ path: process.argv[1], readonly: true }); process.exitCode=2; }
      catch { process.stdout.write('refused'); }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program, fifo], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('refused');
    expect(child.stderr).toBe('');
    expect(existsSync(join(root, '.write.lock'))).toBe(false);
    expect(existsSync(join(root, 'fifo-plan.json'))).toBe(false);
  });
  it('refuses permissive explicit keys without chmod or plan creation', () => {
    chmodSync(keyPath, 0o640);
    const before = snapshot();
    const result = command([
      'plan',
      '--request',
      requestPath,
      '--out',
      planPath,
      '--origin-secret-file',
      keyPath,
      '--origin-channel',
      'local-mcp',
    ]);
    expect(result.code).toBe(1);
    expect(statSync(keyPath).mode & 0o777).toBe(0o640);
    expect(existsSync(planPath)).toBe(false);
    expect(snapshot()).toEqual(before);
  });
  it.each(['digest', 'body', 'mode', 'symlink'] as const)(
    'refuses %s plan tampering before application',
    (kind) => {
      let digest = plan();
      if (kind === 'digest') digest = '0'.repeat(64);
      if (kind === 'body') {
        const data = JSON.parse(readFileSync(planPath, 'utf8')) as { plan: { reason: string } };
        data.plan.reason = 'Changed review';
        writeFileSync(planPath, JSON.stringify(data));
      }
      if (kind === 'mode') chmodSync(planPath, 0o644);
      if (kind === 'symlink') {
        renameSync(planPath, planPath + '.original');
        symlinkSync(planPath + '.original', planPath);
      }
      const before = snapshot();
      expect(apply(digest).code).toBe(1);
      expect(snapshot()).toEqual(before);
      expect(existsSync(join(root, '.write.lock'))).toBe(false);
    },
  );
  it.each(['missing', 'symlink', 'replacement'] as const)(
    'refuses %s database identity before acquiring lock',
    (kind) => {
      const digest = plan();
      renameSync(databasePath, databasePath + '.original');
      if (kind === 'symlink') symlinkSync(databasePath + '.original', databasePath);
      if (kind === 'replacement') {
        const db = createDatabase({ path: databasePath });
        db.close();
      }
      expect(apply(digest).code).toBe(1);
      expect(existsSync(join(root, '.write.lock'))).toBe(false);
      if (kind === 'missing') expect(existsSync(databasePath)).toBe(false);
    },
  );
  it('refuses a replaced parent directory even when the database inode is retained', () => {
    const digest = plan();
    const old = root + '-old';
    renameSync(root, old);
    try {
      const copiedPlan = JSON.parse(readFileSync(join(old, 'plan.json'), 'utf8')) as unknown;
      // Recreate the same pathname; moving the original database retains its inode.
      mkdirSync(root, { mode: 0o700 });
      renameSync(join(old, 'teamkb.db'), databasePath);
      writeFileSync(planPath, JSON.stringify(copiedPlan), { mode: 0o600 });
      renameSync(join(old, 'origin.key'), keyPath);
      expect(apply(digest).code).toBe(1);
      expect(existsSync(join(root, '.write.lock'))).toBe(false);
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });
  it('refuses existing output, oversized private inputs and duplicate options', () => {
    const digest = plan();
    const original = readFileSync(planPath);
    expect(command(['plan', '--request', requestPath, '--out', planPath]).code).toBe(1);
    expect(readFileSync(planPath)).toEqual(original);
    expect(
      command(['status', '--plan', planPath, '--digest', digest, '--digest', digest]).code,
    ).toBe(1);
    expect(() => readPrivateRecoveryFile(requestPath, 1)).toThrow();
  });
  it('retains canonical partial outcomes with explicit uncompleted postprocessing', () => {
    const digest = plan();
    writeFileSync(keyPath, 'wrong-fixture-key');
    const result = apply(digest);
    expect(result.code).toBe(0);
    expect(result.output.committed).toBe(true);
    expect(result.output.status.state).toBe('partial');
    expect(result.output.status.entries.every((entry) => !entry.archived)).toBe(true);
    expect(result.output.recoveryComplete).toBe(false);
  });
  it('rolls back a command fault and retries the identical envelope after removal', () => {
    const digest = plan();
    let db = openExistingDatabase({ path: databasePath, readonly: false });
    db.exec(
      "CREATE TRIGGER command_fault BEFORE INSERT ON audit_events WHEN NEW.action='archived' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    db.close();
    const before = snapshot();
    const result = apply(digest);
    expect(result.code).toBe(1);
    expect(result.output.committed).toBe('unknown');
    expect(snapshot()).toEqual(before);
    db = openExistingDatabase({ path: databasePath, readonly: false });
    db.exec('DROP TRIGGER command_fault');
    db.close();
    expect(apply(digest).output.status.state).toBe('complete');
  });
  it('does not claim rollback when output fails after the actual commit', () => {
    const digest = plan();
    const output: unknown[] = [];
    let first = true;
    const code = runRecoveryCommand(
      ['apply', '--plan', planPath, '--digest', digest, '--origin-secret-file', keyPath],
      {
        output(value) {
          if (first) {
            first = false;
            throw new Error('simulated output failure');
          }
          output.push(value);
        },
      },
    );
    expect(code).toBe(1);
    expect(output).toEqual([
      {
        ok: false,
        command: 'apply',
        committed: true,
        error: 'recovery_refused',
        recoveryComplete: false,
      },
    ]);
    expect(command(['status', '--plan', planPath, '--digest', digest]).output.status.state).toBe(
      'complete',
    );
  });
  it('retains the actual kernel lock until release and excludes an independent contender', () => {
    const lock = acquireRecoveryWriteLock(inspectRecoveryStore(databasePath), 0);
    const path = join(root, '.write.lock');
    try {
      expect(spawnSync('/usr/bin/flock', ['--nonblock', path, '/usr/bin/true']).status).toBe(1);
      lock.verify();
    } finally {
      lock.release();
    }
    expect(spawnSync('/usr/bin/flock', ['--nonblock', path, '/usr/bin/true']).status).toBe(0);
  });
  it('refuses an apply command while an independent process holds the shared flock', async () => {
    const digest = plan();
    const path = join(root, '.write.lock');
    const program =
      "const fs=require('node:fs'),cp=require('node:child_process');const fd=fs.openSync(process.argv[1],'a',0o600);const r=cp.spawnSync('/usr/bin/flock',['--exclusive','3'],{stdio:['ignore','ignore','ignore',fd]});if(r.status!==0)process.exit(2);process.stdout.write('held\\n');process.stdin.resume();process.stdin.on('end',()=>{fs.closeSync(fd);process.exit(0)});";
    const holder = spawn(process.execPath, ['-e', program, path], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      await once(holder.stdout, 'data');
      const before = snapshot();
      const result = command([
        'apply',
        '--plan',
        planPath,
        '--digest',
        digest,
        '--origin-secret-file',
        keyPath,
        '--lock-timeout-ms',
        '20',
      ]);
      expect(result.code).toBe(1);
      expect(result.output.committed).toBe(false);
      expect(snapshot()).toEqual(before);
      const exited = once(holder, 'exit');
      holder.stdin.end();
      await exited;
    } finally {
      if (holder.exitCode === null) {
        holder.kill('SIGTERM');
        await once(holder, 'exit');
      }
    }
    expect(apply(digest).output.status.state).toBe('complete');
  });
  it('refuses symlink lock files and releases after a detected lock replacement', () => {
    const witness = inspectRecoveryStore(databasePath);
    const path = join(root, '.write.lock');
    symlinkSync(keyPath, path);
    expect(() => acquireRecoveryWriteLock(witness, 0)).toThrow();
    rmSync(path);
    const lock = acquireRecoveryWriteLock(witness, 0);
    renameSync(path, path + '.old');
    writeFileSync(path, '', { mode: 0o600 });
    try {
      expect(() => lock.verify()).toThrow();
    } finally {
      lock.release();
    }
  });
  it('opens existing schema without chmod and refuses missing or outdated stores without migration', () => {
    chmodSync(databasePath, 0o640);
    const db = openExistingDatabase({ path: databasePath, readonly: false });
    db.close();
    expect(statSync(databasePath).mode & 0o777).toBe(0o640);
    expect(() =>
      openExistingDatabase({ path: join(root, 'missing.db'), readonly: false }),
    ).toThrow();
    expect(existsSync(join(root, 'missing.db'))).toBe(false);
    const current = openExistingDatabase({ path: databasePath, readonly: false });
    current.exec(
      'DELETE FROM schema_migrations WHERE version=(SELECT MAX(version) FROM schema_migrations)',
    );
    current.close();
    const hash = computeContentHash(readFileSync(databasePath).toString('hex'));
    expect(() => openExistingDatabase({ path: databasePath, readonly: false })).toThrow();
    expect(computeContentHash(readFileSync(databasePath).toString('hex'))).toBe(hash);
  });
});

describe('locked asynchronous recovery integration', () => {
  function request(digest: string) {
    return {
      operation: 'apply' as const,
      planPath,
      expectedDigest: digest,
      originSecretFile: keyPath,
    };
  }
  function contender(): number | null {
    return spawnSync('/usr/bin/flock', ['--nonblock', join(root, '.write.lock'), '/usr/bin/true'])
      .status;
  }
  it('refuses readiness before settlement while holding both writer locks', async () => {
    const digest = plan();
    const before = snapshot();
    let checked = false;
    let postprocessed = false;
    const result = await executeRecoveryEnvelope(
      request(digest),
      async () => {
        postprocessed = true;
      },
      (context) => {
        checked = true;
        expect(context.database.inTransaction).toBe(true);
        expect(contender()).toBe(1);
        const competitor = openExistingDatabase({ path: databasePath, readonly: false });
        try {
          competitor.pragma('busy_timeout = 0');
          expect(() => competitor.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
        } finally {
          competitor.close();
        }
        context.assertStillBound();
        throw new Error('Private audit reason must not escape');
      },
    );
    expect(checked).toBe(true);
    expect(postprocessed).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      committed: false,
      appliedNow: false,
      failedStage: 'preflight',
      postcommit: { state: 'not_run' },
    });
    expect(snapshot()).toEqual(before);
    expect(contender()).toBe(0);
    expect(JSON.stringify(result)).not.toContain('Private audit reason');
  });
  it('rolls back writes attempted by a refusing trusted readiness checker', async () => {
    const digest = plan();
    const before = snapshot();
    const result = await executeRecoveryEnvelope(
      request(digest),
      async () => undefined,
      (context) => {
        context.database.prepare('DELETE FROM governance_policies').run();
        throw new Error('refuse after attempted write');
      },
    );
    expect(result).toMatchObject({ ok: false, committed: false, appliedNow: false });
    expect(snapshot()).toEqual(before);
  });
  it('centrally refuses lock replacement during readiness before any settlement', async () => {
    const digest = plan();
    const before = snapshot();
    const lockPath = join(root, '.write.lock');
    const originalLock = join(root, '.write.lock.original');
    let postprocessed = false;
    const result = await executeRecoveryEnvelope(
      request(digest),
      async () => {
        postprocessed = true;
      },
      () => {
        renameSync(lockPath, originalLock);
        writeFileSync(lockPath, 'replacement-lock-sentinel', { mode: 0o600 });
      },
    );
    expect(result).toMatchObject({
      ok: false,
      committed: false,
      appliedNow: false,
      failedStage: 'preflight',
    });
    expect(postprocessed).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(lockPath, 'utf8')).toBe('replacement-lock-sentinel');
    expect(spawnSync('/usr/bin/flock', ['--nonblock', originalLock, '/usr/bin/true']).status).toBe(
      0,
    );
  });
  it('settles canonical recovery after successful synchronous readiness', async () => {
    const digest = plan();
    let checked = 0;
    const result = await executeRecoveryEnvelope(
      request(digest),
      async () => 'postcommit',
      (context) => {
        checked++;
        expect(context.runId).toBeTypeOf('string');
        expect(context.sourceTenantId).toBe('local');
        expect(context.targetTenantId).toBe(TENANT);
        expect(context.database.inTransaction).toBe(true);
        context.assertStillBound();
      },
    );
    expect(checked).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      committed: true,
      appliedNow: true,
      status: { state: 'complete' },
      postcommit: { state: 'completed', value: 'postcommit' },
    });
    expect(contender()).toBe(0);
  });
  it('preserves historical replay and repair without rerunning fresh readiness', async () => {
    const digest = plan();
    expect(apply(digest).code).toBe(0);
    const before = snapshot();
    let checks = 0;
    const readiness: TrustedRecoveryReadiness = () => {
      checks++;
      throw new Error('fresh readiness must not run');
    };
    const replay = await executeRecoveryEnvelope(
      request(digest),
      async () => {
        throw new Error('no replay maintenance');
      },
      readiness,
    );
    expect(replay).toMatchObject({
      ok: true,
      committed: true,
      appliedNow: false,
      postcommit: { state: 'skipped_replay' },
    });
    const repaired = await executeRecoveryEnvelope(
      { operation: 'repair', planPath, expectedDigest: digest },
      async () => {
        throw new Error('strict repair refuses');
      },
      readiness,
    );
    expect(repaired).toMatchObject({
      ok: false,
      committed: true,
      appliedNow: false,
      failedStage: 'postcommit',
    });
    expect(checks).toBe(0);
    expect(snapshot()).toEqual(before);
  });
  it('refuses native async readiness before invoking it or settling', async () => {
    const digest = plan();
    const before = snapshot();
    let called = false;
    const invalid = (async () => {
      called = true;
    }) as unknown as TrustedRecoveryReadiness;
    const result = await executeRecoveryEnvelope(request(digest), async () => undefined, invalid);
    expect(result).toMatchObject({
      ok: false,
      committed: false,
      appliedNow: false,
      failedStage: 'preflight',
    });
    expect(called).toBe(false);
    expect(snapshot()).toEqual(before);
  });
  it('refuses a returned promise and rolls back synchronous checker writes', async () => {
    const digest = plan();
    const before = snapshot();
    const invalid = ((context: RecoveryReadinessContext) => {
      context.database.prepare('DELETE FROM governance_policies').run();
      return Promise.resolve();
    }) as unknown as TrustedRecoveryReadiness;
    const result = await executeRecoveryEnvelope(request(digest), async () => undefined, invalid);
    expect(result).toMatchObject({ ok: false, committed: false, appliedNow: false });
    expect(snapshot()).toEqual(before);
  });
  it('sanitizes rejected promise misuse without an unhandled rejection in a real process', () => {
    const digest = plan();
    const before = snapshot();
    const script = `
      const {executeRecoveryEnvelope} = await import(process.argv[1]);
      const result = await executeRecoveryEnvelope(JSON.parse(process.argv[2]),
        async () => undefined, () => Promise.reject(new Error('private-readiness-rejection')));
      console.log(JSON.stringify(result));
    `;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        resolve('apps/curator/dist/recovery/recovery-execution.js'),
        JSON.stringify(request(digest)),
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 128 * 1024,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toMatchObject({
      ok: false,
      committed: false,
      appliedNow: false,
      failedStage: 'preflight',
    });
    expect(child.stdout).not.toContain('private-readiness-rejection');
    expect(snapshot()).toEqual(before);
  });
  it('retains the actual flock through an awaited integration and exposes only callback completion', async () => {
    const digest = plan();
    const result = await executeRecoveryEnvelope(request(digest), async (context) => {
      expect(context.sourceTenantId).toBe('local');
      expect(context.targetTenantId).toBe(TENANT);
      expect(context.warnings).toEqual(['dormant_policy_rules']);
      expect(contender()).toBe(1);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(contender()).toBe(1);
      context.assertStillBound();
      return { recoveryComplete: true };
    });
    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.appliedNow).toBe(true);
    expect(result.postcommit).toEqual({ state: 'completed', value: { recoveryComplete: true } });
    expect(result.recoveryComplete).toBe(false);
    expect(contender()).toBe(0);
    expect(JSON.stringify(result)).not.toContain('Private orchard policy marker');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it('never invokes postprocessing for a historical apply replay', async () => {
    const digest = plan();
    expect(apply(digest).code).toBe(0);
    const before = snapshot();
    let called = false;
    const result = await executeRecoveryEnvelope(request(digest), async () => {
      called = true;
    });
    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.appliedNow).toBe(false);
    expect(result.postcommit).toEqual({ state: 'skipped_replay' });
    expect(called).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(contender()).toBe(0);
  });
  it('repairs existing settlement explicitly without adding candidate, governance or archive writes', async () => {
    const digest = plan();
    expect(apply(digest).code).toBe(0);
    const before = snapshot();
    let count = 0;
    const result = await executeRecoveryEnvelope(
      { operation: 'repair', planPath, expectedDigest: digest },
      async (context) => {
        context.assertStillBound();
        count++;
        return 'refreshed';
      },
    );
    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.appliedNow).toBe(false);
    expect(result.postcommit).toEqual({ state: 'completed', value: 'refreshed' });
    expect(count).toBe(1);
    expect(snapshot()).toEqual(before);
    expect(contender()).toBe(0);
  });
  it('refuses repair without an apply receipt and refuses an origin key on repair', async () => {
    const digest = plan();
    const before = snapshot();
    let count = 0;
    const callback = async () => {
      count++;
    };
    const missing = await executeRecoveryEnvelope(
      { operation: 'repair', planPath, expectedDigest: digest },
      callback,
    );
    expect(missing.ok).toBe(false);
    expect(missing.committed).toBe(false);
    expect(missing.postcommit.state).toBe('not_run');
    const key = await executeRecoveryEnvelope(
      { ...request(digest), operation: 'repair' },
      callback,
    );
    expect(key.ok).toBe(false);
    expect(count).toBe(0);
    expect(snapshot()).toEqual(before);
  });
  it('postprocesses committed partial outcomes without claiming recovery completion', async () => {
    const digest = plan();
    const wrongKey = join(root, 'wrong.key');
    writeFileSync(wrongKey, 'different-fixture-origin', { mode: 0o600 });
    let count = 0;
    const result = await executeRecoveryEnvelope(
      { ...request(digest), originSecretFile: wrongKey },
      async (context) => {
        expect(context.status.state).toBe('partial');
        expect(context.status.entries.every((entry) => !entry.archived)).toBe(true);
        count++;
      },
    );
    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.recoveryComplete).toBe(false);
    expect(count).toBe(1);
  });
  it('keeps committed recovery after a stage failure and permits explicit repair', async () => {
    const digest = plan();
    const failed = await executeRecoveryEnvelope(request(digest), async () => {
      throw new Error(SECRET);
    });
    expect(failed.ok).toBe(false);
    expect(failed.committed).toBe(true);
    expect(failed.appliedNow).toBe(true);
    expect(failed.postcommit.state).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain(SECRET);
    const before = snapshot();
    const repaired = await executeRecoveryEnvelope(
      { operation: 'repair', planPath, expectedDigest: digest },
      async () => 'repaired',
    );
    expect(repaired.ok).toBe(true);
    expect(repaired.committed).toBe(true);
    expect(repaired.appliedNow).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(contender()).toBe(0);
  });
  it('refuses preflight drift and never runs a stage after a rolled-back core fault', async () => {
    const digest = plan();
    const db = openExistingDatabase({ path: databasePath, readonly: false });
    db.exec(
      "CREATE TRIGGER async_fault BEFORE INSERT ON audit_events WHEN NEW.action='archived' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    db.close();
    const before = snapshot();
    let called = false;
    const callback = async () => {
      called = true;
    };
    const wrong = await executeRecoveryEnvelope(
      { ...request(digest), expectedDigest: '0'.repeat(64) },
      callback,
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.committed).toBe(false);
    const fault = await executeRecoveryEnvelope(request(digest), callback);
    expect(fault.ok).toBe(false);
    expect(fault.committed).toBe('unknown');
    expect(fault.appliedNow).toBe('unknown');
    expect(called).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(contender()).toBe(0);
  });
  it('refuses a drifted existing settlement during repair', async () => {
    const digest = plan();
    expect(apply(digest).code).toBe(0);
    const db = openExistingDatabase({ path: databasePath, readonly: false });
    db.prepare('UPDATE curated_memories SET title=? WHERE tenant_id=?').run(
      'Changed after settlement',
      TENANT,
    );
    db.close();
    const before = snapshot();
    let called = false;
    const result = await executeRecoveryEnvelope(
      { operation: 'repair', planPath, expectedDigest: digest },
      async () => {
        called = true;
      },
    );
    expect(result.ok).toBe(false);
    expect(result.committed).toBe('unknown');
    expect(called).toBe(false);
    expect(snapshot()).toEqual(before);
  });
  it('checks the store centrally after an awaited callback, retaining known commit on base replacement', async () => {
    const digest = plan();
    const moved = root + '.moved';
    try {
      const result = await executeRecoveryEnvelope(request(digest), async () => {
        renameSync(root, moved);
      });
      expect(result.ok).toBe(false);
      expect(result.committed).toBe(true);
      expect(result.appliedNow).toBe(true);
      expect(result.postcommit.state).toBe('failed');
    } finally {
      if (existsSync(moved)) renameSync(moved, root);
    }
    expect(command(['status', '--plan', planPath, '--digest', digest]).output.status.state).toBe(
      'complete',
    );
    expect(contender()).toBe(0);
  });
  it('detects replaced lock paths between stages without losing a known commit', async () => {
    const digest = plan();
    const result = await executeRecoveryEnvelope(request(digest), async (context) => {
      const path = join(root, '.write.lock');
      renameSync(path, path + '.old');
      writeFileSync(path, '', { mode: 0o600 });
      context.assertStillBound();
    });
    expect(result.ok).toBe(false);
    expect(result.committed).toBe(true);
    expect(result.postcommit.state).toBe('failed');
  });
  it('refuses selected-row drift caused by postprocessing without reporting a rollback', async () => {
    const digest = plan();
    const result = await executeRecoveryEnvelope(request(digest), async (context) => {
      context.database
        .prepare('UPDATE curated_memories SET title=? WHERE tenant_id=?')
        .run('Unexpected postprocessing mutation', TENANT);
    });
    expect(result.ok).toBe(false);
    expect(result.committed).toBe(true);
    expect(result.postcommit.state).toBe('failed');
    expect(contender()).toBe(0);
  });
  it('does not let a mutable request change the operation reported after commit', async () => {
    const digest = plan();
    const input = request(digest);
    const result = await executeRecoveryEnvelope(input, async () => {
      (input as { operation: string }).operation = 'repair';
    });
    expect(result.ok).toBe(true);
    expect(result.operation).toBe('apply');
    expect(result.committed).toBe(true);
    expect(result.appliedNow).toBe(true);
  });
  it('does not let callback snapshot mutation replace validation authority', async () => {
    const digest = plan();
    const result = await executeRecoveryEnvelope(request(digest), async (context) => {
      context.status.state = 'not_applied';
      context.status.entries.length = 0;
      context.assertStillBound();
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status.state).toBe('complete');
      expect(result.status.entries).toHaveLength(1);
    }
  });
  it('preserves known settlement through finalization faults and still releases the lock', async () => {
    const digest = plan();
    const result = await executeRecoveryEnvelope(request(digest), async (context) => {
      context.database.close();
    });
    expect(result.ok).toBe(false);
    expect(result.committed).toBe(true);
    expect(result.appliedNow).toBe(true);
    expect(contender()).toBe(0);
  });
});
