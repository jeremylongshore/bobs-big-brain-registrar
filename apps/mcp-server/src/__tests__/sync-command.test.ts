import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RealQmdExecutor } from '@qmd-team-intent-kb/qmd-adapter';
import type { McpServerConfig } from '../config.js';
import { createServer } from '../server.js';
import { isQmdAvailable, runSync } from '../tools/sync.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function config(): McpServerConfig {
  const basePath = mkdtempSync(join(tmpdir(), 'qmd-sync-command-'));
  roots.push(basePath);
  return {
    tenantId: 'tenant one',
    basePath,
    spoolPath: join(basePath, 'spool'),
    dbPath: join(basePath, 'teamkb.db'),
    feedbackPath: join(basePath, 'feedback'),
  };
}

describe('MCP shared command selection', () => {
  it('binds sync to its config base and preserves explicit argv/environment', async () => {
    const cfg = config();
    cfg.qmdBinary = join(cfg.basePath, 'synthetic-qmd');
    writeFileSync(
      cfg.qmdBinary,
      `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),index:process.env.INDEX_PATH,config:process.env.QMD_CONFIG_DIR}));`,
      { mode: 0o700 },
    );
    vi.stubEnv('TEAMKB_BASE_PATH', '/ambient-unselected');
    vi.stubEnv('INDEX_PATH', '/ambient-poison');
    const result = await runSync(cfg);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['embed', '--index', 'index'],
      index: join(cfg.basePath, 'qmd-index', cfg.tenantId, 'cache', 'qmd', 'index.sqlite'),
      config: join(cfg.basePath, 'qmd-index', cfg.tenantId, 'config', 'qmd'),
    });
  });

  it('keeps MCP original version/embed limits while using the common executor', async () => {
    const budgets: number[] = [];
    vi.spyOn(RealQmdExecutor.prototype, 'execute').mockImplementation(async function (
      this: RealQmdExecutor,
      args,
    ) {
      budgets.push(this.timeoutFor(args));
      return { stdout: 'synthetic', stderr: '', exitCode: 0 };
    });
    const cfg = config();
    expect(await isQmdAvailable(cfg)).toBe(true);
    await runSync(cfg);
    expect(budgets).toEqual([5000, 120000]);
  });

  it('starts the actual built team entrypoint without selecting or spawning qmd', async () => {
    const cfg = config();
    const home = join(cfg.basePath, 'private-home');
    mkdirSync(home);
    const marker = join(cfg.basePath, 'unexpected-child');
    const guard = join(cfg.basePath, 'deny-child.mjs');
    writeFileSync(
      guard,
      `import cp from 'node:child_process';import {writeFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {Socket} from 'node:net';const refuse=kind=>{writeFileSync(${JSON.stringify(marker)},kind);throw new Error('synthetic operation refused');};Socket.prototype.connect=function(){return refuse('network-connect');};globalThis.fetch=async()=>refuse('fetch');for(const key of ['spawn','exec','execFile','spawnSync','execSync','execFileSync'])cp[key]=()=>{writeFileSync(${JSON.stringify(marker)},key);throw new Error('synthetic child probe refused');};syncBuiltinESMExports();`,
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', guard, fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
      env: {
        HOME: home,
        PATH: '/synthetic-empty-path',
        TEAMKB_BASE_PATH: join(home, 'brain'),
        TEAMKB_TENANT_ID: 'team-fixture',
        TEAMKB_API_URL: 'https://synthetic.invalid',
        TEAMKB_QMD_RUNTIME: 'broken declaration deliberately ignored in team mode',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'team-startup-fixture', version: '1' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('teamkb_sync');
      expect(existsSync(marker)).toBe(false);
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it('team mode neither selects nor probes local qmd, including forced withSync registration', async () => {
    const cfg = config();
    cfg.apiUrl = 'https://synthetic.invalid';
    cfg.qmdRuntime = { root: '/missing-owned-runtime', manifestSha256: '0'.repeat(64) };
    const execute = vi.spyOn(RealQmdExecutor.prototype, 'execute');
    expect(await isQmdAvailable(cfg)).toBe(false);
    await expect(runSync(cfg)).rejects.toThrow('local-only');
    const server = createServer(cfg, { withSync: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'owned-command-fixture', version: '1' });
    try {
      await Promise.all([server.connect(b), client.connect(a)]);
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('teamkb_sync');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
