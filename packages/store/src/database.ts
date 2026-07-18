import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { TABLE_DDL, MIGRATIONS } from './schema.js';

/** Options for creating a database connection */
export interface DatabaseOptions {
  /** Filesystem path or ':memory:' for an in-process test database */
  path: string;
  readonly?: boolean;
}

/**
 * Ensure the parent directory of a database file exists with restricted
 * permissions (0700). The database file itself is set to 0600 after creation.
 * Skipped for in-memory databases.
 */
function ensureSecureDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return;

  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Apply restrictive file permissions (0600) to a database file.
 * Silently ignores failures (e.g., on Windows or in-memory DBs).
 */
function secureDbFile(dbPath: string): void {
  if (dbPath === ':memory:') return;

  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // Best-effort: permissions may not be supported on all platforms
  }
}

/**
 * Initialize a SQLite database connection with WAL mode enabled and
 * idempotent schema creation. Tables are created on first call and
 * left untouched on subsequent calls.
 *
 * Security: Parent directory is created with 0700, DB file set to 0600.
 * Performance: WAL mode + busy_timeout + synchronous=NORMAL.
 */
export function createDatabase(options: DatabaseOptions): Database.Database {
  if (!(options.readonly ?? false)) {
    ensureSecureDirectory(options.path);
  }

  const db = new Database(options.path, {
    readonly: options.readonly ?? false,
  });

  if (!(options.readonly ?? false)) {
    // WAL mode gives better concurrent read performance while still
    // being safe for single-writer workloads.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');

    for (const ddl of TABLE_DDL) {
      db.exec(ddl);
    }

    runMigrations(db);

    secureDbFile(options.path);
  }

  return db;
}

/**
 * Run all pending schema migrations in a transaction.
 *
 * Each migration is tracked in the `schema_migrations` table by version number.
 * Only migrations with versions greater than the current max are applied.
 * Runs inside a transaction so partial migration failures roll back cleanly.
 */
function runMigrations(db: Database.Database): void {
  const currentVersion = db
    .prepare('SELECT COALESCE(MAX(version), 0) as v FROM schema_migrations')
    .get() as { v: number };

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion.v).sort(
    (a, b) => a.version - b.version,
  );

  if (pending.length === 0) return;

  // A table-rebuild migration (5bm.9) does DROP + RENAME on a table referenced
  // by a foreign key. `PRAGMA foreign_keys` is a no-op inside a transaction, so
  // it must be toggled here, around the batch. We disable enforcement for the
  // rebuild and re-verify integrity with `foreign_key_check` before commit.
  const needsForeignKeysOff = pending.some((m) => m.rebuildsTable === true);
  if (needsForeignKeysOff) {
    db.pragma('foreign_keys = OFF');
  }

  const applyAll = db.transaction(() => {
    for (const migration of pending) {
      if (migration.apply !== undefined) {
        migration.apply(db);
      } else if (migration.sql !== undefined) {
        db.exec(migration.sql);
      } else {
        throw new Error(
          `Migration ${migration.version} (${migration.name}) has neither sql nor apply`,
        );
      }
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name,
      );
    }
    // Verify referential integrity inside the transaction so a violation rolls
    // the whole rebuild back rather than committing a corrupt graph.
    if (needsForeignKeysOff) {
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (Array.isArray(violations) && violations.length > 0) {
        throw new Error(
          `Migration foreign_key_check found ${violations.length} violation(s): ${JSON.stringify(
            violations,
          )}`,
        );
      }
    }
  });

  try {
    applyAll();
  } finally {
    if (needsForeignKeysOff) {
      db.pragma('foreign_keys = ON');
    }
  }
}

/**
 * Create an in-memory SQLite database. The database is destroyed when
 * the connection is closed. Intended for use in tests only.
 */
export function createTestDatabase(): Database.Database {
  return createDatabase({ path: ':memory:' });
}
