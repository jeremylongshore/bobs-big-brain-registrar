import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import { getRelativePath } from '../formatter/directory-mapper.js';
import { isSensitivityRestricted } from '../sensitivity.js';
import type { RemovalBlocked } from '../types.js';

/** Every directory the exporter ever places a memory file in. */
const EXPORT_DIRS = ['decisions', 'curated', 'guides', 'archive', 'bulk'] as const;

/** Exported files are named `<memory-uuid>.md`; anything else is not ours. */
const MEMORY_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;

/** `tenant_id: "x"` out of the YAML frontmatter block, or null if unattributable. */
function readFileTenant(filePath: string): string | null {
  try {
    const text = readFileSync(filePath, 'utf8');
    if (!text.startsWith('---')) return null;
    const end = text.indexOf('\n---', 3);
    if (end === -1) return null;
    const m = /^tenant_id:\s*"([^"\n]*)"\s*$/m.exec(text.slice(0, end));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface StaleScan {
  toRemove: string[];
  removalBlocked?: RemovalBlocked;
}

/**
 * Find export files that no longer correspond to the DB (reconcile mode).
 *
 * A `<uuid>.md` file under a known export directory is STALE when:
 *   - its memory exists but belongs at a different path (lifecycle moved it to
 *     archive/, recategorized, bulk routing) — a leftover copy in the old place;
 *   - its memory is now sensitivity-restricted (must not sit on disk at all);
 *   - its id is not in the DB at all (an ORPHAN) AND the file's own frontmatter
 *     tenant matches `tenantId` (or no tenant filter is configured).
 *
 * Never touched: files that are not `<uuid>.md`, files whose tenant is missing
 * or different from the configured one (other tenants share a tree; an
 * unattributable file is never deleted), and ids the exporter quarantined
 * (their last good copy stays until the operator fixes them at source).
 *
 * Orphan removals are capped by `maxOrphanRemovals`: an empty or wrong DB would
 * otherwise "reconcile" a healthy tree to nothing. Over the cap, NO orphan is
 * removed and the block is reported; relocation/restricted removals are safe
 * (the memory exists) and always proceed.
 */
export function findStaleFiles(
  outputDir: string,
  memories: readonly CuratedMemory[],
  quarantinedIds: ReadonlySet<string>,
  tenantId: string | undefined,
  maxOrphanRemovals: number,
): StaleScan {
  // id -> relative path it belongs at; null = must not be on disk (restricted).
  const desired = new Map<string, string | null>();
  for (const m of memories) {
    if (quarantinedIds.has(m.id)) continue;
    if (isSensitivityRestricted(m.sensitivity)) {
      desired.set(m.id, null);
      continue;
    }
    try {
      desired.set(m.id, getRelativePath(m));
    } catch {
      // unmappable category: the detector quarantines it; leave its file alone.
    }
  }
  const known = new Set(memories.map((m) => m.id));

  const relocated: string[] = [];
  const orphans: string[] = [];

  for (const dir of EXPORT_DIRS) {
    const absDir = join(outputDir, dir);
    if (!existsSync(absDir)) continue;
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const m = MEMORY_FILE.exec(name);
      if (m === null) continue;
      const id = m[1]!.toLowerCase();
      if (quarantinedIds.has(id)) continue;
      const rel = `${dir}/${name}`;
      const abs = join(absDir, name);

      if (known.has(id)) {
        if (!desired.has(id)) continue; // unmappable: leave alone
        const want = desired.get(id);
        if (want === undefined || want !== rel) relocated.push(abs);
        continue;
      }
      // Orphan: only ours if the file itself says it belongs to this tenant.
      if (tenantId !== undefined && readFileTenant(abs) !== tenantId) continue;
      orphans.push(abs);
    }
  }

  if (orphans.length > maxOrphanRemovals) {
    return {
      toRemove: relocated,
      removalBlocked: { orphans: orphans.length, limit: maxOrphanRemovals },
    };
  }
  return { toRemove: [...relocated, ...orphans] };
}
