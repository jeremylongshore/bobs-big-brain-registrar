import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveAuditEventId, deriveCandidateId, deriveMemoryId } from '@qmd-team-intent-kb/common';
import type { AuditEvent } from '@qmd-team-intent-kb/schema';
import { makeCuratedMemory, NOW, TENANT } from './fixtures.js';
import {
  planContradictions,
  type ContradictionEndpoint,
  type ContradictionPlannerInput,
  type ContradictionRefusalCode,
} from '../contradictions/contradiction-planner.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const workspaceId = 'private-fixture-workspace';
const compilationId = 'contradiction-01';
const pageSha256 = sha('The reviewed fixture identifies incompatible retention settings.');

function endpoint(sourceId: string, content: string): ContradictionEndpoint {
  const relativePath = `wiki/sources/${sourceId}.md`;
  const contentHash = sha(content);
  const candidateId = deriveCandidateId(workspaceId, relativePath, contentHash);
  const id = deriveMemoryId(candidateId, contentHash);
  const memory = makeCuratedMemory({ id, candidateId, content, contentHash });
  const promotion: AuditEvent = {
    id: deriveAuditEventId(id, 'promoted'),
    action: 'promoted',
    memoryId: id,
    tenantId: memory.tenantId,
    actor: memory.promotedBy,
    details: { candidateId },
    timestamp: NOW,
  };
  return {
    workspaceId,
    sourceId,
    emission: { relativePath, bodySha256: contentHash, candidateId },
    memory,
    promotion,
  };
}

function fixture() {
  return {
    tenantId: TENANT,
    lineages: [
      {
        workspaceId,
        compilationId,
        pagePath: 'wiki/contradictions/retention.md',
        pageSha256,
        sourceIds: ['source-a', 'source-b'],
        evidenceRef: 'fixture:verified-compiler-snapshot/contradiction-01',
      },
    ],
    endpoints: [
      endpoint('source-a', 'Delete production logs after seven days.'),
      endpoint('source-b', 'Retain production logs for at least thirty days.'),
    ],
    advisories: [
      {
        workspaceId,
        compilationId,
        pageSha256,
        sourcePair: ['source-a', 'source-b'] as [string, string],
      },
    ],
    existingPairs: [] as ContradictionPlannerInput['existingPairs'],
  };
}

function refused(input: unknown, code: ContradictionRefusalCode): void {
  const plan = planContradictions(input);
  expect(plan.proposals).toEqual([]);
  expect(plan.refusals.map((row) => row.code)).toEqual([code]);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const item of Object.values(value)) deepFreeze(item);
  Object.freeze(value);
}

describe('read-only contradiction candidate planner', () => {
  it('proposes the explicit reviewed fixture pair with auditable compile and promotion identities', () => {
    const input = fixture();
    const plan = planContradictions(input);
    expect(plan.mode).toBe('dry-run');
    expect(plan.refusals).toEqual([]);
    expect(plan.proposals).toEqual([
      {
        status: 'needs-review',
        linkType: 'contradicts',
        tenantId: TENANT,
        sourceMemoryId: input.endpoints[0]!.memory.id,
        targetMemoryId: input.endpoints[1]!.memory.id,
        evidence: {
          lineage: input.lineages[0],
          sourcePair: ['source-a', 'source-b'],
          endpoints: input.endpoints.map((row) => ({
            sourceId: row.sourceId,
            emission: row.emission,
            memoryId: row.memory.id,
            memoryVersion: row.memory.version,
            contentHash: row.memory.contentHash,
            promotionEventId: row.promotion.id,
          })),
        },
      },
    ]);
  });

  it.each([null, {}, [], { ...fixture(), lineages: null }, { ...fixture(), endpoints: {} }])(
    'refuses malformed snapshot input %#',
    (input) => refused(input, 'malformed-input'),
  );

  it.each(['', '../escape.md', '/absolute.md', 'wiki//page.md', 'wiki\\page.md'])(
    'refuses malformed lineage page paths %s without filesystem interpretation',
    (pagePath) => {
      const input = fixture();
      input.lineages[0]!.pagePath = pagePath;
      refused(input, 'malformed-input');
    },
  );

  it('refuses a malformed lineage SHA and duplicate accepted source identities', () => {
    const input = fixture();
    input.lineages[0]!.pageSha256 = 'not-a-sha256';
    refused(input, 'malformed-input');
    input.lineages[0]!.pageSha256 = pageSha256;
    input.lineages[0]!.sourceIds.push('source-a');
    refused(input, 'malformed-input');
  });

  it('keeps emitted-body identity distinct from legitimately edited current curated content', () => {
    const input = fixture();
    const row = input.endpoints[0]!;
    const originalEmission = structuredClone(row.emission);
    row.memory.content = 'The production log deletion window is seven days.';
    row.memory.contentHash = sha(row.memory.content);
    row.memory.version = 2;
    const plan = planContradictions(input);
    expect(plan.refusals).toEqual([]);
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]!.evidence.endpoints[0]).toMatchObject({
      emission: originalEmission,
      contentHash: row.memory.contentHash,
      memoryVersion: 2,
      promotionEventId: row.promotion.id,
    });
    expect(row.emission.bodySha256).not.toBe(row.memory.contentHash);
  });

  it('refuses advisory-only lineage and legacy empty attribution', () => {
    const input = fixture();
    input.lineages = [];
    refused(input, 'missing-lineage');
    input.lineages = fixture().lineages;
    input.lineages[0]!.sourceIds = [];
    refused(input, 'source-not-attributed');
  });

  it('refuses duplicate or contradictory lineage rows instead of picking the first', () => {
    const input = fixture();
    input.lineages.push({ ...input.lineages[0]!, pageSha256: sha('different page') });
    refused(input, 'ambiguous-lineage');
  });

  it('binds advisory compilation and page hash to the caller-verified workspace snapshot', () => {
    const input = fixture();
    input.advisories[0]!.pageSha256 = sha('stale page');
    refused(input, 'lineage-mismatch');
    input.advisories[0] = { ...fixture().advisories[0]!, workspaceId: 'other-workspace' };
    refused(input, 'missing-lineage');
  });

  it('refuses raw source IDs that did not survive deterministic compiler attribution', () => {
    const input = fixture();
    input.lineages[0]!.sourceIds = ['source-a', 'another-source'];
    refused(input, 'source-not-attributed');
  });

  it('requires an explicit endpoint mapping even when a source ID resembles a memory ID', () => {
    const input = fixture();
    input.endpoints.pop();
    refused(input, 'missing-endpoint');
  });

  it('refuses a relative-path/source-ID collision from another workspace', () => {
    const input = fixture();
    input.endpoints[1]!.workspaceId = 'another-workspace';
    refused(input, 'workspace-collision');
  });

  it('uses the exact workspace when the same source ID exists in another workspace', () => {
    const input = fixture();
    input.endpoints.push({ ...input.endpoints[1]!, workspaceId: 'another-workspace' });
    expect(planContradictions(input).proposals).toHaveLength(1);
  });

  it('refuses multiple promoted endpoint choices, including duplicate mapping rows', () => {
    const input = fixture();
    input.endpoints.push(structuredClone(input.endpoints[0]!));
    refused(input, 'ambiguous-endpoint');
  });

  it.each([
    'candidate',
    'body',
    'path',
    'memoryCandidate',
    'content',
    'promotionCandidate',
    'promotionMemory',
    'promotionAction',
    'promotionTenant',
  ])('checks actual mapping consistency: %s', (change) => {
    const input = fixture();
    const row = input.endpoints[0]!;
    if (change === 'candidate') row.emission.candidateId = input.endpoints[1]!.emission.candidateId;
    if (change === 'body') row.emission.bodySha256 = sha('different emission body');
    if (change === 'path') row.emission.relativePath = 'wiki/sources/different.md';
    if (change === 'memoryCandidate')
      row.memory.candidateId = input.endpoints[1]!.emission.candidateId;
    if (change === 'content') row.memory.content = 'Content changed without a matching hash.';
    if (change === 'promotionCandidate')
      row.promotion.details.candidateId = input.endpoints[1]!.emission.candidateId;
    if (change === 'promotionMemory') row.promotion.memoryId = input.endpoints[1]!.memory.id;
    if (change === 'promotionAction') row.promotion.action = 'archived';
    if (change === 'promotionTenant') row.promotion.tenantId = 'other-tenant';
    refused(input, 'endpoint-mismatch');
  });

  it('uses canonical schemas to refuse malformed promoted memories and audit events', () => {
    const input = fixture();
    refused(
      { ...input, endpoints: [{ ...input.endpoints[0], memory: { id: 'bad' } }] },
      'malformed-input',
    );
    refused({ ...input, endpoints: [{ ...input.endpoints[0], promotion: {} }] }, 'malformed-input');
  });

  it('refuses cross-tenant endpoints with otherwise consistent promotion lineage', () => {
    const input = fixture();
    input.endpoints[1]!.memory.tenantId = 'other-tenant';
    input.endpoints[1]!.promotion.tenantId = 'other-tenant';
    refused(input, 'cross-tenant');
  });

  it.each(['deprecated', 'archived'] as const)('refuses %s endpoints', (lifecycle) => {
    const input = fixture();
    input.endpoints[1]!.memory.lifecycle = lifecycle;
    refused(input, 'inactive-endpoint');
  });

  it('refuses an otherwise valid superseded endpoint', () => {
    const input = fixture();
    const row = input.endpoints[1]!;
    row.memory.lifecycle = 'superseded';
    row.memory.supersession = {
      supersededBy: input.endpoints[0]!.memory.id,
      reason: 'fixture',
      linkedAt: NOW,
    };
    refused(input, 'inactive-endpoint');
  });

  it('refuses a repeated source as a self-link', () => {
    const input = fixture();
    input.advisories[0]!.sourcePair = ['source-a', 'source-a'];
    refused(input, 'self-link');
  });

  it('refuses different source mappings ending at the same curated memory', () => {
    const input = fixture();
    input.endpoints[1] = { ...structuredClone(input.endpoints[0]!), sourceId: 'source-b' };
    refused(input, 'self-link');
  });

  it('refuses exact restatement text despite different candidate and promotion IDs', () => {
    const input = fixture();
    input.endpoints[1] = endpoint('source-b', input.endpoints[0]!.memory.content);
    refused(input, 'exact-restatement');
  });

  it('deduplicates reversed pairs against both existing links and earlier proposals', () => {
    const input = fixture();
    input.advisories.push({ ...input.advisories[0]!, sourcePair: ['source-b', 'source-a'] });
    const plan = planContradictions(input);
    expect(plan.proposals).toHaveLength(1);
    expect(plan.refusals).toEqual([{ advisoryIndex: 1, code: 'duplicate-pair' }]);
    input.advisories.pop();
    input.existingPairs = [
      {
        sourceMemoryId: input.endpoints[1]!.memory.id,
        targetMemoryId: input.endpoints[0]!.memory.id,
      },
    ];
    refused(input, 'duplicate-pair');
  });

  it('treats UUID case variants as the same endpoint for self and duplicate checks', () => {
    const input = fixture();
    input.existingPairs = [
      {
        sourceMemoryId: input.endpoints[0]!.memory.id.toUpperCase(),
        targetMemoryId: input.endpoints[1]!.memory.id.toUpperCase(),
      },
    ];
    refused(input, 'duplicate-pair');
    input.existingPairs = [];
    input.endpoints[1] = { ...structuredClone(input.endpoints[0]!), sourceId: 'source-b' };
    input.endpoints[1]!.memory.id = input.endpoints[1]!.memory.id.toUpperCase();
    refused(input, 'self-link');
  });

  it('does not expand a three-source page into a clique; only the explicit pair is proposed', () => {
    const input = fixture();
    input.lineages[0]!.sourceIds.push('source-c');
    input.endpoints.push(endpoint('source-c', 'A third unrelated retention convention.'));
    const plan = planContradictions(input);
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]!.evidence.sourcePair).toEqual(['source-a', 'source-b']);
    refused(
      {
        ...input,
        advisories: [{ ...input.advisories[0], sourcePair: ['source-a', 'source-b', 'source-c'] }],
      },
      'malformed-input',
    );
    refused(
      { ...input, advisories: [{ workspaceId, compilationId, pageSha256 }] },
      'malformed-input',
    );
  });

  it('keeps independent valid proposals when another advisory lacks verified lineage', () => {
    const input = fixture();
    input.advisories.push({ ...input.advisories[0]!, compilationId: 'unverified-page' });
    const plan = planContradictions(input);
    expect(plan.proposals).toHaveLength(1);
    expect(plan.refusals).toEqual([{ advisoryIndex: 1, code: 'missing-lineage' }]);
  });

  it('accepts frozen snapshots, returns detached evidence and is repeatably non-destructive', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    deepFreeze(input);
    const first = planContradictions(input);
    expect(planContradictions(input)).toEqual(first);
    first.proposals[0]!.evidence.lineage.sourceIds = ['altered output only'];
    first.proposals[0]!.evidence.endpoints[0]!.emission.relativePath = 'altered-output.md';
    expect(JSON.stringify(input)).toBe(before);
    expect(planContradictions(input).proposals[0]!.evidence.lineage.sourceIds).toEqual([
      'source-a',
      'source-b',
    ]);
  });
});
