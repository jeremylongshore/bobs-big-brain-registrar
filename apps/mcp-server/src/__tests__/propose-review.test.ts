import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createDatabase,
} from '@qmd-team-intent-kb/store';
import {
  Curator,
  candidateSnapshotDigest,
  governSelectedCandidates,
  ingestFromSpool,
} from '@qmd-team-intent-kb/curator';
import { makePolicy } from '@qmd-team-intent-kb/test-fixtures';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type { McpServerConfig } from '../config.js';
import { propose } from '../tools/propose.js';

describe('Registrar MCP proposals require explicit review before admission', () => {
  let root: string;
  let db: ReturnType<typeof createDatabase>;
  let candidates: CandidateRepository;
  let memories: MemoryRepository;
  let audit: AuditRepository;
  let policies: PolicyRepository;
  let config: McpServerConfig;
  const tenantId = 'mcp-review-fixture';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'registrar-mcp-review-'));
    db = createDatabase({ path: join(root, 'fixture.db') });
    candidates = new CandidateRepository(db);
    memories = new MemoryRepository(db);
    audit = new AuditRepository(db);
    policies = new PolicyRepository(db);
    config = {
      tenantId,
      basePath: root,
      spoolPath: join(root, 'spool'),
      dbPath: join(root, 'fixture.db'),
      feedbackPath: join(root, 'feedback'),
      role: 'admin',
    };
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const curator = () =>
    new Curator(
      { candidateRepo: candidates, memoryRepo: memories, auditRepo: audit, policyRepo: policies },
      { tenantId },
    );

  async function capture(): Promise<MemoryCandidate> {
    // Unknown caller fields must not upgrade the server's capture envelope.
    const hostileInput = {
      title: 'Discovery proposal',
      content: 'Use the documented fixture retry procedure for transient request failures.',
      source: 'manual',
      trustLevel: 'high',
      status: 'promoted',
      author: { type: 'human', id: 'owner' },
      tenantId: 'another-tenant',
      metadata: { proposedByRole: 'admin', reviewRequired: false },
    };
    const result = await propose(hostileInput, config);
    const ingested = await ingestFromSpool(candidates, config.spoolPath);
    expect(ingested.ok).toBe(true);
    const row = candidates.findById(result.candidateId)!;
    expect(row).toMatchObject({
      source: 'mcp',
      trustLevel: 'medium',
      status: 'inbox',
      author: { type: 'ai', id: 'mcp-server' },
      tenantId,
      metadata: { filePaths: [], tags: [] },
    });
    expect(row.metadata).not.toHaveProperty('proposedByRole');
    expect(row.metadata).not.toHaveProperty('reviewRequired');
    return row;
  }

  for (const policyMode of ['absent', 'disabled', 'permissive', 'default-trust'] as const) {
    it(`blocks direct and batch automatic admission with ${policyMode} policy`, async () => {
      if (policyMode !== 'absent') {
        policies.insert(
          makePolicy({
            tenantId,
            enabled: policyMode !== 'disabled',
            ...(policyMode === 'default-trust'
              ? {
                  rules: [
                    {
                      id: 'fixture-default-trust',
                      type: 'source_trust',
                      action: 'flag',
                      enabled: true,
                      priority: 0,
                      parameters: {},
                    },
                  ],
                }
              : {}),
          }),
        );
      }
      const row = await capture();
      const receipts = audit.findByMemoryAndTenant(row.id, tenantId);
      for (let n = 0; n < 2; n++) {
        const result = curator().processSingle(row);
        expect(result.outcome).toBe('flagged');
        expect(result.pipelineResult?.flaggedBy).toContain('registrar_mcp_review_required');
        expect(curator().processBatch([row])).toMatchObject({ promoted: 0, flagged: 1 });
      }
      expect(memories.existsForCandidate(row.id, tenantId)).toBe(false);
      expect(candidates.findById(row.id)).toEqual(row);
      expect(audit.findByMemoryAndTenant(row.id, tenantId)).toEqual(receipts);
    });
  }

  it('cannot bypass review through finite selected governance', async () => {
    policies.insert(makePolicy({ tenantId }));
    const row = await capture();
    const input = {
      runId: randomUUID(),
      tenantId,
      selections: [{ candidateId: row.id, snapshotDigest: candidateSnapshotDigest(row) }],
      actor: { type: 'human' as const, id: 'fixture-operator' },
      role: 'owner' as const,
      reason: 'Synthetic finite automatic-governance attempt.',
    };
    const result = governSelectedCandidates(input, db);
    expect(result.outcomes).toEqual([{ candidateId: row.id, outcome: 'quarantined' }]);
    expect(memories.existsForCandidate(row.id, tenantId)).toBe(false);
    expect(candidates.findById(row.id)?.status).toBe('quarantined');
    const receipts = audit.findByMemoryAndTenant(input.runId, tenantId);
    expect(receipts).toEqual([
      expect.objectContaining({
        id: result.auditEventId,
        action: 'governed',
        actor: input.actor,
        details: expect.objectContaining({
          kind: 'selected-govern-v1',
          outcomes: [{ candidateId: row.id, outcome: 'quarantined' }],
        }),
      }),
    ]);
    expect(governSelectedCandidates(input, db)).toMatchObject({
      alreadySettled: true,
      outcomes: [{ candidateId: row.id, outcome: 'quarantined' }],
    });
    expect(audit.findByMemoryAndTenant(input.runId, tenantId)).toEqual(receipts);
  });

  it('admits a human-authored MCP envelope outside the fixed AI proposal classification', async () => {
    const row = await capture();
    const operatorCandidate = {
      ...row,
      id: randomUUID(),
      author: { type: 'human' as const, id: 'fixture-operator' },
    };
    const result = curator().processSingle(operatorCandidate);
    expect(result.outcome).toBe('promoted');
  });
});
