import { computeContentHash, deriveCandidateId } from '@qmd-team-intent-kb/common';
import { AuditEvent, CuratedMemory } from '@qmd-team-intent-kb/schema';

/** Caller-verified compiler snapshot; evidenceRef locates evidence, not a new receipt format. */
export interface CompilationLineage {
  workspaceId: string;
  compilationId: string;
  pagePath: string;
  pageSha256: string;
  sourceIds: readonly string[];
  evidenceRef: string;
}

/** Explicit mapping from an attributed raw source to an emitted and promoted page. */
export interface ContradictionEndpoint {
  workspaceId: string;
  sourceId: string;
  emission: { relativePath: string; bodySha256: string; candidateId: string };
  memory: CuratedMemory;
  promotion: AuditEvent;
}

export interface ContradictionAdvisory {
  workspaceId: string;
  compilationId: string;
  pageSha256: string;
  /** Exactly two selected raw source IDs. No expansion of an N-source advisory. */
  sourcePair: readonly [string, string];
}

export interface ContradictionPlannerInput {
  tenantId: string;
  lineages: readonly CompilationLineage[];
  endpoints: readonly ContradictionEndpoint[];
  advisories: readonly ContradictionAdvisory[];
  existingPairs: readonly { sourceMemoryId: string; targetMemoryId: string }[];
}

export type ContradictionRefusalCode =
  | 'malformed-input'
  | 'missing-lineage'
  | 'ambiguous-lineage'
  | 'lineage-mismatch'
  | 'source-not-attributed'
  | 'missing-endpoint'
  | 'workspace-collision'
  | 'ambiguous-endpoint'
  | 'endpoint-mismatch'
  | 'cross-tenant'
  | 'inactive-endpoint'
  | 'self-link'
  | 'exact-restatement'
  | 'duplicate-pair';

export interface ContradictionProposal {
  status: 'needs-review';
  linkType: 'contradicts';
  tenantId: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  evidence: {
    lineage: CompilationLineage;
    sourcePair: readonly [string, string];
    endpoints: readonly {
      sourceId: string;
      emission: ContradictionEndpoint['emission'];
      memoryId: string;
      memoryVersion: number;
      contentHash: string;
      promotionEventId: string;
    }[];
  };
}

export interface ContradictionPlan {
  mode: 'dry-run';
  proposals: ContradictionProposal[];
  /** null index denotes malformed batch input; otherwise the input advisory index. */
  refusals: { advisoryIndex: number | null; code: ContradictionRefusalCode }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function relativePath(value: unknown): value is string {
  return (
    text(value) &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.includes(':') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
function lineage(value: unknown): value is CompilationLineage {
  return (
    record(value) &&
    text(value.workspaceId) &&
    text(value.compilationId) &&
    relativePath(value.pagePath) &&
    hash(value.pageSha256) &&
    text(value.evidenceRef) &&
    Array.isArray(value.sourceIds) &&
    value.sourceIds.every(text) &&
    new Set(value.sourceIds).size === value.sourceIds.length
  );
}
function advisory(value: unknown): value is ContradictionAdvisory {
  return (
    record(value) &&
    text(value.workspaceId) &&
    text(value.compilationId) &&
    hash(value.pageSha256) &&
    Array.isArray(value.sourcePair) &&
    value.sourcePair.length === 2 &&
    value.sourcePair.every(text)
  );
}
function endpoint(value: unknown): value is ContradictionEndpoint {
  return (
    record(value) &&
    text(value.workspaceId) &&
    text(value.sourceId) &&
    record(value.emission) &&
    relativePath(value.emission.relativePath) &&
    hash(value.emission.bodySha256) &&
    text(value.emission.candidateId) &&
    CuratedMemory.safeParse(value.memory).success &&
    AuditEvent.safeParse(value.promotion).success
  );
}
function inputShape(value: unknown): value is ContradictionPlannerInput {
  return (
    record(value) &&
    text(value.tenantId) &&
    Array.isArray(value.lineages) &&
    value.lineages.every(lineage) &&
    Array.isArray(value.endpoints) &&
    value.endpoints.every(endpoint) &&
    Array.isArray(value.advisories) &&
    value.advisories.every(advisory) &&
    Array.isArray(value.existingPairs) &&
    value.existingPairs.every(
      (pair: unknown) => record(pair) && text(pair.sourceMemoryId) && text(pair.targetMemoryId),
    )
  );
}
function pairKey(a: string, b: string): string {
  return JSON.stringify([a.toLowerCase(), b.toLowerCase()].sort());
}
function endpointConsistent(value: ContradictionEndpoint): boolean {
  const { emission, memory, promotion } = value;
  return (
    deriveCandidateId(value.workspaceId, emission.relativePath, emission.bodySha256) ===
      emission.candidateId &&
    memory.candidateId === emission.candidateId &&
    computeContentHash(memory.content) === memory.contentHash &&
    promotion.action === 'promoted' &&
    promotion.memoryId.toLowerCase() === memory.id.toLowerCase() &&
    promotion.tenantId === memory.tenantId &&
    promotion.details.candidateId === emission.candidateId
  );
}

/**
 * Pure planner over an independently verified snapshot. This checks identity and
 * hash consistency, not receipt authenticity, chain integrity, freshness or truth.
 * No repository, filesystem, network, clock or callback capability is accepted.
 */
export function planContradictions(input: unknown): ContradictionPlan {
  const result: ContradictionPlan = { mode: 'dry-run', proposals: [], refusals: [] };
  if (!inputShape(input)) {
    result.refusals.push({ advisoryIndex: null, code: 'malformed-input' });
    return result;
  }
  const endpoints = input.endpoints.map((row) => ({
    ...row,
    memory: CuratedMemory.parse(row.memory),
    promotion: AuditEvent.parse(row.promotion),
  }));
  const seen = new Set(
    input.existingPairs.map((pair) => pairKey(pair.sourceMemoryId, pair.targetMemoryId)),
  );
  input.advisories.forEach((item, advisoryIndex) => {
    const refuse = (code: ContradictionRefusalCode): void => {
      result.refusals.push({ advisoryIndex, code });
    };
    const matches = input.lineages.filter(
      (row) => row.workspaceId === item.workspaceId && row.compilationId === item.compilationId,
    );
    if (matches.length !== 1) {
      refuse(matches.length === 0 ? 'missing-lineage' : 'ambiguous-lineage');
      return;
    }
    const sourceLineage = matches[0]!;
    if (sourceLineage.pageSha256 !== item.pageSha256) {
      refuse('lineage-mismatch');
      return;
    }
    if (item.sourcePair.some((id) => !sourceLineage.sourceIds.includes(id))) {
      refuse('source-not-attributed');
      return;
    }
    const selected: ContradictionEndpoint[] = [];
    for (const sourceId of item.sourcePair) {
      const candidates = endpoints.filter(
        (row) => row.workspaceId === item.workspaceId && row.sourceId === sourceId,
      );
      if (candidates.length !== 1) {
        const otherWorkspace = endpoints.some((row) => row.sourceId === sourceId);
        refuse(
          candidates.length > 1
            ? 'ambiguous-endpoint'
            : otherWorkspace
              ? 'workspace-collision'
              : 'missing-endpoint',
        );
        return;
      }
      const mapped = candidates[0]!;
      if (!endpointConsistent(mapped)) {
        refuse('endpoint-mismatch');
        return;
      }
      if (mapped.memory.tenantId !== input.tenantId) {
        refuse('cross-tenant');
        return;
      }
      if (mapped.memory.lifecycle !== 'active') {
        refuse('inactive-endpoint');
        return;
      }
      selected.push(mapped);
    }
    const [left, right] = selected;
    if (!left || !right) return;
    if (
      left.memory.id.toLowerCase() === right.memory.id.toLowerCase() ||
      left.sourceId === right.sourceId
    ) {
      refuse('self-link');
      return;
    }
    if (left.memory.content.trim() === right.memory.content.trim()) {
      refuse('exact-restatement');
      return;
    }
    const key = pairKey(left.memory.id, right.memory.id);
    if (seen.has(key)) {
      refuse('duplicate-pair');
      return;
    }
    seen.add(key);
    result.proposals.push({
      status: 'needs-review',
      linkType: 'contradicts',
      tenantId: input.tenantId,
      sourceMemoryId: left.memory.id,
      targetMemoryId: right.memory.id,
      evidence: {
        lineage: {
          workspaceId: sourceLineage.workspaceId,
          compilationId: sourceLineage.compilationId,
          pagePath: sourceLineage.pagePath,
          pageSha256: sourceLineage.pageSha256,
          sourceIds: [...sourceLineage.sourceIds],
          evidenceRef: sourceLineage.evidenceRef,
        },
        sourcePair: [...item.sourcePair],
        endpoints: selected.map((row) => ({
          sourceId: row.sourceId,
          emission: {
            relativePath: row.emission.relativePath,
            bodySha256: row.emission.bodySha256,
            candidateId: row.emission.candidateId,
          },
          memoryId: row.memory.id,
          memoryVersion: row.memory.version,
          contentHash: row.memory.contentHash,
          promotionEventId: row.promotion.id,
        })),
      },
    });
  });
  return result;
}
