/** Synthetic owned command routing plus real-file YAML/SQLite refusal contracts.
 * These unit fixtures are not genuine qmd package/native execution evidence. */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQmdTenantEnv, getQmdTenantIndexPath } from '../config.js';
import { getExportableCollections } from '../collections/collection-registry.js';
import {
  assertRecoveryQmdRegistryBinding,
  inspectRecoveryQmdRegistry,
  verifyRecoveryQmdRegistry,
} from '../recovery/registry.js';
import type { RecoveryQmdRegistryOptions } from '../recovery/registry.js';

const roots: string[] = [];
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
beforeEach(() => {
  vi.stubEnv('TEAMKB_QMD_BIN', '');
  vi.stubEnv('TEAMKB_QMD_RUNTIME', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), 'qmd-recovery-registry-'));
  roots.push(root);
  const owned = join(root, 'owned');
  mkdirSync(join(owned, 'bin'), { recursive: true });
  mkdirSync(join(owned, 'lib'));
  const marker = join(root, 'command.json');
  const files = {
    'bin/owned-qmd.mjs': `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),index:process.env.INDEX_PATH,config:process.env.QMD_CONFIG_DIR}));process.exit(${exitCode});`,
    'lib/runtime-inventory.mjs': 'export const synthetic = true;',
  };
  const entries: Record<string, unknown> = {};
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(owned, name), bytes, { mode: 0o600 });
    entries[name] = {
      kind: 'file',
      bytes: Buffer.byteLength(bytes),
      mode: statSync(join(owned, name)).mode & 0o777,
      sha256: hash(bytes),
    };
  }
  const manifest = JSON.stringify({
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
  });
  writeFileSync(join(owned, 'runtime-manifest.json'), manifest);
  const options: RecoveryQmdRegistryOptions = {
    tenantId: 'fixture',
    basePath: join(root, 'brain'),
    exportDir: join(root, 'exports'),
    qmdRuntime: { root: owned, manifestSha256: hash(manifest) },
  };
  mkdirSync(options.basePath, { mode: 0o700 });
  mkdirSync(options.exportDir, { mode: 0o700 });
  mkdirSync(getQmdTenantIndexPath(options.tenantId, options.basePath), {
    recursive: true,
    mode: 0o700,
  });
  const env = getQmdTenantEnv(options.tenantId, options.basePath);
  const registry = join(env['QMD_CONFIG_DIR']!, 'index.yml');
  const index = env['INDEX_PATH']!;
  mkdirSync(dirname(registry), { recursive: true });
  mkdirSync(dirname(index), { recursive: true });
  const collections: Record<string, Record<string, unknown>> = {};
  for (const def of getExportableCollections()) {
    const path = join(options.exportDir, def.sourceSubdir);
    mkdirSync(path);
    collections[def.name] = { path, pattern: '**/*.md' };
  }
  const save = () => writeFileSync(registry, stringify({ collections }));
  save();
  const db = new Database(index);
  db.exec(
    'CREATE TABLE store_collections (name TEXT PRIMARY KEY, path TEXT NOT NULL, pattern TEXT NOT NULL, ignore_patterns TEXT, include_by_default INTEGER, update_command TEXT, context TEXT)',
  );
  const add = db.prepare('INSERT INTO store_collections VALUES (?, ?, ?, NULL, 1, NULL, NULL)');
  for (const [name, value] of Object.entries(collections))
    add.run(name, value['path'], value['pattern']);
  db.close();
  const sql = (statement: string) => {
    const writable = new Database(index, { fileMustExist: true });
    try {
      writable.exec(statement);
    } finally {
      writable.close();
    }
  };
  return { options, root, marker, registry, index, collections, save, sql };
}

describe('strict recovery registry inspection', () => {
  it('reads exact YAML and SQLite bindings without commands or writes', () => {
    const f = fixture();
    const before = [readFileSync(f.registry), readFileSync(f.index)];
    const proof = inspectRecoveryQmdRegistry(f.options);
    expect(proof.state).toBe('complete');
    expect(proof.collections).toHaveLength(5);
    expect(existsSync(f.marker)).toBe(false);
    expect([readFileSync(f.registry), readFileSync(f.index)]).toEqual(before);
  });
  it('executes the selected literal list route with tenant-bound paths', async () => {
    const f = fixture();
    const proof = await verifyRecoveryQmdRegistry(f.options);
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toEqual({
      args: ['collection', 'list', '--index', 'index'],
      index: f.index,
      config: dirname(f.registry),
    });
    expect(proof.command.source).toBe('owned');
  });
  it('refuses nonzero list results rather than treating them as an empty registry', async () => {
    const f = fixture(7);
    await expect(verifyRecoveryQmdRegistry(f.options)).rejects.toThrow('probe failed');
  });
  it.each(['kb-curated-shadow', 'foreign'])(
    'refuses extra or substring-collision collection %s',
    (name) => {
      const f = fixture();
      f.collections[name] = { ...f.collections['kb-curated'] };
      f.save();
      expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow(
        'YAML collection binding differs',
      );
    },
  );
  it('refuses an existing expected name with a foreign source path before execution', async () => {
    const f = fixture();
    f.collections['kb-curated']!['path'] = join(f.root, 'foreign');
    f.save();
    await expect(verifyRecoveryQmdRegistry(f.options)).rejects.toThrow(
      'YAML collection binding differs',
    );
    expect(existsSync(f.marker)).toBe(false);
  });
  it('refuses YAML/SQLite divergence even with a matching cached config hash', () => {
    const f = fixture();
    f.sql(
      "CREATE TABLE store_config (key TEXT PRIMARY KEY, value TEXT); INSERT INTO store_config VALUES ('config_hash', 'unchanged-fixture'); UPDATE store_collections SET path = '/foreign' WHERE name = 'kb-curated'",
    );
    expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow(
      'SQLite collection binding differs',
    );
  });
  it.each(['update', 'ignore', 'pattern', 'includeByDefault'])(
    'refuses changed YAML %s behavior',
    (key) => {
      const f = fixture();
      f.collections['kb-curated']![key] =
        key === 'includeByDefault' ? false : key === 'ignore' ? ['*.md'] : 'unexpected-fixture';
      f.save();
      expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow(
        'YAML collection binding differs',
      );
    },
  );
  it('refuses a stored update hook even when YAML has no hook', () => {
    const f = fixture();
    f.sql("UPDATE store_collections SET update_command = 'unexpected-fixture'");
    expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow(
      'SQLite collection binding differs',
    );
  });
  it('refuses malformed and duplicate-key YAML', () => {
    const f = fixture();
    writeFileSync(f.registry, 'collections: [\n');
    expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow();
    writeFileSync(f.registry, 'collections: {}\ncollections: {}\n');
    expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow('Malformed');
  });
  it.each(['registry', 'index', 'source'])(
    'refuses symlinked %s paths without changing targets',
    (kind) => {
      const f = fixture();
      const path =
        kind === 'registry'
          ? f.registry
          : kind === 'index'
            ? f.index
            : join(f.options.exportDir, 'curated');
      renameSync(path, path + '-original');
      symlinkSync(path + '-original', path);
      expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow('Unsafe');
    },
  );
  it('detects byte-identical file replacement against the prior binding', () => {
    const f = fixture();
    const before = inspectRecoveryQmdRegistry(f.options);
    const bytes = readFileSync(f.registry);
    renameSync(f.registry, f.registry + '-old');
    writeFileSync(f.registry, bytes);
    expect(() =>
      assertRecoveryQmdRegistryBinding(before, inspectRecoveryQmdRegistry(f.options)),
    ).toThrow('binding changed');
  });
  it('allows an explicitly partial matching subset but never marks it complete', () => {
    const f = fixture();
    delete f.collections['kb-bulk'];
    f.save();
    f.sql("DELETE FROM store_collections WHERE name = 'kb-bulk'");
    expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow('incomplete');
    expect(inspectRecoveryQmdRegistry({ ...f.options, allowPartial: true }).state).toBe('partial');
  });
  it('inspects explicit empty initialization without creating either file', () => {
    const f = fixture();
    rmSync(f.registry);
    rmSync(f.index);
    expect(inspectRecoveryQmdRegistry({ ...f.options, allowPartial: true }).state).toBe('partial');
    expect([existsSync(f.registry), existsSync(f.index)]).toEqual([false, false]);
    expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow('incomplete');
  });
  it('refuses nonowned selection rather than interpreting an arbitrary binary as this profile', () => {
    const f = fixture();
    vi.stubEnv('TEAMKB_QMD_BIN', '/usr/bin/true');
    expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow('owned qmd2.5.3');
  });
  it('accepts qmd initialization model URI metadata without changing collection requirements', () => {
    const f = fixture();
    writeFileSync(
      f.registry,
      stringify({
        collections: f.collections,
        models: { embed: 'fixture-embed', generate: 'fixture-generate', rerank: 'fixture-rerank' },
      }),
    );
    expect(inspectRecoveryQmdRegistry(f.options).state).toBe('complete');
  });
  it('rejects model metadata objects or extra command-shaped fields', () => {
    const f = fixture();
    writeFileSync(
      f.registry,
      stringify({
        collections: f.collections,
        models: { embed: {}, generate: 'fixture-generate', rerank: 'fixture-rerank' },
      }),
    );
    expect(() => inspectRecoveryQmdRegistry(f.options)).toThrow('model metadata');
  });
});
