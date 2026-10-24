import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';

export const MAX_RUNTIME_BYTES = 2 * 1024 ** 3;
export const UPSTREAM_LAUNCHER_SHA256 =
  '6d13280557777ff5b9b2cb639818b77a888150bf5def2fd730f9e6e66b8e7e48';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function confined(root, path) {
  const actual = realpathSync(path);
  const rel = relative(root, actual);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    const error = new Error('Runtime path escapes owned root');
    error.code = 'RUNTIME_PATH_ESCAPE';
    error.offender = {
      path: relative(root, path).split(sep).join('/'),
      linkTarget: lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null,
      resolvedOutsideRoot: rel.split(sep).join('/'),
    };
    throw error;
  }
  return actual;
}

/** Every file and link, including native files. Links are never traversed. */
export function inventory(root, { maxBytes = MAX_RUNTIME_BYTES, omit = [] } = {}) {
  root = realpathSync(root);
  const entries = {};
  let bytes = 0;
  let buffer;
  function sameFile(left, right) {
    return ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'].every(
      (key) => left[key] === right[key],
    );
  }
  function fileHash(path, initial) {
    const fd = openSync(path, 'r');
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || !sameFile(initial, opened))
        throw new Error('Runtime file changed before hashing');
      buffer ??= Buffer.allocUnsafe(1024 * 1024);
      const hash = createHash('sha256');
      let total = 0;
      while (true) {
        // One extra byte detects growth without reading an indefinitely growing file.
        const count = readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, initial.size - total + 1),
          null,
        );
        if (!count) break;
        total += count;
        if (total > initial.size) throw new Error('Runtime file grew during hashing');
        hash.update(buffer.subarray(0, count));
      }
      if (
        total !== initial.size ||
        !sameFile(initial, fstatSync(fd)) ||
        !sameFile(initial, lstatSync(path))
      )
        throw new Error('Runtime file changed during hashing');
      return hash.digest('hex');
    } finally {
      closeSync(fd);
    }
  }
  function visit(path) {
    const rel = relative(root, path).split(sep).join('/');
    if (omit.includes(rel)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      confined(root, path); // Also refuses dangling links before any content read.
      const target = readlinkSync(path);
      if (isAbsolute(target)) throw new Error('Absolute runtime link is not relocatable');
      entries[rel] = { kind: 'link', target };
    } else if (stat.isDirectory()) {
      entries[rel] = { kind: 'directory', mode: stat.mode & 0o777 };
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > maxBytes) throw new Error('Runtime exceeds byte budget');
      entries[rel] = {
        kind: 'file',
        bytes: stat.size,
        mode: stat.mode & 0o777,
        sha256: fileHash(path, stat),
      };
    } else {
      throw new Error('Runtime contains unsupported special file');
    }
  }
  visit(root);
  return { bytes, entries };
}

function snapshotId(lock, name, version) {
  const id = `${name}@${version}`;
  if (Object.hasOwn(lock.snapshots, id)) return id;
  // pnpm npm aliases reference the real name, not the dependency alias.
  if (Object.hasOwn(lock.snapshots, version)) return version;
  throw new Error(`Unresolved lock snapshot: ${name}`);
}

/** Project the selected lock edges, never upstream manifest version ranges. */
export function projectLock(lock, importer) {
  const selected = lock.importers[importer]?.dependencies?.['@tobilu/qmd'];
  if (selected?.specifier !== '2.5.3') throw new Error('Exact production qmd dependency required');
  const root = snapshotId(lock, '@tobilu/qmd', selected.version);
  const nodes = {};
  function visit(id) {
    if (nodes[id]) return;
    const baseId = id.split('(')[0];
    const at = baseId.lastIndexOf('@');
    const info = lock.packages[baseId];
    if (!info?.resolution?.integrity) throw new Error(`Missing locked integrity: ${id}`);
    const node = {
      name: baseId.slice(0, at),
      version: baseId.slice(at + 1),
      integrity: info.resolution.integrity,
      os: info.os ?? [],
      cpu: info.cpu ?? [],
      libc: info.libc ?? [],
      dependencies: {},
      optionalDependencies: {},
    };
    nodes[id] = node;
    for (const kind of ['dependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(lock.snapshots[id][kind] ?? {})) {
        const child = snapshotId(lock, name, version);
        node[kind][name] = child;
        visit(child);
      }
    }
  }
  visit(root);
  return { root, nodes };
}

function platformMatches(rules, value) {
  if (rules.includes(`!${value}`)) return false;
  const positive = rules.filter((rule) => !rule.startsWith('!'));
  return !positive.length || positive.includes(value) || positive.includes('any');
}

function excludedBy(node, platform) {
  return ['os', 'cpu', 'libc'].filter((key) => !platformMatches(node[key], platform[key]));
}

/** Node's ancestor search, without loading package code or consulting globals. */
function locate(root, from, name, lookups = new Set()) {
  let dir = from;
  while (true) {
    const candidate = join(dir, 'node_modules', name);
    try {
      // lstat first; a declared broken link must not fall through to a parent.
      lstatSync(candidate);
      const actual = confined(root, candidate);
      lookups.add(candidate);
      return actual;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink has an lstat entry and is rejected by confined().
      try {
        lstatSync(candidate);
        throw new Error('Dangling dependency link');
      } catch (probe) {
        if (probe.code !== 'ENOENT') throw probe;
      }
    }
    if (dir === root) return null;
    const next = dirname(dir);
    if (next === dir || relative(root, next).startsWith('..')) return null;
    dir = next;
  }
}

export function verifyGraph(root, projection, platform, { sourceWorkspace = false } = {}) {
  root = realpathSync(root);
  const directories = {};
  const missingOptional = [];
  const seen = new Set();
  const lookups = new Set();
  function visit(id, dir) {
    const key = `${id}\0${dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    const expected = projection.nodes[id];
    const metadata = json(confined(root, join(dir, 'package.json')));
    if (metadata.name !== expected.name || metadata.version !== expected.version) {
      throw new Error(`Selected dependency differs from lock: ${expected.name}`);
    }
    directories[id] ??= [];
    if (!directories[id].includes(dir)) directories[id].push(dir);
    for (const kind of ['dependencies', 'optionalDependencies']) {
      for (const [name, childId] of Object.entries(expected[kind])) {
        const child = locate(root, dir, name, lookups);
        if (!child) {
          const reasons = excludedBy(projection.nodes[childId], platform);
          if (kind !== 'optionalDependencies' || !reasons.length) {
            throw new Error(`Required or host-compatible optional dependency missing: ${name}`);
          }
          missingOptional.push({ parent: id, name, snapshot: childId, reasons });
          continue;
        }
        visit(childId, child);
      }
    }
  }
  const qmd = locate(root, root, '@tobilu/qmd', lookups);
  if (!qmd) throw new Error('Production qmd missing');
  visit(projection.root, qmd);
  // Enumerate module boundaries, including aliases/scopes and pnpm hoists.
  const allowed = new Set(Object.values(directories).flat());
  const aliases = new Map();
  const bins = new Set();
  for (const [id, paths] of Object.entries(directories)) {
    const node = projection.nodes[id];
    for (const [name, child] of Object.entries({
      ...node.dependencies,
      ...node.optionalDependencies,
    })) {
      for (const path of directories[child] ?? []) {
        if (!aliases.has(name)) aliases.set(name, new Set());
        aliases.get(name).add(path);
      }
    }
    for (const path of paths) {
      const pkg = json(confined(root, join(path, 'package.json')));
      const names =
        typeof pkg.bin === 'string' ? [pkg.name.split('/').at(-1)] : Object.keys(pkg.bin ?? {});
      for (const name of names) for (const suffix of ['', '.cmd', '.ps1']) bins.add(name + suffix);
    }
  }
  const scanned = new Set();
  function scanModules(dir) {
    if (scanned.has(dir)) return;
    scanned.add(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === '.modules.yaml' && dir === join(root, 'node_modules') && entry.isFile())
        continue;
      if (entry.name === '.bin' && entry.isDirectory()) {
        for (const file of readdirSync(path)) {
          if (!bins.has(file) || lstatSync(join(path, file)).isDirectory())
            throw new Error('Undeclared generated bin entry');
        }
        continue;
      }
      if (entry.name === '.pnpm' && dir === join(root, 'node_modules') && entry.isDirectory()) {
        for (const store of readdirSync(path, { withFileTypes: true })) {
          if (store.name === 'lock.yaml' && store.isFile()) continue;
          if (!store.isDirectory()) throw new Error('Unexpected pnpm store metadata');
          const virtual = join(path, store.name);
          if (store.name === 'node_modules') scanModules(virtual);
          else {
            if (JSON.stringify(readdirSync(virtual)) !== JSON.stringify(['node_modules']))
              throw new Error('Unexpected virtual-store file');
            scanModules(join(virtual, 'node_modules'));
          }
        }
        continue;
      }
      const entries =
        entry.name.startsWith('@') && entry.isDirectory()
          ? readdirSync(path).map((name) => [entry.name + '/' + name, join(path, name)])
          : [[entry.name, path]];
      for (const [name, candidate] of entries) {
        const actual = confined(root, candidate);
        const generatedHoist =
          dir === join(root, 'node_modules', '.pnpm', 'node_modules') &&
          aliases.get(name)?.has(actual);
        const physicalNode =
          candidate === actual &&
          Object.entries(directories).some(
            ([id, paths]) => projection.nodes[id].name === name && paths.includes(actual),
          );
        if (!allowed.has(actual) || (!lookups.has(candidate) && !generatedHoist && !physicalNode)) {
          const error = new Error('Undeclared extra runtime package or alias');
          error.code = 'RUNTIME_EXTRA_MODULE';
          const metadata = json(confined(root, join(actual, 'package.json')));
          error.offender = {
            path: relative(root, candidate).split(sep).join('/'),
            alias: name,
            resolvedNode: relative(root, actual).split(sep).join('/'),
            metadataIdentity: { name: metadata.name, version: metadata.version },
            usedEdge: lookups.has(candidate),
            knownNode: allowed.has(actual),
            hoist: Boolean(generatedHoist),
            physicalNode,
          };
          throw error;
        }
        const nested = join(actual, 'node_modules');
        try {
          lstatSync(nested);
          scanModules(confined(root, nested));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }
  if (!sourceWorkspace) scanModules(join(root, 'node_modules'));
  return {
    directories: Object.fromEntries(
      Object.entries(directories).map(([id, paths]) => [
        id,
        paths.map((p) => relative(root, p).split(sep).join('/')).sort(),
      ]),
    ),
    missingOptional,
  };
}

/** Candidate-owned files plus explicitly recognized pnpm-generated metadata. */
export function verifyLayout(files, graph) {
  const owned = ['package.json', 'README.md', 'bin/owned-qmd.mjs', 'lib/runtime-inventory.mjs'];
  const packages = Object.values(graph.directories).flat();
  const generated = ['node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml'];
  // Inventory confinement and strict graph validation precede this layout check.
  // Recognize namespace ancestors only for aliases targeting known module nodes.
  const knownModuleAliases = Object.entries(files.entries)
    .filter(([path, entry]) => entry.kind === 'link' && path.startsWith('node_modules/'))
    .filter(([path, entry]) =>
      packages.includes(
        posix.normalize(posix.join(posix.dirname(path), entry.target.split(sep).join('/'))),
      ),
    )
    .map(([path]) => path);
  const packageRoots = new Set(packages);
  const recognized = new Set([...owned, ...generated]);
  const properAncestors = new Set(['']);
  for (const file of [...owned, ...packages, ...generated, ...knownModuleAliases]) {
    for (let slash = file.lastIndexOf('/'); slash >= 0; slash = file.lastIndexOf('/', slash - 1)) {
      properAncestors.add(file.slice(0, slash));
      if (slash === 0) break;
    }
  }
  for (const [path, entry] of Object.entries(files.entries)) {
    let packageFile = packageRoots.has(path);
    for (
      let slash = path.lastIndexOf('/');
      !packageFile && slash >= 0;
      slash = path.lastIndexOf('/', slash - 1)
    ) {
      packageFile = packageRoots.has(path.slice(0, slash));
      if (slash === 0) break;
    }
    const ancestor = entry.kind === 'directory' && properAncestors.has(path);
    const shim =
      path.startsWith('node_modules/') && (path.includes('/.bin/') || path.endsWith('/.bin'));
    const hoistDirectory =
      entry.kind === 'directory' &&
      (path === 'node_modules/.pnpm/node_modules' ||
        path.startsWith('node_modules/.pnpm/node_modules/'));
    const moduleLink = entry.kind === 'link' && path.startsWith('node_modules/');
    if (
      !packageFile &&
      !ancestor &&
      !recognized.has(path) &&
      !shim &&
      !moduleLink &&
      !hoistDirectory
    ) {
      throw new Error('Unrecognized candidate file or generated metadata');
    }
  }
}

export function hostPlatform() {
  return {
    os: process.platform,
    cpu: process.arch,
    libc:
      process.platform === 'linux'
        ? process.report.getReport().header.glibcVersionRuntime
          ? 'glibc'
          : 'musl'
        : 'none',
  };
}

export function verifyRuntime(root) {
  root = realpathSync(root);
  const manifest = json(join(root, 'runtime-manifest.json'));
  if (manifest.schema !== 'bbb-qmd-runtime/v1') throw new Error('Unsupported runtime manifest');
  if (
    JSON.stringify(manifest.platform) !== JSON.stringify(hostPlatform()) ||
    manifest.nodeAbi !== process.versions.modules
  ) {
    throw new Error('Runtime host platform or Node ABI mismatch');
  }
  const actual = inventory(root, { omit: ['runtime-manifest.json'] });
  if (JSON.stringify(actual) !== JSON.stringify(manifest.inventory))
    throw new Error('Runtime inventory mismatch');
  const graph = verifyGraph(root, manifest.projection, manifest.platform);
  verifyLayout(actual, graph);
  if (JSON.stringify(graph) !== JSON.stringify(manifest.graph))
    throw new Error('Runtime graph mismatch');
  const qmd = confined(root, resolve(root, graph.directories[manifest.projection.root][0]));
  if (sha256(readFileSync(join(qmd, 'bin/qmd'))) !== UPSTREAM_LAUNCHER_SHA256) {
    throw new Error('Upstream launcher changed; initialization compatibility requires review');
  }
  return { manifest, qmd };
}
