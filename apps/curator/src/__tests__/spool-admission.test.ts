import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CandidateRepository,
  createTestDatabase,
  ImportBatchRepository,
} from '@qmd-team-intent-kb/store';

import { ingestFromSpoolDetailed } from '../intake/spool-intake.js';
import { makeCandidate } from './fixtures.js';

function jsonl(candidates: ReturnType<typeof makeCandidate>[]): string {
  return candidates.map((candidate) => JSON.stringify(candidate)).join('\n');
}

async function writeBulkSpool(
  spoolDir: string,
  candidates: ReturnType<typeof makeCandidate>[],
  receiptOverrides: Record<string, unknown> = {},
): Promise<void> {
  const spoolPath = join(spoolDir, 'spool-2026-08-02T170000Z.jsonl');
  const body = jsonl(candidates);
  await writeFile(spoolPath, body, 'utf8');
  await writeFile(
    `${spoolPath}.manifest.json`,
    JSON.stringify(
      {
        schemaVersion: '1',
        emittedCount: candidates.length,
        spoolFile: 'spool-2026-08-02T170000Z.jsonl',
        spoolFileBytes: Buffer.byteLength(body, 'utf8'),
        spoolFileSha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        candidateIds: candidates.map((candidate) => candidate.id),
        batchReceipt: { ...defaultReceipt(candidates), ...receiptOverrides },
      },
      null,
      2,
    ),
    'utf8',
  );
}

function defaultReceipt(candidates: ReturnType<typeof makeCandidate>[]): Record<string, unknown> {
  const first = candidates[0]!;
  return {
    batchId: 'bulk-batch-2026-08-02',
    tenantId: first.tenantId,
    scope: 'all',
    source: first.source,
    trustLevel: first.trustLevel,
    candidateCount: candidates.length,
    maxCandidates: 5000,
  };
}

describe('spool broad/bulk admission', () => {
  let spoolDir: string;
  let db: ReturnType<typeof createTestDatabase>;
  let candidateRepo: CandidateRepository;
  let batchRepo: ImportBatchRepository;

  beforeEach(async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'spool-admission-test-'));
    db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
    batchRepo = new ImportBatchRepository(db);
  });

  afterEach(async () => {
    db.close();
    await rm(spoolDir, { recursive: true, force: true });
  });

  it('refuses bulk candidates without a batch receipt before insertion', async () => {
    const candidate = makeCandidate({
      source: 'bulk_import',
      trustLevel: 'untrusted',
      tenantId: 'tenant-bulk',
    });
    const path = join(spoolDir, 'spool-2026-08-02T170000Z.jsonl');
    const body = jsonl([candidate]);
    await writeFile(path, body, 'utf8');
    await writeFile(
      `${path}.manifest.json`,
      JSON.stringify({
        schemaVersion: '1',
        emittedCount: 1,
        spoolFileSha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        candidateIds: [candidate.id],
      }),
      'utf8',
    );

    const result = await ingestFromSpoolDetailed(candidateRepo, spoolDir, {
      importBatchRepo: batchRepo,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ingested).toHaveLength(0);
    expect(result.value.admissionRejected).toHaveLength(1);
    expect(candidateRepo.count()).toBe(0);
  });

  it('persists a verified batch ID on bulk candidates and completes the batch receipt', async () => {
    const candidates = [
      makeCandidate({ source: 'bulk_import', trustLevel: 'untrusted', tenantId: 'tenant-bulk' }),
      makeCandidate({ source: 'bulk_import', trustLevel: 'untrusted', tenantId: 'tenant-bulk' }),
    ];
    await writeBulkSpool(spoolDir, candidates, {});

    const result = await ingestFromSpoolDetailed(candidateRepo, spoolDir, {
      importBatchRepo: batchRepo,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ingested).toHaveLength(2);
    expect(result.value.admissionRejected).toHaveLength(0);
    expect(batchRepo.findById('bulk-batch-2026-08-02')).toMatchObject({
      status: 'completed',
      createdCount: 2,
      rejectedCount: 0,
      skippedCount: 0,
    });
    const rows = db
      .prepare<[], { import_batch_id: string }>('SELECT import_batch_id FROM candidates')
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.import_batch_id === 'bulk-batch-2026-08-02')).toBe(true);
  });

  it('refuses a receipt whose declared count exceeds its ceiling', async () => {
    const candidates = [
      makeCandidate({ source: 'bulk_import', trustLevel: 'low', tenantId: 'tenant-bulk' }),
      makeCandidate({ source: 'bulk_import', trustLevel: 'low', tenantId: 'tenant-bulk' }),
    ];
    await writeBulkSpool(spoolDir, candidates, { maxCandidates: 1 });

    const result = await ingestFromSpoolDetailed(candidateRepo, spoolDir, {
      importBatchRepo: batchRepo,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ingested).toHaveLength(0);
    expect(result.value.admissionRejected[0]?.reason).toContain('exceeds maxCandidates');
    expect(candidateRepo.count()).toBe(0);
  });

  it('requires a receipt for a broad import source even when it is not bulk-stamped', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) =>
      makeCandidate({
        source: 'import',
        tenantId: 'tenant-import',
        title: `Broad import candidate ${index}`,
      }),
    );
    const path = join(spoolDir, 'spool-2026-08-02T170000Z.jsonl');
    await writeFile(path, jsonl(candidates), 'utf8');

    const result = await ingestFromSpoolDetailed(candidateRepo, spoolDir, {
      importBatchRepo: batchRepo,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ingested).toHaveLength(0);
    expect(result.value.admissionRejected[0]?.reason).toContain('missing batchReceipt');
    expect(candidateRepo.count()).toBe(0);
  });
});
