#!/usr/bin/env node
/**
 * Control-plane API entry point — the brain's query surface.
 *
 * Boots the Fastify app and actually `.listen()`s (the `index.ts` barrel only
 * re-exports the factory; nothing there starts a server). Wires a `QmdAdapter`
 * into search when qmd is available so `POST /api/search` returns `qmd://`-cited
 * results; otherwise falls back to SQLite text-match over the curated store.
 *
 * Binds loopback (127.0.0.1) by default. To serve the team over Tailscale, set
 * `TEAMKB_API_HOST` to the tailnet IP (e.g. 100.x) — never `0.0.0.0` on a
 * public interface.
 *
 * Env:
 *   TEAMKB_API_PORT     — listen port (default 3847)
 *   TEAMKB_API_HOST     — bind interface (default 127.0.0.1)
 *   TEAMKB_API_KEY      — bearer token; required when NODE_ENV=production
 *   TEAMKB_DB_PATH      — SQLite path (default ~/.teamkb/data/teamkb.db)
 *   TEAMKB_TENANT_ID    — tenant scope for qmd isolation (default intent-solutions)
 *   TEAMKB_EXPORT_DIR   — git-exporter output dir qmd indexes (default ~/.teamkb/kb-export)
 *   TEAMKB_REVOKED_FILE — durable revoke-by-actor list (default ~/.teamkb/revoked-actors.json)
 *   TEAMKB_ALLOWED_CHANNELS — comma-separated origin channels captures may claim
 *                         (H3; default: team-mcp,local-mcp)
 *   TEAMKB_ORIGIN_SECRET — per-installation origin-token secret override (H1;
 *                         default: auto-generated ~/.teamkb/origin-secret, 0600)
 */
import { resolve } from 'node:path';
import { createDatabase, IndexStateRepository } from '@qmd-team-intent-kb/store';
import {
  loadOrCreateOriginSecret,
  ORIGIN_SECRET_UNAVAILABLE_WARNING,
  resolveTeamKbPath,
} from '@qmd-team-intent-kb/common';
import { QmdAdapter } from '@qmd-team-intent-kb/qmd-adapter';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadTokenRecords } from './auth/token-registry.js';
import type { QmdQueryPort } from './services/search-service.js';
import { buildIndexRefresher } from './services/index-refresher.js';
import type { IndexRefresher } from './services/index-refresher.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase({ path: config.dbPath });

  // Attempt to wire qmd-backed cited search. If qmd is not installed or its
  // index is unavailable, run SQLite-only so the surface still answers.
  const tenantId = process.env['TEAMKB_TENANT_ID']?.trim() || 'intent-solutions';
  const exportDir = resolve(process.env['TEAMKB_EXPORT_DIR'] ?? resolveTeamKbPath('kb-export'));
  // Freshness probe (D2): adapter.health() reports stalenessSeconds from the
  // governed store — seconds since the oldest promotion the index has not
  // absorbed (null = measurement not started; see IndexStateRepository).
  const indexStateRepo = new IndexStateRepository(db);
  const adapter = new QmdAdapter({
    tenantId,
    exportDir,
    stalenessProbe: () => indexStateRepo.stalenessSeconds(tenantId),
  });

  let qmdAdapter: QmdQueryPort | undefined;
  let indexRefresher: IndexRefresher | undefined;
  const health = await adapter.health();
  if (health.available) {
    qmdAdapter = adapter;
    // D1: a promote through this API triggers export→reindex after the
    // promotion commits, so the memory is searchable immediately.
    indexRefresher = buildIndexRefresher({ db, adapter, exportDir });
    process.stderr.write(
      `[teamkb-api] qmd wired — cited search enabled (tenant=${tenantId}, qmd=${health.version ?? '?'})\n`,
    );
  } else {
    process.stderr.write(
      '[teamkb-api] qmd unavailable — falling back to SQLite text-match (no citations)\n',
    );
  }

  // Per-user tokens: TEAMKB_TOKENS (json) / TEAMKB_TOKENS_FILE / default
  // ~/.teamkb/tokens.json, falling back to the single TEAMKB_API_KEY. Each
  // record maps token → actor + role; revocation = drop a record + restart.
  const tokens = loadTokenRecords({
    apiKey: config.apiKey,
    tokensJson: process.env['TEAMKB_TOKENS'],
    tokensFile: process.env['TEAMKB_TOKENS_FILE'] ?? resolveTeamKbPath('tokens.json'),
  });
  if (tokens.length > 0) {
    const roles = tokens.map((t) => `${t.actor}:${t.role}`).join(', ');
    process.stderr.write(`[teamkb-api] auth: ${tokens.length} token(s) loaded — ${roles}\n`);
  }

  // Durable revoke-by-actor list — default under the brain base so a stolen
  // laptop can be revoked by identity and the ban survives a restart.
  const revokedFile =
    process.env['TEAMKB_REVOKED_FILE'] ?? resolveTeamKbPath('revoked-actors.json');

  // Write-time provenance wiring (GSB Wave-2 H1/H3). The origin secret is the
  // brain installation's — auto-created 0600 under ~/.teamkb on first boot (env
  // TEAMKB_ORIGIN_SECRET overrides; never logged). Best-effort: a read-only
  // base dir degrades to "unattested candidates only" rather than refusing to
  // boot (origin-claiming candidates then reject fail-closed at promotion).
  let originSecret: string | undefined;
  try {
    originSecret = loadOrCreateOriginSecret();
  } catch (e) {
    process.stderr.write(
      `[teamkb-api] ${ORIGIN_SECRET_UNAVAILABLE_WARNING} (${e instanceof Error ? e.message : String(e)})\n`,
    );
  }
  const allowedChannelsRaw = process.env['TEAMKB_ALLOWED_CHANNELS'];
  const allowedChannels =
    allowedChannelsRaw !== undefined && allowedChannelsRaw.trim() !== ''
      ? allowedChannelsRaw
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
      : undefined;

  // Pass the real bind host so the no-auth dev path is refused off-loopback:
  // an empty registry on a tailnet/0.0.0.0 bind throws at boot rather than
  // serving every request as role=admin. Loopback stays the default.
  const app = buildApp({
    db,
    tokens,
    qmdAdapter,
    indexRefresher,
    bindHost: config.host,
    revokedFile,
    allowedChannels,
    originSecret,
  });
  await app.ready();

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[teamkb-api] Received ${signal}, shutting down\n`);
    try {
      await app.close();
      db.close();
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[teamkb-api] Error during shutdown: ${msg}\n`);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  process.stderr.write(`[teamkb-api] Listening on http://${config.host}:${config.port}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[teamkb-api] Fatal: ${msg}\n`);
  process.exit(1);
});
