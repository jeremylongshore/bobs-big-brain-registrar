import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { candidateSnapshotDigest, governSelectedCandidates } from '@qmd-team-intent-kb/curator';
import type { Sensitivity } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createTestDatabase,
} from '@qmd-team-intent-kb/store';
import { buildApp } from '../app.js';
import { injectJson } from './assertions.js';
import { makeCandidate, makePolicy } from './fixtures.js';

let db: ReturnType<typeof createTestDatabase>;
let app: FastifyInstance;

beforeEach(async () => {
  db = createTestDatabase();
  app = buildApp({ db });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

function quarantinedCandidate(minimumSensitivity: Sensitivity): string {
  const candidate = makeCandidate({
    metadata: { filePaths: [], tags: [], proposedByRole: 'member' },
  });
  new CandidateRepository(db).insert(candidate, computeContentHash(candidate.content));
  new PolicyRepository(db).insert(
    makePolicy({
      rules: [
        {
          id: 'sensitivity-review',
          type: 'sensitivity_gate',
          enabled: true,
          priority: 0,
          action: 'reject',
          parameters: {},
        },
      ],
    }),
  );
  const result = governSelectedCandidates(
    {
      runId: randomUUID(),
      tenantId: candidate.tenantId,
      selections: [
        {
          candidateId: candidate.id,
          snapshotDigest: candidateSnapshotDigest(candidate),
          minimumSensitivity,
        },
      ],
      actor: { type: 'human', id: 'fixture-owner' },
      role: 'owner',
      reason: 'Preserve the source privacy bound.',
    },
    db,
  );
  expect(result.outcomes[0]!.outcome).toBe('quarantined');
  return candidate.id;
}

describe('API review of a recovery constraint', () => {
  it('keeps the durable floor when an admin reviews a member proposal later', async () => {
    const id = quarantinedCandidate('internal');
    const response = await injectJson<{ id: string; sensitivity: string }>(
      app,
      'POST',
      `/api/candidates/${id}/promote?tenantId=team-alpha`,
      {},
    );
    expect(response.status).toBe(200);
    expect(response.body.sensitivity).toBe('internal');
    const receipt = new AuditRepository(db)
      .findByMemoryAndTenant(response.body.id, 'team-alpha')
      .find((event) => event.action === 'promoted')!;
    expect(receipt.details['sensitivityConstraint']).toEqual({
      classified: 'public',
      minimum: 'internal',
      effective: 'internal',
    });
  });

  it('still refuses a later API approval when the floor is blocked by policy', async () => {
    const id = quarantinedCandidate('confidential');
    const response = await injectJson(
      app,
      'POST',
      `/api/candidates/${id}/promote?tenantId=team-alpha`,
      {},
    );
    expect(response.status).toBe(422);
    expect(new MemoryRepository(db).findByTenant('team-alpha')).toEqual([]);
    expect(new CandidateRepository(db).findById(id)!.status).toBe('quarantined');
  });
});
