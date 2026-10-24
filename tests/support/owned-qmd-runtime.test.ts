import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  existsSync,
  chmodSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hostPlatform,
  inventory,
  projectLock,
  sha256,
  verifyGraph,
  verifyRuntime,
} from '../../packages/qmd-runtime/lib/runtime-inventory.mjs';
import { initializedEnvironment } from '../../packages/qmd-runtime/bin/owned-qmd.mjs';
import { copyRuntimeClosure } from '../../scripts/lib/copy-qmd-runtime.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roots: string[] = [];

function upstreamHasHttpOption(args: string[]): boolean {
  const source = readFileSync(join(repo, 'node_modules/@tobilu/qmd/dist/cli/qmd.js'), 'utf8');
  // Review the pinned upstream grammar when its published CLI bytes change.
  expect(sha256(Buffer.from(source))).toBe(
    '2fb0da8887e4cac6fca35a11895b3b9ce8f2ecd677ab7590c069bd564003939d',
  );
  const start = source.indexOf(
    'const { values, positionals } = parseArgs({',
    source.indexOf('function parseCLI()'),
  );
  const end = source.indexOf('\n    });', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // Evaluate only the published parseArgs call: no qmd module import or CLI startup.
  const values: unknown = runInNewContext(
    `${source.slice(start, end + '\n    });'.length)}\nvalues`,
    {
      parseArgs,
      process: { argv: ['node', 'qmd.js', ...args] },
    },
  );
  if (values === null || typeof values !== 'object')
    throw new Error('Upstream parser returned no values');
  return Object.hasOwn(values, 'http');
}

const lock = () => ({
  importers: {
    'packages/qmd-runtime': {
      dependencies: { '@tobilu/qmd': { specifier: '2.5.3', version: '2.5.3' } },
    },
  },
  packages: {
    '@tobilu/qmd@2.5.3': { resolution: { integrity: 'sha512-expected-qmd' } },
    '@modelcontextprotocol/sdk@1.32.2': { resolution: { integrity: 'sha512-expected-sdk' } },
    'zod@4.6.7': { resolution: { integrity: 'sha512-expected-zod' } },
    'native-foreign@1.0.0': {
      resolution: { integrity: 'sha512-foreign' },
      os: ['impossible-fixture-os'],
    },
  },
  snapshots: {
    '@tobilu/qmd@2.5.3': {
      dependencies: { '@modelcontextprotocol/sdk': '1.32.2', zod: '4.6.7' },
      optionalDependencies: { 'native-foreign': '1.0.0' },
    },
    '@modelcontextprotocol/sdk@1.32.2': { dependencies: { zod: '4.6.7' } },
    'zod@4.6.7': {},
    'native-foreign@1.0.0': {},
  },
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'bbb-owned-qmd-fixture-'));
  roots.push(base);
  const root = join(base, 'candidate');
  const modules = join(root, 'node_modules');
  for (const [name, version] of [
    ['@tobilu/qmd', '2.5.3'],
    ['@modelcontextprotocol/sdk', '1.32.2'],
    ['zod', '4.6.7'],
  ]) {
    const dir = join(modules, name!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module' }));
  }
  const qmd = join(modules, '@tobilu/qmd');
  mkdirSync(join(qmd, 'bin'));
  mkdirSync(join(qmd, 'dist/cli'), { recursive: true });
  copyFileSync(join(repo, 'node_modules/@tobilu/qmd/bin/qmd'), join(qmd, 'bin/qmd'));
  writeFileSync(
    join(qmd, 'dist/cli/qmd.js'),
    `
    if (process.argv[2] === 'exit23') process.exit(23);
    if (process.argv[2] === 'wait') { console.log('ready'); setInterval(() => {}, 100); }
    else console.log(JSON.stringify({execPath:process.execPath,args:process.argv.slice(2),quiet:process.env.LLAMA_LOG_LEVEL,ggml:process.env.GGML_LOG_LEVEL,silent:process.env.GGML_BACKEND_SILENT}));
  `,
  );
  for (const dir of ['bin', 'lib']) {
    mkdirSync(join(root, dir));
    const file = dir === 'bin' ? 'owned-qmd.mjs' : 'runtime-inventory.mjs';
    copyFileSync(join(repo, 'packages/qmd-runtime', dir, file), join(root, dir, file));
  }
  const projection = projectLock(lock(), 'packages/qmd-runtime');
  function seal(extra = {}) {
    const graph = verifyGraph(root, projection, hostPlatform());
    const files = inventory(root, { omit: ['runtime-manifest.json'] });
    writeFileSync(
      join(root, 'runtime-manifest.json'),
      JSON.stringify({
        schema: 'bbb-qmd-runtime/v1',
        projection,
        graph,
        inventory: files,
        platform: hostPlatform(),
        nodeAbi: process.versions.modules,
        ...extra,
      }),
    );
  }
  seal();
  return { base, root, modules, qmd, projection, seal };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('owned qmd candidate graph and inventory', () => {
  it('takes expected overrides and peer edges from lock snapshots, not original manifest pins', () => {
    const f = fixture();
    writeFileSync(
      join(f.qmd, 'package.json'),
      JSON.stringify({ name: '@tobilu/qmd', version: '2.5.3', dependencies: { zod: '4.2.1' } }),
    );
    expect(verifyGraph(f.root, f.projection, hostPlatform()).missingOptional).toHaveLength(1);
    const sdk = join(f.modules, '@modelcontextprotocol/sdk/package.json');
    writeFileSync(sdk, JSON.stringify({ name: '@modelcontextprotocol/sdk', version: '1.29.0' }));
    expect(() => verifyGraph(f.root, f.projection, hostPlatform())).toThrow(/differs from lock/);
  });
  it('refuses a changed resolved edge even when the correct package still exists elsewhere', () => {
    const f = fixture();
    const nested = join(f.modules, '@modelcontextprotocol/sdk/node_modules/zod');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'zod', version: '4.2.1' }));
    expect(() => verifyGraph(f.root, f.projection, hostPlatform())).toThrow(/differs from lock/);
  });
  it('refuses missing required and host-compatible optional dependencies', () => {
    const f = fixture();
    rmSync(join(f.modules, 'zod'), { recursive: true });
    expect(() => verifyGraph(f.root, f.projection, hostPlatform())).toThrow(/missing/);
    const g = fixture();
    g.projection.nodes['native-foreign@1.0.0'].os = [process.platform];
    expect(() => verifyGraph(g.root, g.projection, hostPlatform())).toThrow(
      /host-compatible optional/,
    );
  });
  it.each(['alias', 'wrong-physical-name'])('rejects undeclared module boundary: %s', (kind) => {
    const f = fixture();
    if (kind === 'alias') symlinkSync('zod', join(f.modules, 'extra-alias'));
    else {
      mkdirSync(join(f.modules, 'wrong-physical-name'));
      writeFileSync(
        join(f.modules, 'wrong-physical-name/package.json'),
        JSON.stringify({ name: 'zod', version: '4.6.7' }),
      );
    }
    expect(() => verifyGraph(f.root, f.projection, hostPlatform())).toThrow(
      /extra runtime package/,
    );
  });
  it.each(['outside', 'dangling'])('refuses %s link before content is accepted', (kind) => {
    const f = fixture();
    writeFileSync(join(f.base, 'outside'), 'private synthetic marker');
    symlinkSync(kind === 'outside' ? '../outside' : 'absent', join(f.root, 'bad-link'));
    expect(() => inventory(f.root)).toThrow();
  });
  it('refuses content tamper and does not trust recorded platform/ABI over actual host', () => {
    const f = fixture();
    expect(verifyRuntime(f.root).qmd).toBe(f.qmd);
    writeFileSync(join(f.qmd, 'dist/cli/qmd.js'), 'tamper');
    expect(() => verifyRuntime(f.root)).toThrow(/inventory mismatch/);
    f.seal({ nodeAbi: 'wrong' });
    expect(() => verifyRuntime(f.root)).toThrow(/host platform or Node ABI/);
    f.seal({ platform: { ...hostPlatform(), cpu: 'wrong' } });
    expect(() => verifyRuntime(f.root)).toThrow(/host platform or Node ABI/);
  });
  it('refuses an oversized candidate before reading its contents', () => {
    const f = fixture();
    expect(() => inventory(f.root, { maxBytes: 1 })).toThrow(/byte budget/);
  });
});

describe('fixed Node owned launcher', () => {
  it.each([
    ['mcp', '--http'],
    ['--http', 'mcp'],
    ['--index', 'index', '--http', 'mcp'],
    ['mcp', '--http', '--daemon', '--port', '8181'],
    ['mcp', '--http=true'],
    ['mcp', '--http=false'],
    ['mcp', '--http='],
    ['mcp', '--http', '--http='],
    ['mcp', '--http', '--no-http'],
    ['mcp', '--index', '--', '--http'],
    ['mcp', '-c', '--', '--http'],
    ['mcp', '-C', '--', '--http'],
  ])('refuses HTTP options before starting its synthetic child: %j', (...args) => {
    expect(upstreamHasHttpOption(args)).toBe(true);
    const f = fixture();
    const marker = join(f.base, 'child-started');
    writeFileSync(
      join(f.qmd, 'dist/cli/qmd.js'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');`,
    );
    f.seal();
    const result = spawnSync(process.execPath, [join(f.root, 'bin/owned-qmd.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    // No HTTP listener, service, model or real qmd module exists in this fixture.
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/standalone HTTP is unsupported.*stdio/i);
    expect(result.stdout).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['mcp'],
    ['mcp', '--index', 'index'],
    ['mcp', '--', '--http'],
    ['query', '--', '--http=false'],
    ['mcp', '--port', '--http'],
    ['mcp', '--port=--http'],
    ['mcp', '--index=--http'],
    ['mcp', '-c', '--http'],
    ['mcp', '-C--http'],
    ['mcp', '--context', '--http'],
    ['mcp', '--intent', '--http'],
    ['mcp', '--daemon'],
    ['mcp', '--index'],
    ['mcp', '--unknown=value', '--', '--http'],
  ])('preserves non-HTTP and literal option-shaped arguments: %j', (...args) => {
    expect(upstreamHasHttpOption(args)).toBe(false);
    const f = fixture();
    const result = spawnSync(process.execPath, [join(f.root, 'bin/owned-qmd.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ execPath: process.execPath, args });
  });

  it('runs physical and symlink entrypoints with literal arguments and the canonical runtime root', () => {
    const f = fixture();
    const entry = join(f.root, 'bin/owned-qmd.mjs');
    const alias = join(f.base, 'owned-qmd-link.mjs');
    symlinkSync(entry, alias);
    const args = ['literal; $(not-a-shell)', '--', '--index'];
    for (const invocation of [[entry], [alias]]) {
      const result = spawnSync(process.execPath, [...invocation, ...args], {
        env: process.env,
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ execPath: process.execPath, args });
    }
  });
  it('does not launch when imported with absent or unresolvable entrypoint arguments', () => {
    const f = fixture();
    const url = pathToFileURL(join(f.root, 'bin/owned-qmd.mjs')).href;
    for (const argv of ['undefined', JSON.stringify(join(f.base, 'missing-entry.mjs'))]) {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `process.argv[1] = ${argv}; await import(${JSON.stringify(url)}); console.log('imported-only');`,
        ],
        { env: process.env, encoding: 'utf8', timeout: 5_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('imported-only\n');
    }
  });
  it('runs only published dist with fixed execPath and literal arguments despite hostile PATH/source-mode', () => {
    const f = fixture();
    const marker = join(f.base, 'unwanted');
    for (const name of ['node', 'bun']) {
      writeFileSync(join(f.base, name), `#!/bin/sh\nprintf bad > '${marker}'\nexit 99\n`, {
        mode: 0o700,
      });
    }
    const result = spawnSync(
      process.execPath,
      [
        join(f.root, 'bin/owned-qmd.mjs'),
        'mcp',
        '--index',
        'index',
        '--',
        'literal; $(not-a-shell)',
      ],
      {
        env: {
          ...process.env,
          PATH: f.base,
          QMD_SOURCE_MODE: '1',
          LLAMA_LOG_LEVEL: '',
          GGML_LOG_LEVEL: '',
          GGML_BACKEND_SILENT: '',
        },
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      execPath: process.execPath,
      args: ['mcp', '--index', 'index', '--', 'literal; $(not-a-shell)'],
      quiet: 'error',
      ggml: 'error',
      silent: '1',
    });
    expect(() => readFileSync(marker)).toThrow();
  });
  it('retains explicit quiet values and Darwin opt-in while matching default initialization', () => {
    expect(
      initializedEnvironment(
        ['mcp'],
        { LLAMA_LOG_LEVEL: 'warn', QMD_METAL_KEEP_RESIDENCY: '1' },
        'darwin',
      ),
    ).toEqual({
      LLAMA_LOG_LEVEL: 'warn',
      QMD_METAL_KEEP_RESIDENCY: '1',
      GGML_LOG_LEVEL: 'error',
      GGML_BACKEND_SILENT: '1',
    });
    expect(initializedEnvironment(['status'], {}, 'darwin')).toEqual({
      GGML_METAL_NO_RESIDENCY: '1',
    });
    expect(initializedEnvironment(['status'], { GGML_METAL_NO_RESIDENCY: '0' }, 'darwin')).toEqual({
      GGML_METAL_NO_RESIDENCY: '0',
    });
    expect(initializedEnvironment(['status'], {}, 'linux')).toEqual({});
  });
  it('preserves a real child nonzero exit', () => {
    const f = fixture();
    const result = spawnSync(process.execPath, [join(f.root, 'bin/owned-qmd.mjs'), 'exit23'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(23);
  });
  it.skipIf(process.platform === 'win32')(
    'forwards interruption and bounds cleanup of its owned POSIX group',
    async () => {
      const f = fixture();
      const child = spawn(process.execPath, [join(f.root, 'bin/owned-qmd.mjs'), 'wait'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        },
      );
      void terminal.catch(() => {});
      async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout>;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Owned fixture terminal timeout')), ms);
            }),
          ]);
        } finally {
          clearTimeout(timer!);
        }
      }
      const groupAlive = () => {
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      };
      try {
        await bounded(
          new Promise<void>((resolve, reject) => {
            const ready = () => {
              cleanup();
              resolve();
            };
            const closed = () => {
              cleanup();
              reject(new Error('Child closed before readiness'));
            };
            const cleanup = () => {
              child.stdout.removeListener('data', ready);
              child.removeListener('close', closed);
            };
            child.stdout.once('data', ready);
            child.once('close', closed);
          }),
          3_000,
        );
        child.kill('SIGTERM');
        expect(await bounded(terminal, 3_000)).toEqual({ code: null, signal: 'SIGTERM' });
      } finally {
        if (groupAlive()) process.kill(-child.pid!, 'SIGKILL');
        await bounded(terminal, 2_000);
        const deadline = Date.now() + 2_000;
        while (groupAlive() && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        expect(groupAlive()).toBe(false);
      }
    },
  );
});

describe('lock-projection source closure copier', () => {
  function copyFixture() {
    const f = fixture();
    const native = join(f.modules, 'zod/build/Release/synthetic.node');
    mkdirSync(dirname(native), { recursive: true });
    // Synthetic bytes only. This fixture never imports or executes a native addon.
    const bytes = Buffer.from('synthetic already-built-file marker');
    writeFileSync(native, bytes);
    chmodSync(native, 0o640);
    const graph = verifyGraph(f.root, f.projection, hostPlatform());
    const target = join(f.base, 'copied');
    const copy = () =>
      copyRuntimeClosure({ sourceRoot: f.root, target, projection: f.projection, graph });
    return { ...f, target, graph, bytes, copy };
  }

  function sealCopied(f: ReturnType<typeof copyFixture>) {
    for (const dir of ['bin', 'lib']) {
      mkdirSync(join(f.target, dir));
      const file = dir === 'bin' ? 'owned-qmd.mjs' : 'runtime-inventory.mjs';
      copyFileSync(join(f.root, dir, file), join(f.target, dir, file));
    }
    const graph = verifyGraph(f.target, f.projection, hostPlatform());
    writeFileSync(
      join(f.target, 'runtime-manifest.json'),
      JSON.stringify({
        schema: 'bbb-qmd-runtime/v1',
        projection: f.projection,
        graph,
        inventory: inventory(f.target),
        platform: hostPlatform(),
        nodeAbi: process.versions.modules,
      }),
    );
    return graph;
  }

  it('preserves synthetic built-file bytes/modes and locked override edges after relocation', () => {
    const f = copyFixture();
    const result = f.copy();
    expect(result.snapshots).toBe(3);
    const graph = sealCopied(f);
    const native = join(
      f.target,
      graph.directories['zod@4.6.7'][0],
      'build/Release/synthetic.node',
    );
    expect(readFileSync(native)).toEqual(f.bytes);
    expect(
      inventory(f.target).entries[
        graph.directories['zod@4.6.7'][0] + '/build/Release/synthetic.node'
      ].mode,
    ).toBe(0o640);
    expect(existsSync(join(f.target, 'node_modules/zod'))).toBe(false);
    const poison = join(f.base, 'node_modules/zod');
    mkdirSync(poison, { recursive: true });
    writeFileSync(join(poison, 'package.json'), JSON.stringify({ name: 'zod', version: '4.2.1' }));
    const moved = join(f.base, 'relocated');
    renameSync(f.target, moved);
    expect(verifyRuntime(moved).manifest.graph).toEqual(graph);
  });

  it('rejects a missing copied edge and an undeclared root alias instead of accepting parent fallback', () => {
    const f = copyFixture();
    f.copy();
    const graph = verifyGraph(f.target, f.projection, hostPlatform());
    const qmd = join(f.target, graph.directories[f.projection.root][0]);
    const original = readlinkSync(join(qmd, 'node_modules/zod'));
    rmSync(join(qmd, 'node_modules/zod'));
    expect(() => verifyGraph(f.target, f.projection, hostPlatform())).toThrow(/missing/);
    symlinkSync(original, join(qmd, 'node_modules/zod'));
    symlinkSync('../' + graph.directories['zod@4.6.7'][0], join(f.target, 'node_modules/zod'));
    expect(() => verifyGraph(f.target, f.projection, hostPlatform())).toThrow(
      /extra runtime package/,
    );
  });

  it('rejects changed copied built-file bytes through the sealed inventory', () => {
    const f = copyFixture();
    f.copy();
    const graph = sealCopied(f);
    expect(verifyRuntime(f.target).manifest.schema).toBe('bbb-qmd-runtime/v1');
    writeFileSync(
      join(f.target, graph.directories['zod@4.6.7'][0], 'build/Release/synthetic.node'),
      'changed',
    );
    expect(() => verifyRuntime(f.target)).toThrow(/inventory mismatch/);
  });

  it.each(['../../escape', '/absolute', '@scope/../escape', 'back\\slash'])(
    'refuses unsafe alias %s before creating any target',
    (name) => {
      const f = copyFixture();
      f.projection.nodes[f.projection.root].dependencies[name] = 'zod@4.6.7';
      expect(f.copy).toThrow(/Unsafe package or alias/);
      expect(existsSync(f.target)).toBe(false);
    },
  );

  it.each(['outside', 'dangling'])(
    'refuses %s installed source link before creating any target',
    (kind) => {
      const f = copyFixture();
      const outside = join(f.base, 'outside');
      writeFileSync(outside, 'synthetic');
      symlinkSync(kind === 'outside' ? outside : 'absent', join(f.modules, 'zod/bad-link'));
      expect(f.copy).toThrow();
      expect(existsSync(f.target)).toBe(false);
    },
  );

  it('refuses a byte budget breach and unequal installed copies before writes', () => {
    const f = copyFixture();
    expect(() =>
      copyRuntimeClosure({
        sourceRoot: f.root,
        target: f.target,
        projection: f.projection,
        graph: f.graph,
        maxBytes: 1,
      }),
    ).toThrow(/byte budget/);
    expect(existsSync(f.target)).toBe(false);
    const alternate = join(f.root, 'alternate-zod');
    mkdirSync(alternate);
    writeFileSync(
      join(alternate, 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.6.7' }),
    );
    f.graph.directories['zod@4.6.7'].push('alternate-zod');
    expect(f.copy).toThrow(/unequal installed source copies/);
    expect(existsSync(f.target)).toBe(false);
  });
});
