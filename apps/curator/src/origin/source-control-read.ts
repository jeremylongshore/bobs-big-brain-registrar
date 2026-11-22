import type Database from 'better-sqlite3';

/** Trusted identity/clock providers must be reads. The owning transaction rolls
 * back detected row writes even on preview or historical replay paths. This
 * counter is not a sandbox for DDL, pragmas, other connections or external effects.
 */
export function readSourceControlInput<T>(db: Database.Database, read: () => T): T {
  if (!db.inTransaction) throw new Error('Source control reads require an owning transaction');
  const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const before = changes();
  const value = read();
  if (changes() !== before) throw new Error('Source control input provider wrote to the store');
  return value;
}
