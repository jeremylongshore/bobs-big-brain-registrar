import * as childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNotificationTransport } from '../hold/notification-transport.js';
import type { NotificationRequest, NotificationTransport } from '../hold/notification-transport.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let root: string;
let request: NotificationRequest;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hold-transport-'));
  request = {
    version: 1,
    attemptId: randomUUID(),
    destinationId: 'fixture-owner-channel',
    message: 'Synthetic hold notification; no live delivery.',
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function adapter(body: string): NotificationTransport {
  const executable = join(root, 'adapter');
  const script = `#!${process.execPath}\nlet input=''; process.stdin.on('data', b=>input+=b); process.stdin.on('end',()=>{ const request=JSON.parse(input); ${body} });\n`;
  writeFileSync(executable, script, { mode: 0o700 });
  return { executable, sha256: createHash('sha256').update(script).digest('hex'), timeoutMs: 3000 };
}
const receipt =
  "JSON.stringify({version:1,mode:'live',attemptId:request.attemptId,destinationId:request.destinationId,outcome:'delivered'})";

describe('bounded notification transport protocol', () => {
  it('executes the approved descriptor and accepts only a bound live receipt', async () => {
    const config = adapter(`process.stdout.write(${receipt});`);
    expect(await runNotificationTransport(request, config)).toMatchObject({
      outcome: 'delivered',
      reason: 'receipt',
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it.each(['failed', 'unknown'] as const)('preserves a %s transport outcome', async (outcome) => {
    const config = adapter(
      `process.stdout.write(${receipt.replace("'delivered'", JSON.stringify(outcome))});`,
    );
    expect(await runNotificationTransport(request, config)).toMatchObject({
      outcome,
      reason: 'receipt',
    });
  });
  it.each([
    "process.stdout.write('');",
    "process.stdout.write('delivered');",
    `process.stdout.write(${receipt.replace("mode:'live'", "mode:'preview'")});`,
    `process.stdout.write(${receipt.replace('attemptId:request.attemptId', "attemptId:'00000000-0000-4000-8000-000000000000'")});`,
    `process.stdout.write(${receipt.replace('destinationId:request.destinationId', "destinationId:'other'")});`,
    `process.stdout.write(${receipt.replace("outcome:'delivered'", "outcome:'spooled'")});`,
    `process.stdout.write(${receipt}); process.stdout.write(' extra');`,
  ])('refuses unsupported or unbound output %#', async (body) => {
    expect(await runNotificationTransport(request, adapter(body))).toMatchObject({
      outcome: 'unknown',
      reason: 'invalid_receipt',
    });
  });
  it('does not treat a success-looking receipt followed by nonzero exit as delivery', async () => {
    expect(
      await runNotificationTransport(
        request,
        adapter(`process.stdout.write(${receipt}); process.exitCode=1;`),
      ),
    ).toEqual({ outcome: 'unknown', reason: 'unconfirmed_process' });
  });
  it('refuses changed bytes or unsafe permissions without starting the executable', async () => {
    const marker = join(root, 'invoked');
    const config = adapter(
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`,
    );
    expect(await runNotificationTransport(request, { ...config, sha256: '0'.repeat(64) })).toEqual({
      outcome: 'failed',
      reason: 'invalid_configuration',
    });
    chmodSync(config.executable, 0o777);
    expect(await runNotificationTransport(request, config)).toEqual({
      outcome: 'failed',
      reason: 'invalid_configuration',
    });
    expect(existsSync(marker)).toBe(false);
  });
  it('does not execute a substituted pathname after descriptor verification', async () => {
    const config = adapter(`process.stdout.write(${receipt});`);
    const original = (await vi.importActual<typeof childProcess>('node:child_process')).spawn;
    vi.mocked(childProcess.spawn).mockImplementationOnce(((
      ...args: Parameters<typeof childProcess.spawn>
    ) => {
      renameSync(config.executable, config.executable + '.old');
      writeFileSync(config.executable, `#!${process.execPath}\nprocess.exit(99);\n`, {
        mode: 0o700,
      });
      return original(...args);
    }) as typeof childProcess.spawn);
    expect(await runNotificationTransport(request, config)).toMatchObject({
      outcome: 'delivered',
      reason: 'receipt',
    });
  });
  it('bounds stdout/stderr and does not leak either into returned errors', async () => {
    const result = await runNotificationTransport(
      request,
      adapter("process.stderr.write('private fixture '.repeat(4000)); setInterval(()=>{},1000);"),
    );
    expect(result).toEqual({ outcome: 'unknown', reason: 'unconfirmed_process' });
    expect(JSON.stringify(result)).not.toContain('private fixture');
  });
  it('kills and reaps the timed-out direct child before returning unknown', async () => {
    const pidFile = join(root, 'pid');
    const config = adapter(
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`,
    );
    config.timeoutMs = 700;
    expect(await runNotificationTransport(request, config)).toEqual({
      outcome: 'unknown',
      reason: 'unconfirmed_process',
    });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
