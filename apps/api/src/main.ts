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
 */
import { resolve } from 'node:path';
import { createDatabase } from '@qmd-team-intent-kb/store';
import { resolveTeamKbPath } from '@qmd-team-intent-kb/common';
import { QmdAdapter } from '@qmd-team-intent-kb/qmd-adapter';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { QmdQueryPort } from './services/search-service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase({ path: config.dbPath });

  // Attempt to wire qmd-backed cited search. If qmd is not installed or its
  // index is unavailable, run SQLite-only so the surface still answers.
  const tenantId = process.env['TEAMKB_TENANT_ID']?.trim() || 'intent-solutions';
  const exportDir = resolve(process.env['TEAMKB_EXPORT_DIR'] ?? resolveTeamKbPath('kb-export'));
  const adapter = new QmdAdapter({ tenantId, exportDir });

  let qmdAdapter: QmdQueryPort | undefined;
  const health = await adapter.health();
  if (health.available) {
    qmdAdapter = adapter;
    process.stderr.write(
      `[teamkb-api] qmd wired — cited search enabled (tenant=${tenantId}, qmd=${health.version ?? '?'})\n`,
    );
  } else {
    process.stderr.write(
      '[teamkb-api] qmd unavailable — falling back to SQLite text-match (no citations)\n',
    );
  }

  const app = buildApp({ db, apiKey: config.apiKey, qmdAdapter });
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
