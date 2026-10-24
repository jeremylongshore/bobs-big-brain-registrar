import {
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
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getQmdTenantEnv, getQmdTenantIndexPath, withQmdTenantSelector } from '../config.js';
import { inspectOwnedQmdRuntime, resolveQmdCommand } from '../executor/resolve-command.js';
import { RealQmdExecutor } from '../executor/real-executor.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('declared owned qmd selection', () => {
  it('refuses broken declared ownership without executing a legacy PATH binary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qmd-owned-selection-'));
    roots.push(root);
    const marker = join(root, 'legacy-ran');
    writeFileSync(join(root, 'qmd'), `#!/bin/sh\nprintf legacy > '${marker}'\n`, {
      mode: 0o700,
    });
    vi.stubEnv('PATH', root);
    vi.stubEnv('TEAMKB_QMD_BIN', '');
    vi.stubEnv(
      'TEAMKB_QMD_RUNTIME',
      JSON.stringify({ root: join(root, 'missing'), manifestSha256: '0'.repeat(64) }),
    );
    const result = await new RealQmdExecutor().execute(['--version']);
    expect({ exitCode: result.exitCode, legacySpawned: existsSync(marker) }).toEqual({
      exitCode: 127,
      legacySpawned: false,
    });
  });
});

const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
function fixture(source?: string) {
  const root = mkdtempSync(join(tmpdir(), 'qmd-command-fixture-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'lib'));
  const files = {
    'bin/owned-qmd.mjs':
      source ??
      `console.log(JSON.stringify({args:process.argv.slice(2),index:process.env.INDEX_PATH,config:process.env.QMD_CONFIG_DIR,node:process.execPath}));`,
    'lib/runtime-inventory.mjs': 'export const synthetic = true;',
  };
  const entries: Record<string, unknown> = {};
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(root, name), bytes, { mode: 0o600 });
    entries[name] = {
      kind: 'file',
      bytes: Buffer.byteLength(bytes),
      mode: statSync(join(root, name)).mode & 0o777,
      sha256: hash(bytes),
    };
  }
  const manifest = {
    schema: 'bbb-qmd-runtime/v1',
    platform: {
      os: process.platform,
      cpu: process.arch,
      libc: process.platform === 'linux' ? 'glibc' : 'none',
    },
    nodeAbi: process.versions.modules,
    lockSha256: 'a'.repeat(64),
    sourceSnapshot: { baseCommit: 'b'.repeat(40), uncommittedCandidate: true },
    sourceFiles: { 'synthetic/source': 'c'.repeat(64) },
    inventory: { entries },
    projection: {
      root: 'qmd',
      nodes: {
        qmd: {
          name: '@tobilu/qmd',
          version: '2.5.3',
          dependencies: { '@modelcontextprotocol/sdk': 'sdk', zod: 'zod' },
        },
        sdk: { name: '@modelcontextprotocol/sdk', version: '1.32.2' },
        zod: { name: 'zod', version: '4.6.7' },
      },
    },
  };
  const bytes = JSON.stringify(manifest);
  writeFileSync(join(root, 'runtime-manifest.json'), bytes);
  return { root, manifestSha256: hash(bytes) };
}

// These synthetic entrypoints prove selection and argv/env binding, not full closure/native execution.
describe('owned command metadata and routing contracts', () => {
  it('uses fixed Node and literal prefix arguments with config-bound tenant paths', async () => {
    const owned = fixture();
    vi.stubEnv('TEAMKB_QMD_BIN', '');
    vi.stubEnv('INDEX_PATH', 'ambient-poison');
    vi.stubEnv('QMD_CONFIG_DIR', 'ambient-poison');
    const executor = new RealQmdExecutor({
      ownedRuntime: owned,
      tenant: { id: 'team name', basePath: owned.root },
    });
    const result = await executor.execute(['search', '--', '--index', 'hostile literal']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['search', '--index', 'index', '--', '--index', 'hostile literal'],
      index: join(owned.root, 'qmd-index', 'team name', 'cache', 'qmd', 'index.sqlite'),
      config: join(owned.root, 'qmd-index', 'team name', 'config', 'qmd'),
      node: process.execPath,
    });
    expect(executor.commandProvenance).toMatchObject({
      source: 'owned',
      executable: process.execPath,
      runtime: {
        manifestSha256: owned.manifestSha256,
        sourceSnapshot: { baseCommit: 'b'.repeat(40), uncommittedCandidate: true },
      },
    });
    expect(Object.isFrozen(executor.commandProvenance)).toBe(true);
  });

  it('preserves explicit binary verbatim and env pin precedence over a broken declaration', () => {
    const broken = { root: '/missing-owned-fixture', manifestSha256: '0'.repeat(64) };
    expect(
      resolveQmdCommand({ explicit: 'bare fixture command', ownedRuntime: broken }).executable,
    ).toBe('bare fixture command');
    expect(
      resolveQmdCommand({
        ownedRuntime: broken,
        env: { TEAMKB_QMD_BIN: '/synthetic/pinned' },
        isExecutable: (p) => p === '/synthetic/pinned',
      }),
    ).toMatchObject({ executable: '/synthetic/pinned', prefix: [], provenance: { source: 'env' } });
  });

  it('prefers a paired config declaration over malformed env and caches successful selection', async () => {
    const owned = fixture();
    vi.stubEnv('TEAMKB_QMD_BIN', '');
    vi.stubEnv('TEAMKB_QMD_RUNTIME', 'invalid-json');
    const executor = new RealQmdExecutor({ ownedRuntime: owned });
    expect((await executor.execute(['--version'])).exitCode).toBe(0);
    vi.stubEnv('TEAMKB_QMD_BIN', '/missing-new-pin');
    expect((await executor.execute(['--version'])).exitCode).toBe(0);
    writeFileSync(join(owned.root, 'bin/owned-qmd.mjs'), 'throw new Error("tampered");');
    const refused = await executor.execute(['--version']);
    expect(refused.exitCode).toBe(127);
    expect(refused.stderr).toContain('bound manifest');
  });

  it.each(['', '{}', 'not-json'])(
    'refuses malformed declared JSON %j without probing legacy',
    (value) => {
      let probes = 0;
      expect(() =>
        resolveQmdCommand({
          env: { TEAMKB_QMD_RUNTIME: value },
          isExecutable: () => {
            probes++;
            return true;
          },
        }),
      ).toThrow('No legacy fallback');
      expect(probes).toBe(0);
    },
  );

  it('does not cache failure, and retries after declaration repair', async () => {
    vi.stubEnv('TEAMKB_QMD_BIN', '');
    vi.stubEnv('TEAMKB_QMD_RUNTIME', 'broken');
    const executor = new RealQmdExecutor();
    expect((await executor.execute(['--version'])).exitCode).toBe(127);
    vi.stubEnv('TEAMKB_QMD_RUNTIME', JSON.stringify(fixture()));
    expect((await executor.execute(['--version'])).exitCode).toBe(0);
  });

  it('keeps command classification ahead of the owned prefix and explicit selector', async () => {
    const owned = fixture(
      `await new Promise(r=>setTimeout(r,300));console.log('maintenance-finished');`,
    );
    vi.stubEnv('TEAMKB_QMD_BIN', '');
    const executor = new RealQmdExecutor({
      ownedRuntime: owned,
      tenant: { id: 'team', basePath: owned.root },
      timeout: 100,
      maintenanceTimeout: 2000,
    });
    expect((await executor.execute(['embed'])).stdout).toContain('maintenance-finished');
    const refused = await executor.execute(['search', '--', 'literal']);
    expect(refused).toMatchObject({
      exitCode: 124,
      failure: { kind: 'timeout', timeoutMs: 100, groupTerminated: true },
    });
  });

  it('refuses oversized source metadata before executing its entrypoint', () => {
    const owned = fixture();
    writeFileSync(join(owned.root, 'bin/owned-qmd.mjs'), 'x'.repeat(128 * 1024 + 1));
    expect(() => inspectOwnedQmdRuntime(owned)).toThrow('oversized');
    writeFileSync(join(owned.root, 'runtime-manifest.json'), 'x'.repeat(8 * 1024 * 1024 + 1));
    expect(() => inspectOwnedQmdRuntime(owned)).toThrow('oversized');
  });

  it('requires expected digest and matching platform/ABI before launch', () => {
    const owned = fixture();
    expect(() => inspectOwnedQmdRuntime({ ...owned, manifestSha256: '0'.repeat(64) })).toThrow(
      'SHA256 mismatch',
    );
    const path = join(owned.root, 'runtime-manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.nodeAbi = 'foreign-abi';
    const bytes = JSON.stringify(manifest);
    writeFileSync(path, bytes);
    expect(() => inspectOwnedQmdRuntime({ ...owned, manifestSha256: hash(bytes) })).toThrow(
      'matching Node ABI',
    );
  });

  it.each(['bin', 'lib', 'bin/owned-qmd.mjs', 'runtime-manifest.json'])(
    'rejects nested redirect %s even with identical bound small-file bytes',
    (relative) => {
      const owned = fixture();
      const nested = join(owned.root, 'nested');
      mkdirSync(nested);
      const moved = join(nested, relative.replaceAll('/', '-'));
      renameSync(join(owned.root, relative), moved);
      symlinkSync(moved, join(owned.root, relative));
      expect(() => inspectOwnedQmdRuntime(owned)).toThrow(/redirected|cannot be read/);
    },
  );

  it.each(['bin', 'bin/owned-qmd.mjs', 'lib/runtime-inventory.mjs'])(
    'refuses a complete second candidate redirect at %s before its sentinel executes',
    async (relative) => {
      const source = `import {readFileSync,writeFileSync} from 'node:fs';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';const root=dirname(dirname(fileURLToPath(import.meta.url)));const manifest=JSON.parse(readFileSync(join(root,'runtime-manifest.json'),'utf8'));if(manifest.sentinel)writeFileSync(manifest.sentinel,'misbound-root');`;
      const outer = fixture(source);
      const second = fixture(source);
      const nested = join(outer.root, 'second-candidate');
      renameSync(second.root, nested);
      const sentinel = join(outer.root, 'wrong-root-executed');
      const manifestPath = join(nested, 'runtime-manifest.json');
      const secondManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      secondManifest.sentinel = sentinel;
      writeFileSync(manifestPath, JSON.stringify(secondManifest));
      expect(hash(readFileSync(manifestPath))).not.toBe(outer.manifestSha256);
      rmSync(join(outer.root, relative), { recursive: true });
      symlinkSync(join(nested, relative), join(outer.root, relative));
      vi.stubEnv('TEAMKB_QMD_BIN', '');
      const result = await new RealQmdExecutor({ ownedRuntime: outer }).execute(['--version']);
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('declared root');
      expect(existsSync(sentinel)).toBe(false);
    },
  );

  it('allows canonical root aliases while retaining declaration provenance', () => {
    const owned = fixture();
    const alias = join(owned.root, 'root-alias');
    symlinkSync(owned.root, alias);
    expect(inspectOwnedQmdRuntime({ ...owned, root: alias })).toMatchObject({
      root: owned.root,
      declaredRoot: alias,
    });
  });

  it('accounts for real metadata selection before spawning under the original deadline', async () => {
    const owned = fixture('throw new Error("must not launch");');
    vi.stubEnv('TEAMKB_QMD_BIN', '');
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(131);
    const executor = new RealQmdExecutor({
      ownedRuntime: owned,
      timeout: 30,
      maintenanceTimeout: 600,
    });
    const result = await executor.execute(['search', 'literal']);
    now.mockRestore();
    expect(result).toMatchObject({
      exitCode: 124,
      failure: { kind: 'timeout', timeoutMs: 30, elapsedMs: 31, groupTerminated: true },
    });
    expect(executor.commandProvenance?.source).toBe('owned');
    expect(executor.timeoutFor(['embed'])).toBe(600);
    expect(executor.timeoutFor(['collection', 'add', 'fixture'])).toBe(600);
  });

  it('preserves tenant registry/cache locations and rejects path aliases without imposing a slug', () => {
    const owned = fixture();
    expect(getQmdTenantEnv('team name', owned.root)).toMatchObject({
      QMD_CONFIG_DIR: join(owned.root, 'qmd-index', 'team name', 'config', 'qmd'),
      INDEX_PATH: join(owned.root, 'qmd-index', 'team name', 'cache', 'qmd', 'index.sqlite'),
    });
    expect(getQmdTenantIndexPath('équipe/notes', owned.root)).toBe(
      join(owned.root, 'qmd-index', 'équipe', 'notes'),
    );
    for (const tenant of ['../outside', '/absolute', 'a/../b', 'a//b', ''])
      expect(() => getQmdTenantIndexPath(tenant, owned.root)).toThrow();
    expect(withQmdTenantSelector(['collection', 'add', 'source'])).toEqual([
      'collection',
      'add',
      'source',
      '--index',
      'index',
    ]);
    expect(withQmdTenantSelector(['search', '--', '--index'])).toEqual([
      'search',
      '--index',
      'index',
      '--',
      '--index',
    ]);
  });
});

describe('cold tenant directory preparation', () => {
  it('starts from absent cache/config parents and preserves existing files on repeat', async () => {
    const owned = fixture(
      `import {existsSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const index=process.env.INDEX_PATH;const registry=join(process.env.QMD_CONFIG_DIR,'index.yml');if(!existsSync(index))writeFileSync(index,'synthetic-index',{flag:'wx'});if(!existsSync(registry))writeFileSync(registry,'collections: {}',{flag:'wx'});console.log('cold-tenant-ready');`,
    );
    const base = join(owned.root, 'cold-brain');
    const tenant = join(base, 'qmd-index', 'cold-team');
    const index = join(tenant, 'cache', 'qmd', 'index.sqlite');
    const registry = join(tenant, 'config', 'qmd', 'index.yml');
    vi.stubEnv('TEAMKB_QMD_BIN', '');
    const executor = new RealQmdExecutor({
      ownedRuntime: owned,
      tenant: { id: 'cold-team', basePath: base },
      env: {
        INDEX_PATH: join(owned.root, 'ambient', 'index.sqlite'),
        QMD_CONFIG_DIR: join(owned.root, 'ambient-config'),
      },
    });
    expect(existsSync(base)).toBe(false);
    const result = await executor.execute(['collection', 'add', 'synthetic-source']);
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: '',
    });
    expect(result.stdout).toContain('cold-tenant-ready');
    writeFileSync(index, 'preserve-existing-index');
    writeFileSync(registry, 'preserve-existing-registry');
    expect((await executor.execute(['status'])).exitCode).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe('preserve-existing-index');
    expect(readFileSync(registry, 'utf8')).toBe('preserve-existing-registry');
    expect(existsSync(join(owned.root, 'ambient'))).toBe(false);
    expect(existsSync(join(owned.root, 'ambient-config'))).toBe(false);
  });

  it('reports an obstructed tenant parent without spawning the selected child', async () => {
    const owned = fixture();
    const marker = join(owned.root, 'child-ran');
    const binary = join(owned.root, 'selected-child');
    writeFileSync(
      binary,
      `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected');`,
      { mode: 0o700 },
    );
    const base = join(owned.root, 'brain');
    const tenant = join(base, 'qmd-index', 'blocked');
    mkdirSync(tenant, { recursive: true });
    writeFileSync(join(tenant, 'cache'), 'obstructed');
    const result = await new RealQmdExecutor({
      binary,
      tenant: { id: 'blocked', basePath: base },
    }).execute(['status']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('tenant directories');
    expect(existsSync(marker)).toBe(false);
  });

  it.each(['invalid tenant', 'broken owned declaration'])(
    'validates %s before creating any tenant directories',
    async (kind) => {
      const owned = fixture();
      const marker = join(owned.root, 'child-ran');
      const binary = join(owned.root, 'selected-child');
      writeFileSync(
        binary,
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected');`,
        { mode: 0o700 },
      );
      const base = join(owned.root, 'never-created');
      vi.stubEnv('TEAMKB_QMD_BIN', '');
      const executor = new RealQmdExecutor({
        ...(kind === 'invalid tenant'
          ? { binary }
          : {
              ownedRuntime: {
                root: join(owned.root, 'missing'),
                manifestSha256: owned.manifestSha256,
              },
            }),
        tenant: { id: kind === 'invalid tenant' ? '../outside' : 'valid', basePath: base },
      });
      expect((await executor.execute(['status'])).exitCode).toBe(127);
      expect(existsSync(base)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(base, 'outside'))).toBe(false);
    },
  );
});
