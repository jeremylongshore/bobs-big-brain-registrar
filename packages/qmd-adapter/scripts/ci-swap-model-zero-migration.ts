#!/usr/bin/env tsx
/**
 * ci-swap-model-zero-migration — prove that swapping the reranker model
 * identity requires ZERO governed-state migration (seam-independence CI job
 * `swap-model-zero-migration`; blueprint bead B3; workflow
 * `.github/workflows/seam-independence.yml`).
 *
 * The property, by construction: `buildRerankStage` (adapter.ts) keys the
 * content-addressed sidecar score cache on the PINNED reranker identity —
 * `(model file, weights sha256)` from QMD_WEIGHTS_MANIFEST — and the sidecar
 * lives beside the other derived indexes, never inside the governed store. So
 * a model bump is a CACHE-NAMESPACE change, not a schema change: prior scores
 * become invisible (and are lazily rebuilt), and no governed table is touched.
 *
 * This script proves it dynamically, using a SWAPPED model identity exactly
 * where buildRerankStage reads the manifest entry (a fixture identity with a
 * different file + sha256):
 *
 *   1. Creates a real governed store (createDatabase → full DDL + migrations)
 *      in a temp dir, closes it, and byte-hashes the DB file.
 *   2. Opens a RerankCache under the PINNED reranker identity, stores a score.
 *   3. Re-opens the SAME sidecar file under the SWAPPED identity and asserts:
 *        a. the stale score is a MISS (namespace change — a swapped model can
 *           never serve another model's scores),
 *        b. writing under the swapped identity coexists with the old row
 *           (2 rows; nothing destroyed, nothing migrated),
 *        c. the sidecar's sqlite schema is BYTE-IDENTICAL before/after the
 *           swap (a namespace change, not a schema change).
 *   4. Asserts the governed store needed ZERO migration for the swap:
 *        d. the DB file bytes are untouched (the rerank path never opened it),
 *        e. re-opening the store applies no new migration
 *           (MAX(schema_migrations.version) unchanged),
 *        f. the governed schema hash (sqlite_master) is unchanged.
 *
 * Any failed assertion exits 1 with a diagnostic — the CI job goes red if the
 * cache stops keying on model identity, if a model swap starts mutating the
 * governed store, or if it starts requiring a migration.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { createDatabase } from '@qmd-team-intent-kb/store';

import { RerankCache } from '../src/rerank/rerank-cache.js';
import { rerankScore } from '../src/rerank/rerank-client.js';
import { QMD_WEIGHTS_MANIFEST } from '../src/weights/weights-manifest.js';

function fail(msg: string): never {
  throw new Error(msg);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Canonical hash of a SQLite database's schema (sqlite_master DDL, sorted). */
function schemaHash(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master ORDER BY type, name")
      .all() as Array<{ type: string; name: string; sql: string }>;
    return createHash('sha256')
      .update(rows.map((r) => `${r.type}\x00${r.name}\x00${r.sql}`).join('\x01'))
      .digest('hex');
  } finally {
    db.close();
  }
}

function maxMigrationVersion(db: ReturnType<typeof createDatabase>): number {
  return (
    db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as {
      v: number;
    }
  ).v;
}

const root = mkdtempSync(join(tmpdir(), 'seam-swap-model-'));
try {
  // ---- 1. A real governed store, then hands off it -------------------------
  const governedDbPath = join(root, 'governed', 'teamkb.db');
  const governed = createDatabase({ path: governedDbPath });
  const migrationsBefore = maxMigrationVersion(governed);
  governed.close();
  const governedBytesBefore = sha256File(governedDbPath);
  const governedSchemaBefore = schemaHash(governedDbPath);

  // ---- 2. Pinned identity — exactly what buildRerankStage reads -----------
  const pinned = QMD_WEIGHTS_MANIFEST.models.find((m) => m.id === 'reranker');
  if (pinned === undefined) fail('weights manifest has no reranker entry');

  // Swapped identity fixture: a different GGUF file + sha256, i.e. the model
  // bump buildRerankStage would pick up from an updated manifest entry.
  const swapped = {
    file: 'hf_fixture_swapped-reranker-q8_0.gguf',
    sha256: createHash('sha256').update('seam-swapped-reranker-weights').digest('hex'),
  };
  if (swapped.file === pinned.file || swapped.sha256 === pinned.sha256) {
    fail('fixture identity must differ from the pinned identity');
  }

  const sidecarPath = join(root, 'qmd-index', 'tenant', 'rerank-cache.sqlite');
  const query = 'what does the seam firewall enforce?';
  const docContentHash = createHash('sha256').update('seam doc body').digest('hex');

  const cacheA = new RerankCache({
    path: sidecarPath,
    modelId: pinned.file,
    modelVersion: pinned.sha256,
  });
  cacheA.set(query, docContentHash, rerankScore(0.91));
  if (cacheA.get(query, docContentHash) === null) {
    fail('pinned-identity score did not round-trip through the sidecar cache');
  }
  cacheA.close();
  const sidecarSchemaBefore = schemaHash(sidecarPath);

  // ---- 3. Same sidecar, swapped model identity ----------------------------
  const cacheB = new RerankCache({
    path: sidecarPath,
    modelId: swapped.file,
    modelVersion: swapped.sha256,
  });
  const stale = cacheB.get(query, docContentHash);
  if (stale !== null) {
    fail(
      'PROPERTY BROKEN: the swapped model identity HIT a score cached under the ' +
        'pinned identity — the sidecar cache no longer keys on (model file, weights sha), ' +
        'so a model bump would silently serve stale scores',
    );
  }
  cacheB.set(query, docContentHash, rerankScore(0.42));
  if (cacheB.get(query, docContentHash) === null) {
    fail('swapped-identity score did not round-trip through the sidecar cache');
  }
  const rows = cacheB.count();
  if (rows !== 2) {
    fail(
      `PROPERTY BROKEN: expected the old and new identity rows to coexist (2 rows), got ${rows} — ` +
        'a model swap must not destroy or migrate prior cache state',
    );
  }
  cacheB.close();

  const sidecarSchemaAfter = schemaHash(sidecarPath);
  if (sidecarSchemaAfter !== sidecarSchemaBefore) {
    fail(
      'PROPERTY BROKEN: the sidecar sqlite schema changed across the model swap — ' +
        'a model bump must be a cache-NAMESPACE change, never a schema change',
    );
  }

  // ---- 4. The governed store needed zero migration ------------------------
  const governedBytesAfter = sha256File(governedDbPath);
  if (governedBytesAfter !== governedBytesBefore) {
    fail(
      'PROPERTY BROKEN: the governed store file changed during the model swap — ' +
        'the rerank path must never touch a governed table',
    );
  }
  const reopened = createDatabase({ path: governedDbPath });
  const migrationsAfter = maxMigrationVersion(reopened);
  reopened.close();
  if (migrationsAfter !== migrationsBefore) {
    fail(
      `PROPERTY BROKEN: re-opening the governed store after the model swap applied new ` +
        `migrations (${migrationsBefore} -> ${migrationsAfter}) — a model swap must need ` +
        'zero governed-state migration',
    );
  }
  const governedSchemaAfter = schemaHash(governedDbPath);
  if (governedSchemaAfter !== governedSchemaBefore) {
    fail('PROPERTY BROKEN: the governed schema hash changed across the model swap');
  }

  process.stdout.write(
    'swap-model zero-migration: OK\n' +
      `  pinned reranker    ${pinned.file} (${pinned.sha256.slice(0, 12)}…)\n` +
      `  swapped fixture    ${swapped.file} (${swapped.sha256.slice(0, 12)}…)\n` +
      `  sidecar            stale score MISS under swapped identity; 2 rows coexist; schema identical\n` +
      `  governed store     bytes identical; migrations ${migrationsBefore} -> ${migrationsAfter}; schema hash identical\n`,
  );
} catch (error) {
  process.stderr.write(`swap-model zero-migration: FAIL — ${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
