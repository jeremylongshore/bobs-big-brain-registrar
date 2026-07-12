import { resolveTeamKbPath } from '@qmd-team-intent-kb/common';

/** Runtime configuration for the control plane API */
export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  logLevel: string;
  /** Optional API key for bearer token auth. If unset, auth is skipped (dev mode). */
  apiKey?: string;
  /** Max requests per window for rate limiting (default 100) */
  rateLimitMax: number;
  /** Rate limit window in milliseconds (default 60000 = 1 minute) */
  rateLimitWindowMs: number;
  /** Maximum request body size in bytes (default 1MB) */
  maxBodySize: number;
}

/**
 * Load configuration from environment variables with sensible defaults.
 * The API port defaults to 3847, host to loopback, and database path
 * to ~/.teamkb/teamkb.db — the SAME file the plugin's local mode + the govern
 * sweep use, so a no-override deployment writes where the brain reads.
 */
export function loadConfig(): AppConfig {
  const apiKeyRaw = process.env['TEAMKB_API_KEY'];
  return {
    port: parseInt(process.env['TEAMKB_API_PORT'] ?? '3847', 10),
    // Coerce empty / whitespace-only TEAMKB_API_HOST to loopback. A bare ''
    // would otherwise pass the nullish-coalesce unchanged, be classified as
    // loopback by isLoopbackHost, and then bind :: (all interfaces) at listen
    // time (an unauthenticated brain reachable off-host). `||` collapses '' and
    // whitespace-only values to 127.0.0.1 before anything else sees them.
    host: process.env['TEAMKB_API_HOST']?.trim() || '127.0.0.1',
    // Default aligned to the plugin/brain path `~/.teamkb/teamkb.db` (jfv.10
    // footgun): the prior `data/teamkb.db` default diverged from the plugin's
    // `teamkb.db`, so a deployment without the TEAMKB_DB_PATH override silently
    // wrote teammate captures to a DB the govern sweep never read. TEAMKB_DB_PATH
    // still overrides for any bespoke layout.
    dbPath: process.env['TEAMKB_DB_PATH'] ?? resolveTeamKbPath('teamkb.db'),
    logLevel: process.env['TEAMKB_LOG_LEVEL'] ?? 'info',
    apiKey: apiKeyRaw !== undefined && apiKeyRaw !== '' ? apiKeyRaw : undefined,
    rateLimitMax: parseInt(process.env['TEAMKB_RATE_LIMIT_MAX'] ?? '100', 10),
    rateLimitWindowMs: parseInt(process.env['TEAMKB_RATE_LIMIT_WINDOW_MS'] ?? '60000', 10),
    maxBodySize: parseInt(process.env['TEAMKB_MAX_BODY_SIZE'] ?? '1048576', 10),
  };
}
