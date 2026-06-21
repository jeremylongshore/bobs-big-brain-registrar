import { join } from 'node:path';
import { homedir } from 'node:os';

/** Default base path for TeamKB data */
export const DEFAULT_TEAMKB_BASE = join(homedir(), '.teamkb');

/**
 * Resolve the TeamKB base path. This is the READ side of the ICO → INTKB spool
 * handoff: INTKB's spool reader, edge daemon, and curator all derive their
 * default spool directory (`<base>/spool`) from this function, so it MUST land
 * on the same base ICO's `ico spool emit` writes to — otherwise candidates flow
 * into a directory INTKB never polls and zero memories cross the boundary (the
 * default-path mismatch documented in the Epic 0 spool grounding).
 *
 * ICO's emitter (`packages/cli/src/commands/spool.ts` → `resolveTeamKbBase`)
 * resolves its write base with the precedence below; this function mirrors it
 * exactly so an operator who sets *either* env name — or neither — gets a
 * consistent write path == read path with no extra wiring:
 *
 *   1. `TEAMKB_BASE_PATH` — INTKB's canonical override.
 *   2. `TEAMKB_HOME`      — ICO's pre-existing allowlist root (back-compat).
 *   3. `~/.teamkb`        — the shared default when neither is set.
 *
 * Empty / whitespace-only values are ignored (treated as unset) so an
 * accidentally-blank export does not silently redirect every path to the
 * filesystem root.
 */
export function getTeamKbBasePath(): string {
  const basePath = process.env['TEAMKB_BASE_PATH'];
  if (typeof basePath === 'string' && basePath.trim() !== '') {
    return basePath.trim();
  }
  const teamKbHome = process.env['TEAMKB_HOME'];
  if (typeof teamKbHome === 'string' && teamKbHome.trim() !== '') {
    return teamKbHome.trim();
  }
  return DEFAULT_TEAMKB_BASE;
}

/** Resolve a subdirectory under the TeamKB base path */
export function resolveTeamKbPath(subdir: string): string {
  return join(getTeamKbBasePath(), subdir);
}
