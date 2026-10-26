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
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function pinnedUpstreamParseCall(): string {
  const source = readFileSync(join(repo, 'node_modules/@tobilu/qmd/dist/cli/qmd.js'), 'utf8');
  // Keep this explicit-upgrade tripwire even when all copied option fields agree.
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
  return source.slice(start, end + '\n    });'.length);
}

function upstreamHasHttpOption(args: string[]): boolean {
  // Evaluate only the published parseArgs call: no qmd module import or CLI startup.
  const values: unknown = runInNewContext(
    `${pinnedUpstreamParseCall()}\nvalues`,
    {
      parseArgs,
      process: { argv: ['node', 'qmd.js', ...args] },
    },
    { timeout: 1000 },
  );
  if (values === null || typeof values !== 'object')
    throw new Error('Upstream parser returned no values');
  return Object.hasOwn(values, 'http');
}

function ownedParseCall(source: string): string {
  const tableStart = source.indexOf('const cliOptions = {');
  const tableEnd = source.indexOf('\n};', tableStart);
  const callStart = source.indexOf('({ tokens } = parseArgs({', tableEnd);
  const callEnd = source.indexOf('\n    }));', callStart);
  if (tableStart < 0 || tableEnd < tableStart || callStart < tableEnd || callEnd < callStart)
    throw new Error('Owned parser metadata extraction needs review');
  return `${source.slice(tableStart, tableEnd + '\n};'.length)}\nlet tokens;\n${source.slice(callStart, callEnd + '\n    }));'.length)}`;
}

/** Reject properties structuredClone would omit or evaluate; preserve supported values. */
function snapshotMetadata(
  value: unknown,
  prototypes: { object: object; array: object } = {
    object: Object.prototype,
    array: Array.prototype,
  },
): Record<string, unknown> {
  const active = new Set<object>();
  function inspect(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    const prototype = Object.getPrototypeOf(node);
    const expectedPrototype = Array.isArray(node) ? prototypes.array : prototypes.object;
    if (prototype !== null && prototype !== expectedPrototype)
      throw new Error('Inherited parser metadata needs review');
    if (active.has(node)) throw new Error('Cyclic parser metadata needs review');
    active.add(node);
    for (const key of Reflect.ownKeys(node)) {
      const property = Object.getOwnPropertyDescriptor(node, key)!;
      if (Array.isArray(node) && key === 'length') continue;
      if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value'))
        throw new Error('Unsupported parser metadata property needs review');
      inspect(property.value);
    }
    active.delete(node);
  }
  inspect(value);
  // Unlike JSON, structuredClone preserves undefined, NaN, infinities, BigInt and -0.
  // Function/symbol values refuse instead of being silently omitted.
  return structuredClone(value) as Record<string, unknown>;
}

function parserConfiguration(program: string): Record<string, unknown> {
  const capture = vi.fn((_config: unknown) => ({ values: {}, positionals: [], tokens: [] }));
  const context = createContext({ parseArgs: capture });
  const prototypes = runInContext(
    '({ object: Object.prototype, array: Array.prototype })',
    context,
    { timeout: 1000 },
  ) as { object: object; array: object };
  // Use host inspection primitives and keep descriptor values/getters/setters by identity.
  const intrinsicState = Object.values(prototypes).map((prototype) => ({
    prototype,
    parent: Object.getPrototypeOf(prototype),
    descriptors: new Map(
      Reflect.ownKeys(prototype).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(prototype, key)!,
      ]),
    ),
  }));
  runInContext(
    `const args = ['mcp', '--index', 'fixture-index', '--', 'literal'];
     const process = { argv: ['node', 'qmd.js', ...args] };
${program}`,
    context,
    { timeout: 1000 },
  );
  expect(capture).toHaveBeenCalledTimes(1);
  for (const { prototype, parent, descriptors } of intrinsicState) {
    expect(Object.getPrototypeOf(prototype)).toBe(parent);
    expect(Reflect.ownKeys(prototype)).toStrictEqual([...descriptors.keys()]);
    for (const [key, before] of descriptors) {
      const current = Object.getOwnPropertyDescriptor(prototype, key)!;
      for (const field of [
        'configurable',
        'enumerable',
        'writable',
        'value',
        'get',
        'set',
      ] as const) {
        expect(Object.hasOwn(current, field)).toBe(Object.hasOwn(before, field));
        expect(current[field]).toBe(before[field]);
      }
    }
  }
  return snapshotMetadata(capture.mock.calls[0]![0], prototypes);
}

function parserGrammar(program: string) {
  const config = parserConfiguration(program);
  // Strip VM prototypes only after checking every own data property.
  return {
    options: snapshotMetadata(config['options']),
    strict: config['strict'],
    allowPositionals: config['allowPositionals'],
  };
}

function assertGrammarCorresponds(source: string): void {
  const owned = snapshotMetadata(parserConfiguration(ownedParseCall(source)));
  const upstream = snapshotMetadata(parserConfiguration(pinnedUpstreamParseCall()));
  // Token production is the one intentional launcher-specific configuration.
  expect(Object.hasOwn(upstream, 'tokens')).toBe(false);
  const { tokens, ...ownedComparable } = owned;
  expect(tokens).toBe(true);
  expect(ownedComparable).toStrictEqual(upstream);
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

describe('owned parser metadata correspondence', () => {
  const launcher = () => readFileSync(join(repo, 'packages/qmd-runtime/bin/owned-qmd.mjs'), 'utf8');

  it('matches all 40 pinned upstream option entries and strict/positional configuration without importing qmd', () => {
    const grammar = parserGrammar(pinnedUpstreamParseCall());
    expect(Object.keys(grammar.options)).toHaveLength(40);
    assertGrammarCorresponds(launcher());
  });

  it.each([
    ['type', "index: { type: 'string' }", "index: { type: 'boolean' }"],
    ['alias', "short: 'c'", "short: 'z'"],
    ['multiple', 'multiple: true', 'multiple: false'],
    [
      'default',
      "'no-rerank': { type: 'boolean', default: false }",
      "'no-rerank': { type: 'boolean', default: true }",
    ],
    ['missing entry', "  port: { type: 'string' },\n", ''],
    ['strict', 'strict: false', 'strict: true'],
    ['positionals', 'allowPositionals: true', 'allowPositionals: false'],
    ['argument forwarding', '      args,', '      args: args.slice(1),'],
    ['token production', 'tokens: true', 'tokens: false'],
    ['added parser switch', 'strict: false,', 'strict: false, allowNegative: true,'],
  ])('rejects deliberately changed copied %s metadata', (name, before, after) => {
    const source = launcher();
    expect(source.split(before)).toHaveLength(2);
    const changed = source.replace(before, after);
    // Prove the counterexample is valid metadata, not an extraction/syntax failure.
    const grammar = parserGrammar(ownedParseCall(changed));
    expect(Object.keys(grammar.options)).toHaveLength(name === 'missing entry' ? 39 : 40);
    expect(() => assertGrammarCorresponds(changed)).toThrow();
  });
  it.each([
    [
      'undefined default',
      "index: { type: 'string' }",
      "index: { type: 'string', default: undefined }",
    ],
    [
      'undefined extra property',
      "index: { type: 'string' }",
      "index: { type: 'string', future: undefined }",
    ],
  ])('rejects lossless metadata counterexample: %s', (_name, before, after) => {
    const changed = launcher().replace(before, after);
    expect(() => assertGrammarCorresponds(changed)).toThrow();
  });

  it('preserves lossless metadata values that JSON would drop or alter', () => {
    const grammar = parserGrammar(`parseArgs({ options: { sample: {
      type: 'string', default: undefined, nan: NaN, limit: Infinity, integer: 2n, zero: -0
    } }, strict: false, allowPositionals: true });`);
    expect(grammar.options).toStrictEqual({
      sample: {
        type: 'string',
        default: undefined,
        nan: NaN,
        limit: Infinity,
        integer: 2n,
        zero: -0,
      },
    });
  });

  it.each([
    ['non-enumerable', "Object.defineProperty({ type: 'string' }, 'default', { value: false })"],
    ['symbol key', "{ type: 'string', [Symbol('hidden')]: false }"],
    ['inherited fields', "Object.assign(Object.create({ default: false }), { type: 'string' })"],
    [
      'null-prototype parent',
      "Object.assign(Object.create(Object.assign(Object.create(null), { default: false })), { type: 'string' })",
    ],
    ['accessor', "{ type: 'string', get default() { return false; } }"],
  ])('refuses unsupported property metadata rather than dropping it: %s', (_name, option) => {
    expect(() => parserGrammar(`parseArgs({ options: { sample: ${option} } });`)).toThrow();
  });

  it.each([
    ['polluted Object prototype', 'Object.prototype.default = false;'],
    ['reparented Array prototype', 'Object.setPrototypeOf(Array.prototype, { default: false });'],
  ])('refuses altered VM intrinsic metadata: %s', (_name, mutation) => {
    expect(() =>
      parserGrammar(`${mutation} parseArgs({ options: { sample: { type: 'string' } } });`),
    ).toThrow();
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
