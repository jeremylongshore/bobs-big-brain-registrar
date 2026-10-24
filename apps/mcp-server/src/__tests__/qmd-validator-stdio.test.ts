import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

async function waitForReaped(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const check = () => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return resolve();
        return reject(error);
      }
      if (Date.now() >= deadline) return reject(new Error('Owned qmd child was not reaped'));
      setTimeout(check, 10);
    };
    check();
  });
}

describe('actual pinned qmd MCP validator contract', () => {
  it(
    'initializes, converts schemas and rejects oversized query arrays offline on the verified runtime',
    { timeout: 30_000 },
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'qmd-validator-contract-'));
      const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@tobilu/qmd'))));
      const cliEntry = join(packageRoot, 'dist', 'cli', 'qmd.js');
      // qmd's installed launcher selects Node with package-lock or no Bun lock.
      // Refuse an unhandled runtime before relying on NODE_OPTIONS for isolation.
      expect(
        !existsSync(join(packageRoot, 'package-lock.json')) &&
          (existsSync(join(packageRoot, 'bun.lock')) || existsSync(join(packageRoot, 'bun.lockb'))),
      ).toBe(false);
      const runtimeLog = join(scratch, 'runtime.jsonl');
      const configDir = join(scratch, 'config');
      mkdirSync(configDir);
      const env = {
        ...getDefaultEnvironment(),
        PWD: scratch,
        TMPDIR: scratch,
        XDG_CONFIG_HOME: configDir,
        XDG_CACHE_HOME: join(scratch, 'cache'),
        QMD_CONFIG_DIR: configDir,
        INDEX_PATH: join(scratch, 'index.sqlite'),
        QMD_SOURCE_MODE: '0',
        LLAMA_LOG_LEVEL: 'error',
        GGML_LOG_LEVEL: 'error',
        GGML_BACKEND_SILENT: '1',
        BBB_QMD_RUNTIME_LOG: runtimeLog,
        NODE_OPTIONS: `--import=${new URL('./fixtures/deny-network.mjs', import.meta.url).href}`,
      };
      const runtimeRows = (): { kind: string; entry?: string; bun?: boolean }[] =>
        readFileSync(runtimeLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      const transport = new StdioClientTransport({
        // Run the same actual CLI entry verified below. Direct ownership lets
        // the SDK close/reap it without leaving qmd launcher's grandchild behind.
        command: process.execPath,
        args: [cliEntry, 'mcp', '--index', 'validator-contract'],
        env,
        cwd: scratch,
        stderr: 'pipe',
      });
      const client = new Client({ name: 'validator-contract', version: '1' });
      let pid: number | null = null;
      try {
        const launcher = join(packageRoot, 'bin', 'qmd');
        expect(
          execFileSync(process.execPath, [launcher, '--version'], {
            cwd: scratch,
            env,
            encoding: 'utf8',
            timeout: 10000,
          }),
        ).toContain('2.5.3');
        expect(runtimeRows()).toContainEqual(
          expect.objectContaining({ kind: 'runtime', entry: cliEntry, bun: false }),
        );
        await client.connect(transport);
        pid = transport.pid;
        const tools = await client.listTools();
        expect(tools.tools.find((tool) => tool.name === 'query')).toMatchObject({
          inputSchema: {
            properties: {
              searches: { type: 'array', minItems: 1, maxItems: 10 },
              limit: { default: 10 },
              rerank: { default: true },
            },
          },
        });
        expect(await client.callTool({ name: 'status', arguments: {} })).not.toMatchObject({
          isError: true,
        });
        const invalid = await client.callTool({
          name: 'query',
          arguments: { searches: Array.from({ length: 11 }, () => ({})) },
        });
        expect(invalid).toMatchObject({ isError: true });
        // Patched v4 rejects size before each missing type/query field is parsed.
        const diagnostic = JSON.stringify(invalid);
        expect(diagnostic).toContain('too_big');
        expect(diagnostic).not.toContain('invalid_type');
        expect(runtimeRows().filter((row) => row.kind === 'denied')).toEqual([]);
        expect(runtimeRows().filter((row) => row.entry === cliEntry)).toHaveLength(2);
        expect(existsSync(env.INDEX_PATH)).toBe(true);
      } finally {
        const ownedPid = pid ?? transport.pid;
        try {
          try {
            await client.close();
          } finally {
            await transport.close();
            // Wait for the directly owned child to be reaped, not just signalled.
            if (ownedPid !== null) await waitForReaped(ownedPid);
          }
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    },
  );
});
