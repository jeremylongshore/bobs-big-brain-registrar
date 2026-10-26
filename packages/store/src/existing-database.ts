import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema.js';

export interface ExistingDatabaseOptions {
  path: string;
  readonly: boolean;
}

/**
 * Open an existing current-schema store without creation, migration, journal-mode
 * changes or chmod. Caller owns physical-store authority and the write lock.
 */
export function openExistingDatabase(options: ExistingDatabaseOptions): Database.Database {
  if (
    typeof options.readonly !== 'boolean' ||
    !isAbsolute(options.path) ||
    normalize(options.path) !== options.path ||
    realpathSync(options.path) !== options.path
  ) {
    throw new Error('Existing store requires an explicit canonical path and access mode');
  }
  const fd = openSync(
    options.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let db: Database.Database | undefined;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1)
      throw new Error('Existing store must be a regular unaliased file');
    db = new Database(options.path, { readonly: options.readonly, fileMustExist: true });
    const after = statSync(options.path);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      realpathSync(options.path) !== options.path
    ) {
      throw new Error('Existing store changed while opening');
    }
    const applied = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all();
    const expected = [...MIGRATIONS]
      .sort((a, b) => a.version - b.version)
      .map(({ version, name }) => ({ version, name }));
    if (!isDeepStrictEqual(applied, expected))
      throw new Error('Existing store schema requires an explicit migration');
    if (!options.readonly) {
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
    }
    return db;
  } catch (error) {
    db?.close();
    throw error;
  } finally {
    closeSync(fd);
  }
}
