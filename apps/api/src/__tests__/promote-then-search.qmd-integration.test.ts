/**
 * D1 acceptance: a promoted memory becomes retrievable IMMEDIATELY.
 *
 * Drives the REAL path end-to-end against the real qmd binary: a candidate is
 * promoted through `POST /api/candidates/:id/promote` with the production
 * `buildIndexRefresher` wired (exactly as `main.ts` wires it), and the adapter
 * then finds the new memory — with NO manual export/reindex call in the test
 * body. Before D1 this exact sequence returned 0 hits until the next daemon
 * cycle / nightly govern pass ran.
 *
 * Also asserts the D2 side: the completed chain records `last_indexed_at`, so
 * the staleness gauge reads 0 (fresh) — proving the FULL export→reindex chain
 * ran (the gauge is only marked on full success), not just the native-FTS5
 * fusion half masking a broken qmd path.
 *
 * Isolation mirrors adapter-qmd-integration.test.ts: TEAMKB_BASE_PATH is
 * repointed at a tmp dir so the tenant's qmd registry/index never touch the
 * operator's real ~/.teamkb. Skipped when qmd is not on PATH (CI puts the
 * pinned workspace bin on PATH).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

import {
  createTestDatabase,
  CandidateRepository,
  IndexStateRepository,
} from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { QmdAdapter } from '@qmd-team-intent-kb/qmd-adapter';
import { buildApp } from '../app.js';
import { buildIndexRefresher } from '../services/index-refresher.js';
import { makeCandidate } from './fixtures.js';

function qmdAvailable(): boolean {
  try {
    execFileSync('qmd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_QMD = qmdAvailable();
const TENANT = 'promote-search-e2e';

describe.skipIf(!HAS_QMD)('promote → search immediately (D1, real qmd)', () => {
  let workDir: string;
  let exportDir: string;
  let originalBasePath: string | undefined;
  let db: Database.Database;
  let app: FastifyInstance;
  let adapter: QmdAdapter;
  let indexStateRepo: IndexStateRepository;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'promote-search-int-'));
    exportDir = join(workDir, 'kb-export');
    originalBasePath = process.env['TEAMKB_BASE_PATH'];
    process.env['TEAMKB_BASE_PATH'] = join(workDir, 'teamkb');

    db = createTestDatabase();
    indexStateRepo = new IndexStateRepository(db);
    adapter = new QmdAdapter({
      tenantId: TENANT,
      exportDir,
      stalenessProbe: () => indexStateRepo.stalenessSeconds(TENANT),
    });
    // The production wiring from main.ts: refresher over the same db + adapter.
    const indexRefresher = buildIndexRefresher({ db, adapter, exportDir });
    app = buildApp({ db, silent: true, qmdAdapter: adapter, indexRefresher });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    if (originalBasePath === undefined) delete process.env['TEAMKB_BASE_PATH'];
    else process.env['TEAMKB_BASE_PATH'] = originalBasePath;
    rmSync(workDir, { recursive: true, force: true });
  });

  it('a memory promoted via the API is retrievable with no manual reindex', async () => {
    const candidate = makeCandidate({
      tenantId: TENANT,
      title: 'Zephyr turbine maintenance cadence',
      content:
        'The zephyr turbine maintenance cadence is quarterly: inspect the ' +
        'flux capacitor housing, torque the manifold bolts, and log the ' +
        'inspection receipt in the maintenance ledger.',
    });
    new CandidateRepository(db).insert(candidate, computeContentHash(candidate.content));

    // Promote through the real route (dev mode = admin; gating covered elsewhere).
    const res = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/promote?tenantId=${TENANT}`,
    });
    expect(res.statusCode).toBe(200);
    const memory = res.json() as { id: string; lifecycle: string };
    expect(memory.lifecycle).toBe('active');

    // NO manual export/reindex here — that is the point of D1.
    const found = await adapter.query('zephyr turbine maintenance', 'all', TENANT);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.value.length).toBeGreaterThan(0);
      // The hit is the exported markdown of the promoted memory, cited via qmd://.
      expect(found.value.some((r) => r.file.startsWith('qmd://'))).toBe(true);
    }

    // D2 cross-check: the chain recorded completion, so staleness is 0 (fresh).
    // This proves the FULL export→reindex chain ran — the gauge is only marked
    // on full success, so a broken qmd path masked by native-FTS5 fusion would
    // leave this null/positive.
    expect(indexStateRepo.stalenessSeconds(TENANT)).toBe(0);

    // And the health surfaces agree end-to-end.
    const health = await adapter.health();
    expect(health.stalenessSeconds).toBe(0);
    const apiHealth = await app.inject({ method: 'GET', url: '/api/health' });
    expect(apiHealth.json<{ indexStalenessSeconds: number | null }>().indexStalenessSeconds).toBe(
      0,
    );
  }, 60_000);

  it('a failed refresh leaves the promotion durable and the staleness gauge honest', async () => {
    // A refresher whose chain always fails — the memory must still promote (200)
    // and the gauge must NOT be marked fresh.
    const failingRefresher = {
      refreshAfterPromotion: async () => ({ ok: false, error: 'synthetic chain failure' }),
    };
    const app2 = buildApp({ db, silent: true, indexRefresher: failingRefresher });
    await app2.ready();
    try {
      const candidate = makeCandidate({
        tenantId: TENANT,
        content: 'Distinct content for the failed-refresh path with enough length to pass.',
      });
      new CandidateRepository(db).insert(candidate, computeContentHash(candidate.content));

      const res = await app2.inject({
        method: 'POST',
        url: `/api/candidates/${candidate.id}/promote?tenantId=${TENANT}`,
      });
      expect(res.statusCode).toBe(200); // promotion durable despite refresh failure

      // Never marked → still unmeasured (no index_state row was ever written).
      expect(indexStateRepo.stalenessSeconds(TENANT)).toBeNull();
    } finally {
      await app2.close();
    }
  }, 30_000);
});
