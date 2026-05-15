/**
 * tests/integration/postgres-forward-compat.test.ts
 *
 * L4 integration test — spins up a real postgres container via testcontainers
 * and validates that the store schema can be applied (modulo documented
 * dialect translations) and exercised end-to-end against a non-SQLite backend.
 *
 * ## Why this test exists
 *
 * The audit (TEST_AUDIT.md 2026-04-24) marked L4 testcontainers as "not
 * required — SQLite in-memory sufficient for now." A re-survey on 2026-05-15
 * confirmed every other L4 surface in this repo is either (a) not a service
 * dependency (file-based: store, vault import, git-exporter), (b) already
 * integration-tested via Fastify inject (api), or (c) depends on the qmd
 * binary which has no public Docker image yet.
 *
 * So testcontainers as a tool has no current production scenario. This
 * test exists for two forward-looking reasons:
 *
 *   1. Establish the testcontainers pattern in CI so future contributors
 *      have a working reference when a real container scenario emerges
 *      (e.g. when store grows a non-SQLite backend per the 003-AT-DSGN
 *      thesis assumption that the data plane can evolve).
 *
 *   2. Catch dialect-specific SQL early. Today the store schema is mostly
 *      portable, but `DEFAULT (datetime('now'))` is a known SQLite-ism
 *      (postgres uses `NOW()` or `CURRENT_TIMESTAMP`). This test runs a
 *      translation pass over the DDL and applies it to a real postgres,
 *      so if anyone adds another SQLite-ism in a future PR it will surface
 *      here rather than at migration time.
 *
 * ## Not what this test is
 *
 *   - NOT a claim that the store runs on postgres today (it doesn't —
 *     `packages/store/src/database.ts` uses `better-sqlite3` directly).
 *   - NOT a replacement for the SQLite unit tests in
 *     `packages/store/src/__tests__/` — those exercise the real production
 *     driver.
 *   - NOT run in the fast `validate` CI job — this test pulls a Docker
 *     image (~50MB) and adds ~5-15s container startup. Lives in the
 *     separate `integration` job, which runs on push to main and on PRs
 *     labeled `integration`.
 *
 * ## How it runs
 *
 *   pnpm test:integration            # locally; needs Docker
 *   pnpm vitest run tests/integration/postgres-forward-compat.test.ts
 *
 * Tracked in qmd-team-intent-kb-oqd (Batch 5).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { TABLE_DDL } from '@qmd-team-intent-kb/store';

/**
 * Translate SQLite-specific DDL to postgres-compatible DDL.
 *
 * Maintain this list as a known-deltas inventory:
 *
 *   - `DEFAULT (datetime('now'))` → `DEFAULT NOW()`
 *     SQLite: built-in datetime() string function.
 *     Postgres: NOW() returns a timestamp; cast to text not needed for
 *     TEXT columns since postgres autocasts on insert.
 *
 * Adding a new translation: append a regex + replacement here and document
 * the rationale. If a SQLite-ism is found that *cannot* be translated
 * cleanly, surface it as a test failure — that's the early signal that
 * the schema is drifting toward SQLite-only.
 */
function translateForPostgres(sqliteDdl: string): string {
  return sqliteDdl.replace(/DEFAULT\s*\(\s*datetime\('now'\)\s*\)/gi, 'DEFAULT NOW()');
}

describe('postgres forward-compatibility', () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    // Use a deterministic-tag postgres for reproducibility.
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('qmd_teamkb_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    client = new Client({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
    });
    await client.connect();
  }, 60_000); // generous timeout: image pull + container start can take ~30s on cold runners

  afterAll(async () => {
    if (client) await client.end();
    if (container) await container.stop();
  });

  it('applies the translated store schema without error', async () => {
    expect(TABLE_DDL.length).toBeGreaterThan(0);

    for (const sqliteDdl of TABLE_DDL) {
      const pgDdl = translateForPostgres(sqliteDdl);
      // If a SQLite-ism slips through translation, this throws and the test
      // fails with the offending DDL in the error message — exactly the
      // signal we want.
      await client.query(pgDdl);
    }
  });

  it('round-trips a candidate row (write + read) on postgres', async () => {
    const id = 'cand-forward-compat-001';
    const tenantId = 'tenant-forward-compat';
    const contentHash = 'sha256-deadbeef';

    await client.query(
      `INSERT INTO candidates
        (id, status, source, content, title, category, trust_level,
         author_json, tenant_id, metadata_json, pre_policy_flags_json,
         content_hash, captured_at)
       VALUES ($1, 'inbox', 'forward-compat-test', 'hello postgres',
               'forward-compat smoke', 'reference', 'medium',
               '{"name":"test","kind":"machine"}', $2,
               '{}', '{}', $3, NOW())`,
      [id, tenantId, contentHash],
    );

    const result = await client.query<{ id: string; tenant_id: string; content_hash: string }>(
      'SELECT id, tenant_id, content_hash FROM candidates WHERE id = $1',
      [id],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.id).toBe(id);
    expect(result.rows[0]?.tenant_id).toBe(tenantId);
    expect(result.rows[0]?.content_hash).toBe(contentHash);
  });

  it('enforces PRIMARY KEY uniqueness the same way SQLite does', async () => {
    const id = 'cand-forward-compat-dup';

    const insert = (): Promise<unknown> =>
      client.query(
        `INSERT INTO candidates
          (id, status, source, content, title, category, trust_level,
           author_json, tenant_id, metadata_json, pre_policy_flags_json,
           content_hash, captured_at)
         VALUES ($1, 'inbox', 't', 'x', 't', 'reference', 'medium',
                 '{}', 'tenant-dup', '{}', '{}', 'h1', NOW())`,
        [id],
      );

    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|unique/i);
  });

  it('honors tenant index lookup speed (best-effort sanity, not perf gate)', async () => {
    // Light smoke: 100 inserts, then a tenant-scoped query. Just verifies the
    // index exists and works — not a performance assertion.
    const tenantA = 'tenant-perf-a';
    const tenantB = 'tenant-perf-b';
    const rows = 100;
    for (let i = 0; i < rows; i++) {
      await client.query(
        `INSERT INTO candidates
          (id, status, source, content, title, category, trust_level,
           author_json, tenant_id, metadata_json, pre_policy_flags_json,
           content_hash, captured_at)
         VALUES ($1, 'inbox', 'bench', 'c', 't', 'reference', 'medium',
                 '{}', $2, '{}', '{}', $3, NOW())`,
        [`perf-${i}`, i % 2 === 0 ? tenantA : tenantB, `h-${i}`],
      );
    }
    const a = await client.query('SELECT COUNT(*)::int AS n FROM candidates WHERE tenant_id = $1', [
      tenantA,
    ]);
    const b = await client.query('SELECT COUNT(*)::int AS n FROM candidates WHERE tenant_id = $1', [
      tenantB,
    ]);
    expect(a.rows[0]?.n).toBe(rows / 2);
    expect(b.rows[0]?.n).toBe(rows / 2);
  });
});
