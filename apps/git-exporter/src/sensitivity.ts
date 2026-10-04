import { Sensitivity } from '@qmd-team-intent-kb/schema';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import { isExportableAudience } from '@qmd-team-intent-kb/common';

/** Sensitivity threshold: memories at or above 'confidential' are never exported. */
const CONFIDENTIAL_INDEX = Sensitivity.options.indexOf('confidential');

/** True when a memory's sensitivity forbids writing it to the export tree. */
function isSensitivityRestricted(level: string): boolean {
  const idx = Sensitivity.options.indexOf(level as (typeof Sensitivity.options)[number]);
  return idx >= CONFIDENTIAL_INDEX;
}

/**
 * True when a memory must not sit in the export tree at all: its sensitivity is
 * confidential/restricted, OR its claim-level audience is narrower than the
 * whole tenant (K2).
 *
 * The export tree feeds ONE shared search index per tenant, read by every
 * caller in that tenant. A memory meant only for `admins` or the `owner` would
 * be readable by members the moment it landed there, so only tenant-wide
 * memories are exported. Narrower memories stay in the store (reachable through
 * the API read paths, which filter per caller) until per-audience indexes exist.
 */
export function isExportRestricted(
  memory: Pick<CuratedMemory, 'sensitivity' | 'metadata'>,
): boolean {
  return (
    isSensitivityRestricted(memory.sensitivity) || !isExportableAudience(memory.metadata?.audience)
  );
}
