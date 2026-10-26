/** Strict recovery inspection; generic legacy collection management is unchanged. */
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parseDocument } from 'yaml';
import { getQmdTenantEnv, getQmdTenantIndexPath } from '../config.js';
import { getExportableCollections } from '../collections/collection-registry.js';
import { RealQmdExecutor } from '../executor/real-executor.js';
import {
  resolveQmdCommand,
  type OwnedQmdRuntime,
  type QmdCommandProvenance,
} from '../executor/resolve-command.js';
import {
  bindDirectory,
  bindParents,
  existingIdentity,
  readRegistry,
  type RegistryBindings,
} from './registry-files.js';

export interface RecoveryQmdRegistryOptions {
  tenantId: string;
  basePath: string;
  exportDir: string;
  /** Strict support is initially limited to the manifest-bound qmd2.5.3 profile. */
  qmdRuntime: OwnedQmdRuntime;
  /** Explicit setup inspection only: absent/subset registries are not verified indexes. */
  allowPartial?: boolean;
}
export interface RecoveryQmdRegistryInspection {
  profile: 'qmd-2.5.3';
  state: 'complete' | 'partial';
  tenantId: string;
  registryPath: string;
  indexPath: string;
  registrySha256: string | null;
  collections: string[];
  bindings: RegistryBindings;
  command: QmdCommandProvenance;
}
interface CollectionRow {
  name: string;
  path: string;
  pattern: string;
  ignore_patterns: string | null;
  include_by_default: number;
  update_command: string | null;
  context: string | null;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed recovery collection registry');
  return value as Record<string, unknown>;
}

/** qmd2.5.3 persists these URI strings during CLI initialization; no model is run. */
function validateModelMetadata(value: unknown): void {
  if (value === undefined) return;
  const models = object(value);
  if (
    Object.keys(models).sort().join(',') !== 'embed,generate,rerank' ||
    Object.values(models).some(
      (uri) =>
        typeof uri !== 'string' || uri.length === 0 || uri.length > 2048 || /[\x00-\x1f]/.test(uri),
    )
  )
    throw new Error('Unsupported recovery model metadata');
}

function yamlCollections(text: string, expected: ReadonlyMap<string, string>): string[] {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new Error('Malformed recovery collection YAML');
  const data = object(document.toJS({ maxAliasCount: 0 }));
  if (Object.keys(data).some((key) => key !== 'collections' && key !== 'models'))
    throw new Error('Unexpected recovery registry configuration');
  validateModelMetadata(data['models']);
  const collections = object(data['collections']);
  const names = Object.keys(collections).sort();
  for (const name of names) {
    const value = object(collections[name]);
    if (
      !expected.has(name) ||
      Object.keys(value).some((key) => !['path', 'pattern', 'includeByDefault'].includes(key)) ||
      value['path'] !== expected.get(name) ||
      value['pattern'] !== '**/*.md' ||
      (value['includeByDefault'] !== undefined && value['includeByDefault'] !== true)
    )
      throw new Error('Recovery YAML collection binding differs');
  }
  return names;
}

function sqliteCollections(path: string, expected: ReadonlyMap<string, string>): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db
      .transaction(() => {
        const rows = db
          .prepare(
            'SELECT name, path, pattern, ignore_patterns, include_by_default, update_command, context FROM store_collections ORDER BY name',
          )
          .all() as CollectionRow[];
        for (const row of rows) {
          if (
            !expected.has(row.name) ||
            row.path !== expected.get(row.name) ||
            row.pattern !== '**/*.md' ||
            row.ignore_patterns !== null ||
            row.update_command !== null ||
            row.context !== null ||
            row.include_by_default !== 1
          )
            throw new Error('Recovery SQLite collection binding differs');
        }
        return rows.map((row) => row.name);
      })
      .deferred();
  } finally {
    db.close();
  }
}

/** No SDK opening, DDL, chmod, directory creation, qmd execution or implicit repair. */
export function inspectRecoveryQmdRegistry(
  options: RecoveryQmdRegistryOptions,
): RecoveryQmdRegistryInspection {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.tenantId))
    throw new Error('Unsupported recovery tenant');
  if (options.qmdRuntime === undefined) throw new Error('Explicit owned runtime required');
  const selected = resolveQmdCommand({ ownedRuntime: options.qmdRuntime });
  if (selected.provenance.source !== 'owned' || selected.provenance.runtime?.qmdVersion !== '2.5.3')
    throw new Error('Strict recovery requires the owned qmd2.5.3 profile');
  const bindings: RegistryBindings = {};
  bindDirectory(options.basePath, bindings, true);
  bindDirectory(options.exportDir, bindings, true);
  const root = getQmdTenantIndexPath(options.tenantId, options.basePath);
  bindDirectory(root, bindings, true);
  bindParents(root, options.basePath, bindings);
  const env = getQmdTenantEnv(options.tenantId, options.basePath);
  const registryPath = join(env['QMD_CONFIG_DIR']!, 'index.yml');
  const indexPath = env['INDEX_PATH']!;
  bindParents(registryPath, root, bindings);
  bindParents(indexPath, root, bindings);
  const expected = new Map(
    getExportableCollections().map((def) => {
      const path = join(options.exportDir, def.sourceSubdir);
      bindDirectory(path, bindings);
      return [def.name, path];
    }),
  );
  const registry = readRegistry(registryPath, bindings);
  const index = existingIdentity(indexPath, false);
  const sidecars = [indexPath + '-wal', indexPath + '-shm'].map((path) =>
    existingIdentity(path, false),
  );
  if (index !== null) bindings[indexPath] = index;
  const yamlNames = registry === null ? [] : yamlCollections(registry.text, expected);
  const sqliteNames = index === null ? [] : sqliteCollections(indexPath, expected);
  if (!isDeepStrictEqual(yamlNames, sqliteNames) || (registry === null) !== (index === null))
    throw new Error('Recovery YAML and SQLite registry disagree');
  const complete = yamlNames.length === expected.size && registry !== null && index !== null;
  if (!complete && options.allowPartial !== true)
    throw new Error('Recovery registry is incomplete');
  const registryAfter = readRegistry(registryPath, {});
  if (
    registry?.sha256 !== registryAfter?.sha256 ||
    !isDeepStrictEqual(index, existingIdentity(indexPath, false))
  )
    throw new Error('Recovery registry changed during inspection');
  // Sidecars may legitimately appear/disappear between operations. Every observed
  // sidecar must be a nonredirected regular owner file, never a FIFO or link.
  if (index === null && sidecars.some((identity) => identity !== null))
    throw new Error('Recovery index has orphan SQLite sidecars');
  for (const path of [indexPath + '-wal', indexPath + '-shm']) existingIdentity(path, false);
  for (const [path, identity] of Object.entries(bindings)) {
    if (
      !isDeepStrictEqual(
        identity,
        existingIdentity(path, path !== registryPath && path !== indexPath),
      )
    )
      throw new Error('Recovery registry path changed during inspection');
  }
  return {
    profile: 'qmd-2.5.3',
    state: complete ? 'complete' : 'partial',
    tenantId: options.tenantId,
    registryPath,
    indexPath,
    registrySha256: registry?.sha256 ?? null,
    collections: yamlNames,
    bindings,
    command: structuredClone(selected.provenance),
  };
}

export function assertRecoveryQmdRegistryBinding(
  previous: RecoveryQmdRegistryInspection,
  current: RecoveryQmdRegistryInspection,
): void {
  if (!isDeepStrictEqual(previous, current)) throw new Error('Recovery registry binding changed');
}

/** Actual selected list execution is additional evidence, never a source-path parser. */
export async function verifyRecoveryQmdRegistry(
  options: RecoveryQmdRegistryOptions,
  previous?: RecoveryQmdRegistryInspection,
): Promise<RecoveryQmdRegistryInspection> {
  const fixed = structuredClone({ ...options, allowPartial: false });
  const before = inspectRecoveryQmdRegistry(fixed);
  if (previous !== undefined) assertRecoveryQmdRegistryBinding(previous, before);
  const executor = new RealQmdExecutor({
    ownedRuntime: fixed.qmdRuntime,
    tenant: { id: fixed.tenantId, basePath: fixed.basePath },
  });
  const result = await executor.execute(['collection', 'list']);
  if (
    result.exitCode !== 0 ||
    result.failure !== undefined ||
    !isDeepStrictEqual(executor.commandProvenance, before.command)
  )
    throw new Error('Selected recovery qmd registry probe failed');
  const after = inspectRecoveryQmdRegistry(fixed);
  assertRecoveryQmdRegistryBinding(before, after);
  return after;
}
