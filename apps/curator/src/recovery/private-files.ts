import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';

export const MAX_RECOVERY_FILE_BYTES = 64 * 1024 * 1024;

/** Private owner-only, single-link regular file; bounded read on the opened inode. */
export function readPrivateRecoveryFile(path: string, maximum = MAX_RECOVERY_FILE_BYTES): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > maximum
    ) {
      throw new Error('Recovery input must be a bounded private owner file');
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > maximum) throw new Error('Recovery input grew beyond its bound');
    const after = fstatSync(fd);
    if (after.size !== size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error('Recovery input changed during read');
    }
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Never replace an existing plan or follow a final-component symlink. */
export function writePrivateRecoveryFile(path: string, value: unknown): void {
  const parent = dirname(path);
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(parent) !== parent) {
    throw new Error('Recovery output path must be canonical');
  }
  const directory = statSync(parent);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error('Recovery output directory must be private');
  }
  const text = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_RECOVERY_FILE_BYTES)
    throw new Error('Recovery plan exceeds file bound');
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
