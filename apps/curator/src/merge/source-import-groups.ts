import { isDeepStrictEqual } from 'node:util';
import {
  assertDisclosureClean,
  computeContentHash,
  deriveMemoryId,
} from '@qmd-team-intent-kb/common';
import { effectiveSensitivity } from '@qmd-team-intent-kb/policy-engine';
import { CandidateRepository } from '@qmd-team-intent-kb/store';
import { CuratedMemory, MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type { Sensitivity } from '@qmd-team-intent-kb/schema';
import { resolveCandidateMinimumSensitivity } from '../recovery/sensitivity-constraint.js';
import { SourceImportError } from './source-import-schema.js';
import type { SourceImportDependencies } from './source-import-schema.js';
import type { SignedSourceSnapshot } from './source-snapshot-schema.js';

export interface SourceImportGroup {
  contentHash: string;
  incoming: MemoryCandidate[];
  /** Includes destination aliases, so later review of any alias retains the floor. */
  candidates: MemoryCandidate[];
  existing: CuratedMemory[];
  minimumSensitivity: Sensitivity;
  sourceSnapshotDigests: string[];
}

export function importCandidate(memory: CuratedMemory, tenantId: string): MemoryCandidate {
  return MemoryCandidate.parse({
    id: memory.candidateId,
    source: memory.source,
    content: memory.content,
    title: memory.title,
    category: memory.category,
    author: memory.author,
    metadata: memory.metadata,
    tenantId,
    status: 'inbox',
    trustLevel: 'untrusted',
    capturedAt: memory.promotedAt,
    prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
  });
}

/** Governance outputs are re-derived; source content/provenance/audience must agree. */
function semanticIdentity(
  memory: Pick<CuratedMemory, 'source' | 'content' | 'title' | 'category' | 'author' | 'metadata'>,
): unknown {
  return {
    source: memory.source,
    content: memory.content,
    title: memory.title,
    category: memory.category,
    author: memory.author,
    metadata: memory.metadata,
  };
}

export function destinationRows(deps: SourceImportDependencies, tenantId: string): CuratedMemory[] {
  const rows = deps.memoryRepo.findByTenant(tenantId).map((row) => CuratedMemory.parse(row));
  for (const row of rows) {
    if (
      computeContentHash(row.content) !== row.contentHash ||
      deriveMemoryId(row.candidateId, row.contentHash) !== row.id
    ) {
      throw new SourceImportError('invalid-destination');
    }
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function prepareImportGroups(
  snapshots: SignedSourceSnapshot[],
  rows: CuratedMemory[],
  deps: SourceImportDependencies,
  tenantId: string,
): SourceImportGroup[] {
  const inbox = new CandidateRepository(deps.memoryRepo.connection);
  const groups = new Map<string, SourceImportGroup>();
  const semantics = new Map<string, unknown>();
  const candidateHashes = new Map<string, string>();
  for (const snapshot of snapshots) {
    for (const item of snapshot.payload.items) {
      const memory = item.memory;
      assertDisclosureClean(memory);
      const pending = inbox.findById(memory.candidateId);
      if (
        pending !== null &&
        (pending.status !== 'inbox' ||
          pending.tenantId !== tenantId ||
          !isDeepStrictEqual(semanticIdentity(pending), semanticIdentity(memory)))
      )
        throw new SourceImportError('conflicting-content');
      if (
        deps.memoryRepo.hasIdentityOutsideTenant(memory.id, tenantId) ||
        deps.memoryRepo.hasConflictingCandidateBinding(
          memory.candidateId,
          memory.contentHash,
          tenantId,
        )
      ) {
        throw new SourceImportError('conflicting-content');
      }
      const previousHash = candidateHashes.get(memory.candidateId);
      if (previousHash !== undefined && previousHash !== memory.contentHash)
        throw new SourceImportError('conflicting-content');
      candidateHashes.set(memory.candidateId, memory.contentHash);
      const semantic = semanticIdentity(memory);
      const previous = semantics.get(memory.contentHash);
      if (previous !== undefined && !isDeepStrictEqual(previous, semantic))
        throw new SourceImportError('conflicting-content');
      semantics.set(memory.contentHash, semantic);
      let group = groups.get(memory.contentHash);
      if (group === undefined) {
        group = {
          contentHash: memory.contentHash,
          incoming: [],
          candidates: [],
          existing: [],
          minimumSensitivity: item.minimumSensitivity,
          sourceSnapshotDigests: [],
        };
        groups.set(memory.contentHash, group);
      }
      group.minimumSensitivity = effectiveSensitivity(
        group.minimumSensitivity,
        item.minimumSensitivity,
      );
      group.sourceSnapshotDigests.push(snapshot.digest);
      if (!group.incoming.some((candidate) => candidate.id === memory.candidateId))
        group.incoming.push(importCandidate(memory, tenantId));
    }
  }
  for (const row of rows) {
    const group = groups.get(row.contentHash);
    if (group === undefined) continue;
    if (!isDeepStrictEqual(semantics.get(row.contentHash), semanticIdentity(row)))
      throw new SourceImportError('conflicting-content');
    group.existing.push(row);
    group.minimumSensitivity = effectiveSensitivity(group.minimumSensitivity, row.sensitivity);
  }
  for (const group of groups.values()) {
    const candidates = new Map<string, MemoryCandidate>();
    for (const candidate of [
      ...group.incoming,
      ...group.existing.map((row) => importCandidate(row, tenantId)),
    ]) {
      candidates.set(candidate.id, candidate);
      group.minimumSensitivity = effectiveSensitivity(
        group.minimumSensitivity,
        resolveCandidateMinimumSensitivity(candidate, deps.auditRepo),
      );
    }
    group.incoming.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    group.candidates = [...candidates.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    group.sourceSnapshotDigests = [...new Set(group.sourceSnapshotDigests)].sort();
  }
  return [...groups.values()].sort((a, b) => (a.incoming[0]!.id < b.incoming[0]!.id ? -1 : 1));
}
