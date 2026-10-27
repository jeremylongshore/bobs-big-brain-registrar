import { isAudienceVisibleToRole, isSearchVisibleSensitivity } from '@qmd-team-intent-kb/common';
import { Uuid } from '@qmd-team-intent-kb/schema';
import type { ContradictionReferences, CuratedMemory } from '@qmd-team-intent-kb/schema';
import type Database from 'better-sqlite3';
import { MemoryRepository } from './repositories/memory-repository.js';
import { MemoryLinksRepository } from './repositories/memory-links-repository.js';
import type { GraphReadScope } from './repositories/memory-links-repository.js';

/** Caller authenticates and supplies trusted read scope. This reader performs no writes. */
export function readContradictionReferences(
  db: Database.Database,
  memoryId: string,
  scope: GraphReadScope,
): ContradictionReferences {
  try {
    Uuid.parse(memoryId);
    if (!['member', 'admin', 'owner'].includes(scope.readerRole)) return { status: 'unavailable' };
    return db
      .transaction((): ContradictionReferences => {
        const memories = new MemoryRepository(db);
        const visible = (memory: CuratedMemory | null): memory is CuratedMemory =>
          memory !== null &&
          memory.lifecycle === 'active' &&
          (scope.tenantId === undefined || memory.tenantId === scope.tenantId) &&
          (scope.allowedTenantIds === undefined ||
            scope.allowedTenantIds.includes(memory.tenantId)) &&
          isAudienceVisibleToRole(memory.metadata.audience, scope.readerRole) &&
          isSearchVisibleSensitivity(memory.sensitivity);
        const primary = memories.findById(memoryId);
        if (!visible(primary)) return { status: 'unavailable' };
        // Even an unscoped administrator never gets a cross-tenant relationship.
        const neighbors = new MemoryLinksRepository(db).neighbors(memoryId, {
          ...scope,
          tenantId: primary.tenantId,
        });
        const seen = new Set([memoryId.toLowerCase()]);
        const references: { memoryId: string; title: string }[] = [];
        for (const neighbor of neighbors) {
          if (neighbor.linkType !== 'contradicts' || seen.has(neighbor.memoryId.toLowerCase()))
            continue;
          seen.add(neighbor.memoryId.toLowerCase());
          const memory = memories.findById(neighbor.memoryId);
          if (visible(memory) && memory.tenantId === primary.tenantId)
            references.push({ memoryId: memory.id, title: memory.title });
        }
        references.sort((a, b) => (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0));
        return { status: 'available', references };
      })
      .deferred();
  } catch {
    // Corrupt/missing graph or endpoint evidence must not look like a measured zero.
    return { status: 'unavailable' };
  }
}
