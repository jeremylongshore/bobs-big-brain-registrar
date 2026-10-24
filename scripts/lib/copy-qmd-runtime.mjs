import { constants, chmodSync, copyFileSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  confined,
  inventory,
  MAX_RUNTIME_BYTES,
  sha256,
} from '../../packages/qmd-runtime/lib/runtime-inventory.mjs';

/** Names become filesystem components; aliases have the same restrictions. */
export function requirePackageName(name) {
  if (
    typeof name !== 'string' ||
    !/^(?:@[A-Za-z0-9_][A-Za-z0-9._-]*\/)?[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)
  ) {
    throw new Error('Unsafe package or alias name');
  }
}

/**
 * Copy installed bytes, never run a package manager/native hook. Every dependency
 * link comes from the reviewed lock projection. This is a host artifact candidate.
 */
export function copyRuntimeClosure({
  sourceRoot,
  target,
  projection,
  graph,
  maxBytes = MAX_RUNTIME_BYTES,
}) {
  sourceRoot = realpathSync(sourceRoot);
  target = resolve(target);
  const plans = new Map();
  const hashes = new Map();
  let bytes = 0;
  // Validate the complete plan before creating the target or writing any link.
  for (const [id, paths] of Object.entries(graph.directories)) {
    const node = projection.nodes[id];
    if (!node || paths.length === 0) throw new Error('Invalid selected snapshot');
    requirePackageName(node.name);
    const hash = sha256(id);
    if (hashes.has(hash) && hashes.get(hash) !== id)
      throw new Error('Snapshot directory collision');
    hashes.set(hash, id);
    const copies = paths.map((path) => {
      const source = confined(sourceRoot, resolve(sourceRoot, path));
      return { source, files: inventory(source, { omit: ['node_modules'] }) };
    });
    if (!copies.every((copy) => JSON.stringify(copy.files) === JSON.stringify(copies[0].files))) {
      throw new Error('Same snapshot has unequal installed source copies');
    }
    bytes += copies[0].files.bytes;
    if (bytes > maxBytes) throw new Error('Source closure exceeds byte budget');
    const destination = join(target, 'node_modules', '.pnpm', hash, 'node_modules', node.name);
    const links = [];
    const names = new Map();
    for (const kind of ['dependencies', 'optionalDependencies']) {
      for (const [name, child] of Object.entries(node[kind])) {
        requirePackageName(name);
        if (!graph.directories[child]) {
          const excluded =
            kind === 'optionalDependencies' &&
            graph.missingOptional.some(
              (entry) =>
                entry.parent === id &&
                entry.name === name &&
                entry.snapshot === child &&
                entry.reasons.length,
            );
          if (!excluded) throw new Error('Projected required edge missing from copy plan');
        } else {
          if (names.has(name) && names.get(name) !== child)
            throw new Error('Conflicting projected alias');
          if (!names.has(name)) links.push({ name, child });
          names.set(name, child);
        }
      }
    }
    plans.set(id, { ...copies[0], destination, links });
  }
  if (!plans.has(projection.root)) throw new Error('Selected production qmd missing');
  // The target must be fresh. Existing directories/files are never overwritten.
  mkdirSync(target, { mode: 0o700 });
  for (const plan of plans.values()) {
    mkdirSync(plan.destination, { recursive: true });
    // Copy directories/files first, links last: no write follows a copied link.
    const entries = Object.entries(plan.files.entries);
    for (const [path, entry] of entries) {
      if (!path) continue;
      const destination = join(plan.destination, path);
      if (entry.kind === 'directory') mkdirSync(destination, { recursive: true });
      else if (entry.kind === 'file') {
        copyFileSync(join(plan.source, path), destination, constants.COPYFILE_EXCL);
        chmodSync(destination, entry.mode);
      }
    }
    for (const [path, entry] of entries) {
      if (entry.kind === 'link') symlinkSync(entry.target, join(plan.destination, path));
    }
  }
  const link = (path, destination) => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(relative(dirname(path), destination), path, 'dir');
  };
  for (const plan of plans.values()) {
    for (const edge of plan.links) {
      link(join(plan.destination, 'node_modules', edge.name), plans.get(edge.child).destination);
    }
  }
  link(join(target, 'node_modules', '@tobilu', 'qmd'), plans.get(projection.root).destination);
  for (const plan of plans.values()) {
    for (const [path, entry] of Object.entries(plan.files.entries)) {
      if (entry.kind === 'directory') chmodSync(join(plan.destination, path), entry.mode);
    }
  }
  return {
    snapshots: plans.size,
    copiedPackageBytes: bytes,
    mechanism: 'lock-projection-installed-source-copy',
  };
}
