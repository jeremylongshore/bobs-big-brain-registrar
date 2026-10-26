import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export interface RecoveryStoreWitness {
  databasePath: string;
  basePath: string;
  baseDevice: number;
  baseInode: number;
  databaseDevice: number;
  databaseInode: number;
}

/** Physical witness supplements data snapshots; it does not authenticate an operator. */
export function inspectRecoveryStore(databasePath: string): RecoveryStoreWitness {
  if (
    !isAbsolute(databasePath) ||
    normalize(databasePath) !== databasePath ||
    realpathSync(databasePath) !== databasePath
  ) {
    throw new Error('Recovery store path must be canonical and existing');
  }
  const basePath = dirname(databasePath);
  const base = lstatSync(basePath);
  const database = lstatSync(databasePath);
  if (
    !base.isDirectory() ||
    !database.isFile() ||
    database.nlink !== 1 ||
    base.uid !== process.getuid?.() ||
    database.uid !== process.getuid?.() ||
    (base.mode & 0o077) !== 0 ||
    (database.mode & 0o077) !== 0
  ) {
    throw new Error('Recovery store must be an owner-private directory and regular file');
  }
  return {
    databasePath,
    basePath,
    baseDevice: base.dev,
    baseInode: base.ino,
    databaseDevice: database.dev,
    databaseInode: database.ino,
  };
}

export function requireRecoveryStore(witness: RecoveryStoreWitness): void {
  if (!isDeepStrictEqual(inspectRecoveryStore(witness.databasePath), witness)) {
    throw new Error('Reviewed physical recovery store changed');
  }
}

/**
 * Lock the actual plugin/cron .write.lock using an inherited open-file description.
 * flock(1) exits after acquisition; the parent's duplicate descriptor retains the
 * kernel lock until close. No shell, fake held flag, mkdir or permission repair.
 */
export function acquireRecoveryWriteLock(
  witness: RecoveryStoreWitness,
  timeoutMs = 8000,
): { verify(): void; release(): void } {
  if (
    process.platform !== 'linux' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 30000
  ) {
    throw new Error('Recovery lock requires Linux and a bounded timeout');
  }
  requireRecoveryStore(witness);
  const path = join(witness.basePath, '.write.lock');
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.())
      throw new Error('Unsafe recovery lock file');
    const child = spawnSync(
      '/usr/bin/flock',
      ['--exclusive', '--timeout', String(timeoutMs / 1000), '3'],
      { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: timeoutMs + 2000, maxBuffer: 4096 },
    );
    if (child.error !== undefined || child.status !== 0)
      throw new Error('Recovery brain write lock unavailable');
    let released = false;
    const verify = (): void => {
      const after = lstatSync(path);
      if (
        released ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        realpathSync(path) !== path
      ) {
        throw new Error('Recovery lock path changed');
      }
      requireRecoveryStore(witness);
    };
    verify();
    return {
      verify,
      release: () => {
        if (!released) {
          released = true;
          closeSync(fd);
        }
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
