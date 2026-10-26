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
import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';

export interface RegistryFileIdentity {
  device: number;
  inode: number;
}
export type RegistryBindings = Record<string, RegistryFileIdentity>;

export function existingIdentity(path: string, directory: boolean): RegistryFileIdentity | null {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    realpathSync(path) !== path ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
    info.uid !== process.getuid?.()
  )
    throw new Error('Unsafe recovery registry path');
  return { device: info.dev, inode: info.ino };
}

export function bindDirectory(path: string, bindings: RegistryBindings, privateRoot = false): void {
  const identity = existingIdentity(path, true);
  if (identity === null || (privateRoot && (lstatSync(path).mode & 0o077) !== 0))
    throw new Error('Missing or nonprivate recovery registry directory');
  bindings[path] = identity;
}

/** Inspect every existing ancestor below an already bound root, without creating it. */
export function bindParents(path: string, root: string, bindings: RegistryBindings): void {
  const within = relative(root, path);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error('Recovery registry path escapes tenant root');
  let parent = dirname(path);
  while (parent !== root) {
    const identity = existingIdentity(parent, true);
    if (identity !== null) bindings[parent] = identity;
    parent = dirname(parent);
  }
}

export function readRegistry(
  path: string,
  bindings: RegistryBindings,
): { text: string; sha256: string } | null {
  const identity = existingIdentity(path, false);
  if (identity === null) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.dev !== identity.device ||
      before.ino !== identity.inode ||
      before.size > 1024 * 1024
    )
      throw new Error('Unsafe recovery registry file');
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(fd);
    const named = existingIdentity(path, false);
    if (
      used !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      named?.device !== identity.device ||
      named.inode !== identity.inode
    )
      throw new Error('Recovery registry changed during read');
    bindings[path] = identity;
    return {
      text: bytes.subarray(0, used).toString('utf8'),
      sha256: createHash('sha256').update(bytes.subarray(0, used)).digest('hex'),
    };
  } finally {
    closeSync(fd);
  }
}
