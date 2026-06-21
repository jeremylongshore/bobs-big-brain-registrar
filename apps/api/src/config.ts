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
 * to ~/.teamkb/data/teamkb.db.
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
    dbPath: process.env['TEAMKB_DB_PATH'] ?? resolveTeamKbPath('data/teamkb.db'),
    logLevel: process.env['TEAMKB_LOG_LEVEL'] ?? 'info',
    apiKey: apiKeyRaw !== undefined && apiKeyRaw !== '' ? apiKeyRaw : undefined,
    rateLimitMax: parseInt(process.env['TEAMKB_RATE_LIMIT_MAX'] ?? '100', 10),
    rateLimitWindowMs: parseInt(process.env['TEAMKB_RATE_LIMIT_WINDOW_MS'] ?? '60000', 10),
    maxBodySize: parseInt(process.env['TEAMKB_MAX_BODY_SIZE'] ?? '1048576', 10),
  };
}
