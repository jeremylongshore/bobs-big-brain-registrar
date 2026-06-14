import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getTeamKbBasePath, isPathSafe } from '@qmd-team-intent-kb/common';

/** Resolved configuration for the MCP server */
export interface McpServerConfig {
  /** Tenant identifier — scopes all operations */
  tenantId: string;
  /** Absolute path to the TeamKB base directory */
  basePath: string;
  /** Absolute path to the spool directory */
  spoolPath: string;
  /** Absolute path to the SQLite database file */
  dbPath: string;
  /** Absolute path to the feedback directory */
  feedbackPath: string;
  /**
   * Absolute path to the git-exporter output dir qmd indexes (local search
   * mode). Optional on the type so test configs can omit it; `resolveConfig`
   * always populates it and `teamkb_search` falls back to `<basePath>/kb-export`.
   */
  exportDir?: string;
  /**
   * The brain API base URL. When set, `teamkb_search` proxies to the remote
   * brain over HTTP (team mode, e.g. http://dev:3847). When unset, search runs
   * qmd in-process against the local index (demo/local mode). This is the
   * hosting flip: config, not a rewrite.
   */
  apiUrl?: string;
  /** Per-user bearer token sent to the remote brain API (team mode). */
  apiToken?: string;
}

/**
 * Resolve MCP server configuration from environment variables.
 *
 * Required:
 *   TEAMKB_TENANT_ID — tenant identifier
 *
 * Optional:
 *   TEAMKB_BASE_PATH — defaults to ~/.teamkb
 */
export function resolveConfig(): McpServerConfig {
  const tenantId = process.env['TEAMKB_TENANT_ID'];
  if (!tenantId || tenantId.trim() === '') {
    throw new Error('TEAMKB_TENANT_ID environment variable is required');
  }

  const rawBasePath = getTeamKbBasePath();
  const basePath = resolve(rawBasePath);

  // Validate TEAMKB_BASE_PATH against path traversal (must be under home directory)
  const home = homedir();
  const pathCheck = isPathSafe(basePath, [home]);
  if (!pathCheck.safe) {
    throw new Error(`TEAMKB_BASE_PATH is invalid: ${pathCheck.reason}`);
  }

  const apiUrlRaw = process.env['TEAMKB_API_URL'];
  const apiTokenRaw = process.env['TEAMKB_API_TOKEN'] ?? process.env['TEAMKB_API_KEY'];

  return {
    tenantId: tenantId.trim(),
    basePath,
    spoolPath: join(basePath, 'spool'),
    dbPath: join(basePath, 'teamkb.db'),
    feedbackPath: join(basePath, 'feedback'),
    exportDir: process.env['TEAMKB_EXPORT_DIR']
      ? resolve(process.env['TEAMKB_EXPORT_DIR'])
      : join(basePath, 'kb-export'),
    apiUrl: apiUrlRaw !== undefined && apiUrlRaw !== '' ? apiUrlRaw : undefined,
    apiToken: apiTokenRaw !== undefined && apiTokenRaw !== '' ? apiTokenRaw : undefined,
  };
}
