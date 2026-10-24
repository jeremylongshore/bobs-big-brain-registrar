import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  QMD_BIN_ENV,
  resolveQmdBinary,
  type QmdBinarySource,
  type ResolveQmdBinaryOptions,
} from './resolve-binary.js';

/** A declaration pins an out-of-band expected digest, not an arbitrary directory. */
export interface OwnedQmdRuntime {
  readonly root: string;
  readonly manifestSha256: string;
}

export const QMD_RUNTIME_ENV = 'TEAMKB_QMD_RUNTIME';
const MANIFEST_LIMIT = 8 * 1024 * 1024;
const SOURCE_LIMIT = 128 * 1024;

export interface OwnedQmdProvenance {
  readonly declaredRoot: string;
  readonly root: string;
  readonly manifestSha256: string;
  readonly qmdVersion: string;
  readonly sdkVersion: string;
  readonly zodVersion: string;
  readonly nodeAbi: string;
  readonly lockSha256: string;
  /** Recorded build snapshot. Its base commit alone need not contain the runtime code. */
  readonly sourceSnapshot: Readonly<{
    baseCommit: string;
    uncommittedCandidate: boolean;
    sourceFilesSha256: string;
  }>;
}

/** Selection metadata only; not proof of execution, archive authenticity or deployment. */
export interface QmdCommandProvenance {
  readonly source: QmdBinarySource | 'owned';
  readonly executable: string;
  readonly prefix: readonly string[];
  readonly runtime?: OwnedQmdProvenance;
}

export interface ResolvedQmdCommand {
  readonly executable: string;
  readonly prefix: readonly string[];
  readonly provenance: QmdCommandProvenance;
}

export interface ResolveQmdCommandOptions extends ResolveQmdBinaryOptions {
  ownedRuntime?: OwnedQmdRuntime;
}

export class OwnedQmdRuntimeError extends Error {
  constructor(reason: string) {
    super(
      `Declared owned qmd runtime refused: ${reason}. Repair its root and expected manifest SHA256 ` +
        `in qmdRuntime/${QMD_RUNTIME_ENV}, or remove the declaration to use legacy discovery. ` +
        'No legacy fallback was attempted.',
    );
    this.name = 'OwnedQmdRuntimeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new OwnedQmdRuntimeError(`invalid ${label}`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024)
    throw new OwnedQmdRuntimeError(`invalid ${label}`);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-f\d]{64}$/i.test(result)) throw new OwnedQmdRuntimeError(`invalid ${label}`);
  return result.toLowerCase();
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** No redirected bin/lib/entry/manifest can change the launcher's inferred root. */
function exactFile(root: string, relative: string, limit: number): Buffer {
  const path = join(root, relative);
  const before = lstatSync(path);
  if (!before.isFile() || realpathSync(path) !== path)
    throw new OwnedQmdRuntimeError(`invalid or redirected ${relative} under declared root`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > limit
    )
      throw new OwnedQmdRuntimeError(`invalid or oversized ${relative} under declared root`);
    // Reading limit+1 from the same descriptor also bounds concurrent file growth.
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > limit || realpathSync(path) !== path)
      throw new OwnedQmdRuntimeError(`oversized or redirected ${relative} under declared root`);
    const after = lstatSync(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino)
      throw new OwnedQmdRuntimeError(`replaced ${relative} under declared root`);
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function exactDirectory(root: string, relative: string): void {
  const path = join(root, relative);
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
    throw new OwnedQmdRuntimeError(`redirected ${relative} directory under declared root`);
}

function sourceIdentity(root: string, manifest: Record<string, unknown>): void {
  const entries = record(
    record(manifest['inventory'], 'inventory')['entries'],
    'inventory entries',
  );
  for (const name of ['bin/owned-qmd.mjs', 'lib/runtime-inventory.mjs']) {
    const expected = record(entries[name], `${name} identity`);
    const bytes = exactFile(root, name, SOURCE_LIMIT);
    if (
      expected['kind'] !== 'file' ||
      bytes.length !== expected['bytes'] ||
      (lstatSync(join(root, name)).mode & 0o777) !== expected['mode'] ||
      sha256(bytes) !== digest(expected['sha256'], `${name} SHA256`)
    ) {
      throw new OwnedQmdRuntimeError(`${name} differs from the bound manifest`);
    }
  }
}

function platformIdentity(manifest: Record<string, unknown>): string {
  const platform = record(manifest['platform'], 'platform');
  const report: unknown = process.report?.getReport();
  const header = record(record(report, 'Node report')['header'], 'Node report header');
  const libc =
    process.platform === 'linux' ? (header['glibcVersionRuntime'] ? 'glibc' : 'musl') : 'none';
  if (
    Number(process.versions.node.split('.')[0]) < 22 ||
    platform['os'] !== process.platform ||
    platform['cpu'] !== process.arch ||
    platform['libc'] !== libc ||
    manifest['nodeAbi'] !== process.versions.modules
  ) {
    throw new OwnedQmdRuntimeError('Node 22+, host platform and matching Node ABI are required');
  }
  return text(manifest['nodeAbi'], 'Node ABI');
}

function sourceSnapshot(manifest: Record<string, unknown>): OwnedQmdProvenance['sourceSnapshot'] {
  const snapshot = record(manifest['sourceSnapshot'], 'source snapshot');
  const baseCommit = text(snapshot['baseCommit'], 'source base commit');
  if (!/^[a-f\d]{40}$/i.test(baseCommit) || typeof snapshot['uncommittedCandidate'] !== 'boolean')
    throw new OwnedQmdRuntimeError('invalid source snapshot binding');
  const files = Object.entries(record(manifest['sourceFiles'], 'source files')).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (files.length === 0) throw new OwnedQmdRuntimeError('missing source file binding');
  for (const [, hash] of files) digest(hash, 'source file SHA256');
  return Object.freeze({
    baseCommit,
    uncommittedCandidate: snapshot['uncommittedCandidate'],
    sourceFilesSha256: sha256(JSON.stringify(files)),
  });
}

function dependencyVersions(manifest: Record<string, unknown>) {
  const projection = record(manifest['projection'], 'projection');
  const nodes = record(projection['nodes'], 'projected nodes');
  const node = (id: unknown, name: string): Record<string, unknown> => {
    const key = text(id, `${name} snapshot`);
    if (!Object.hasOwn(nodes, key)) throw new OwnedQmdRuntimeError(`missing ${name} snapshot`);
    const result = record(nodes[key], `${name} node`);
    if (result['name'] !== name) throw new OwnedQmdRuntimeError(`invalid ${name} identity`);
    return result;
  };
  const qmd = node(projection['root'], '@tobilu/qmd');
  if (qmd['version'] !== '2.5.3') throw new OwnedQmdRuntimeError('qmd 2.5.3 is required');
  const deps = record(qmd['dependencies'], 'qmd dependency edges');
  return {
    qmdVersion: '2.5.3',
    sdkVersion: text(
      node(deps['@modelcontextprotocol/sdk'], '@modelcontextprotocol/sdk')['version'],
      'SDK version',
    ),
    zodVersion: text(node(deps['zod'], 'zod')['version'], 'Zod version'),
  };
}

/** Bounded manifest/source inspection. Full closure verification stays in the timed child. */
export function inspectOwnedQmdRuntime(declaration: OwnedQmdRuntime): OwnedQmdProvenance {
  try {
    if (!isAbsolute(declaration.root)) throw new OwnedQmdRuntimeError('root must be absolute');
    const root = realpathSync(declaration.root);
    if (!lstatSync(root).isDirectory()) throw new OwnedQmdRuntimeError('root must be a directory');
    exactDirectory(root, 'bin');
    exactDirectory(root, 'lib');
    const expected = digest(declaration.manifestSha256, 'expected manifest SHA256');
    const bytes = exactFile(root, 'runtime-manifest.json', MANIFEST_LIMIT);
    if (sha256(bytes) !== expected) throw new OwnedQmdRuntimeError('manifest SHA256 mismatch');
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    const manifest = record(parsed, 'manifest');
    if (manifest['schema'] !== 'bbb-qmd-runtime/v1')
      throw new OwnedQmdRuntimeError('unsupported manifest schema');
    const nodeAbi = platformIdentity(manifest);
    sourceIdentity(root, manifest);
    return Object.freeze({
      declaredRoot: declaration.root,
      root,
      manifestSha256: expected,
      ...dependencyVersions(manifest),
      nodeAbi,
      lockSha256: digest(manifest['lockSha256'], 'lock SHA256'),
      sourceSnapshot: sourceSnapshot(manifest),
    });
  } catch (error) {
    if (error instanceof OwnedQmdRuntimeError) throw error;
    throw new OwnedQmdRuntimeError('artifact metadata or confined source files cannot be read');
  }
}

function declaredRuntime(options: ResolveQmdCommandOptions): OwnedQmdRuntime | undefined {
  if (options.ownedRuntime !== undefined) return options.ownedRuntime;
  const raw = (options.env ?? process.env)[QMD_RUNTIME_ENV];
  if (raw === undefined) return undefined;
  try {
    if (raw.length > 4096) throw new Error('bounded declaration');
    const value: unknown = JSON.parse(raw);
    const object = record(value, QMD_RUNTIME_ENV);
    return {
      root: text(object['root'], 'runtime root'),
      manifestSha256: digest(object['manifestSha256'], 'expected manifest SHA256'),
    };
  } catch {
    throw new OwnedQmdRuntimeError(`${QMD_RUNTIME_ENV} must be JSON with root and manifestSha256`);
  }
}

function command(
  executable: string,
  prefix: string[],
  source: QmdCommandProvenance['source'],
  runtime?: OwnedQmdProvenance,
): ResolvedQmdCommand {
  const fixedPrefix = Object.freeze(prefix);
  return Object.freeze({
    executable,
    prefix: fixedPrefix,
    provenance: Object.freeze({
      source,
      executable,
      prefix: fixedPrefix,
      ...(runtime ? { runtime } : {}),
    }),
  });
}

export function resolveQmdCommand(options: ResolveQmdCommandOptions = {}): ResolvedQmdCommand {
  // Preserve RealQmdExecutor's explicit-binary verbatim/spawnFailure compatibility.
  if (options.explicit !== undefined) return command(options.explicit, [], 'explicit');
  const env = options.env ?? process.env;
  if (env[QMD_BIN_ENV]?.trim()) {
    const selected = resolveQmdBinary(options);
    return command(selected.path, [], selected.source);
  }
  const declaration = declaredRuntime(options);
  if (declaration !== undefined) {
    const runtime = inspectOwnedQmdRuntime(declaration);
    return command(process.execPath, [join(runtime.root, 'bin/owned-qmd.mjs')], 'owned', runtime);
  }
  const selected = resolveQmdBinary(options);
  return command(selected.path, [], selected.source);
}

/** Cached selection never silently adopts a changed declaration/root/manifest. */
export function recheckQmdCommand(selected: ResolvedQmdCommand): void {
  const previous = selected.provenance.runtime;
  if (!previous) return;
  const current = inspectOwnedQmdRuntime({
    root: previous.declaredRoot,
    manifestSha256: previous.manifestSha256,
  });
  if (current.root !== previous.root)
    throw new OwnedQmdRuntimeError('declared canonical runtime root changed');
}
