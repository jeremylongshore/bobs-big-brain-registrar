import { describe, expect, it } from 'vitest';
import { MockQmdExecutor } from '../executor/mock-executor.js';
import { QmdAdapter } from '../adapter.js';
import { run, resolveCliContext, DEFAULT_CLI_TENANT } from '../cli.js';
import { DEFAULT_CANARY_CONTROLS } from '../canary/search-canary.js';

/** Build an injected adapter over a fresh mock, and expose the mock for queueing. */
function makeInjected(): {
  mock: MockQmdExecutor;
  makeAdapter: (t: string, e: string) => QmdAdapter;
} {
  const mock = new MockQmdExecutor();
  const makeAdapter = (t: string, e: string): QmdAdapter =>
    new QmdAdapter({ tenantId: t, exportDir: e, nativeIndexPath: ':memory:' }, mock);
  return { mock, makeAdapter };
}

function hitsJson(n: number): string {
  return JSON.stringify(
    Array.from({ length: n }, (_v, i) => ({
      score: 0.9,
      file: `qmd://kb-curated/d${i}.md`,
      snippet: 's',
    })),
  );
}

describe('resolveCliContext', () => {
  it('defaults the tenant to intent-solutions', () => {
    const ctx = resolveCliContext({});
    expect(ctx.tenantId).toBe(DEFAULT_CLI_TENANT);
    expect(ctx.tenantId).toBe('intent-solutions');
    expect(ctx.exportDir.endsWith('/kb-export')).toBe(true);
  });

  it('honors TEAMKB_TENANT_ID and TEAMKB_EXPORT_DIR', () => {
    const ctx = resolveCliContext({
      TEAMKB_TENANT_ID: 'local',
      TEAMKB_EXPORT_DIR: '/tmp/some/export',
    });
    expect(ctx.tenantId).toBe('local');
    expect(ctx.exportDir).toBe('/tmp/some/export');
  });

  it('ignores a blank TEAMKB_TENANT_ID', () => {
    expect(resolveCliContext({ TEAMKB_TENANT_ID: '   ' }).tenantId).toBe(DEFAULT_CLI_TENANT);
  });

  it('ignores a blank/whitespace TEAMKB_EXPORT_DIR (never resolves to cwd)', () => {
    const ctx = resolveCliContext({ TEAMKB_EXPORT_DIR: '   ' });
    // Must fall back to the default <base>/kb-export, NOT resolve('') === cwd().
    expect(ctx.exportDir.endsWith('/kb-export')).toBe(true);
    expect(ctx.exportDir).not.toBe(process.cwd());
  });

  it('trims surrounding whitespace on TEAMKB_EXPORT_DIR', () => {
    const ctx = resolveCliContext({ TEAMKB_EXPORT_DIR: '  /tmp/some/export  ' });
    expect(ctx.exportDir).toBe('/tmp/some/export');
  });
});

describe('run', () => {
  const env = { TEAMKB_TENANT_ID: 'test-tenant', TEAMKB_EXPORT_DIR: '/tmp/e' };

  it('reindex returns 0 and reports created collections', async () => {
    const { mock, makeAdapter } = makeInjected();
    mock.queueSuccess(''); // list
    for (let i = 0; i < 4; i++) mock.queueSuccess(''); // adds
    mock.queueSuccess('Updated'); // update
    const logs: string[] = [];

    const code = await run(['reindex'], { env, makeAdapter, log: (m) => logs.push(m) });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('reindex OK');
    expect(logs.join('\n')).toContain('kb-curated');
  });

  it('reindex returns 1 on failure', async () => {
    const { mock, makeAdapter } = makeInjected();
    mock.queueSuccess(''); // list
    mock.queueFailure('boom'); // first add fails
    const errs: string[] = [];

    const code = await run(['reindex'], { env, makeAdapter, errLog: (m) => errs.push(m) });

    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('reindex FAILED');
  });

  it('canary returns 0 when healthy', async () => {
    const { mock, makeAdapter } = makeInjected();
    for (const _ of DEFAULT_CANARY_CONTROLS) mock.queueSuccess(hitsJson(3));
    const logs: string[] = [];

    const code = await run(['canary'], { env, makeAdapter, log: (m) => logs.push(m) });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('SEARCH HEALTHY');
  });

  it('canary returns 1 (loud failure) when a control returns 0 hits', async () => {
    const { mock, makeAdapter } = makeInjected();
    // One control degraded; rest OK — queue length must match DEFAULT_CANARY_CONTROLS.
    for (let i = 0; i < DEFAULT_CANARY_CONTROLS.length; i++) {
      mock.queueSuccess(hitsJson(i === 1 ? 0 : 1));
    }
    const logs: string[] = [];

    const code = await run(['canary'], { env, makeAdapter, log: (m) => logs.push(m) });

    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('SEARCH DEGRADED');
  });

  it('canary --heal reindexes then re-checks', async () => {
    const { mock, makeAdapter } = makeInjected();
    const singleEnv = { ...env };
    // Pass 1: first control 0 hits (degraded), rest OK
    for (let i = 0; i < DEFAULT_CANARY_CONTROLS.length; i++) {
      mock.queueSuccess(hitsJson(i === 0 ? 0 : 2));
    }
    // heal reindex: list + 4 adds + update
    mock.queueSuccess('');
    for (let i = 0; i < 4; i++) mock.queueSuccess('');
    mock.queueSuccess('Updated');
    // Pass 2: all healthy
    for (const _ of DEFAULT_CANARY_CONTROLS) mock.queueSuccess(hitsJson(4));

    const code = await run(['canary', '--heal'], { env: singleEnv, makeAdapter });

    expect(code).toBe(0);
  });

  it('returns 2 on unknown command', async () => {
    const { makeAdapter } = makeInjected();
    const errs: string[] = [];
    const code = await run(['frobnicate'], { env, makeAdapter, errLog: (m) => errs.push(m) });
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('usage:');
  });

  // ─── canary --max-staleness-seconds (D2 staleness gate) ────────────────────

  it('canary fails (1) when measured staleness exceeds --max-staleness-seconds', async () => {
    const { mock, makeAdapter } = makeInjected();
    for (const _ of DEFAULT_CANARY_CONTROLS) mock.queueSuccess(hitsJson(3)); // controls all pass
    const logs: string[] = [];

    const code = await run(['canary', '--max-staleness-seconds', '86400'], {
      env,
      makeAdapter,
      makeStalenessProbe: () => () => 90_000,
      log: (m) => logs.push(m),
    });

    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('index staleness -> 90000s (max 86400s)');
  });

  it('canary passes (0) when staleness is within the threshold', async () => {
    const { mock, makeAdapter } = makeInjected();
    for (const _ of DEFAULT_CANARY_CONTROLS) mock.queueSuccess(hitsJson(3));

    const code = await run(['canary', '--max-staleness-seconds', '86400'], {
      env,
      makeAdapter,
      makeStalenessProbe: () => () => 60,
    });

    expect(code).toBe(0);
  });

  it('canary passes (0) on unmeasured staleness — e.g. the CI fixture brain with no DB', async () => {
    const { mock, makeAdapter } = makeInjected();
    for (const _ of DEFAULT_CANARY_CONTROLS) mock.queueSuccess(hitsJson(3));
    const logs: string[] = [];

    // The default probe against an env with no brain DB yields null (unmeasured);
    // modeled here with an explicit null probe.
    const code = await run(['canary', '--max-staleness-seconds', '86400'], {
      env,
      makeAdapter,
      makeStalenessProbe: () => () => null,
      log: (m) => logs.push(m),
    });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('index staleness -> unmeasured');
  });

  it('canary returns 2 (usage error) on an invalid --max-staleness-seconds value', async () => {
    const { makeAdapter } = makeInjected();
    const errs: string[] = [];

    const code = await run(['canary', '--max-staleness-seconds', 'tomorrow'], {
      env,
      makeAdapter,
      errLog: (m) => errs.push(m),
    });

    // A typo'd threshold must be a loud usage error, never a silently skipped gate.
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('--max-staleness-seconds');
  });
});
