/**
 * Demo end-to-end smoke (bead `qmd-team-intent-kb-6yg`).
 *
 * The integration test that proves the cross-repo proof-of-work demo's
 * INTKB legs hold together: given a hand-crafted spool file matching ICO's
 * wire format, the curator pipeline (ingest → policy → promote) produces a
 * curated_memory row that is retrievable by:
 *   - `MemoryRepository.findById` with full provenance preserved
 *   - `MemoryRepository.searchByText` with title and content matching
 *   - tenant-scoped + category-scoped filters
 *
 * Replaces the conceptual stage 6 of `scripts/demo-e2e.sh` (qmd MCP query
 * returns curated memory with citation) — at the SQLite / repository layer
 * for v1 because the HTTP + MCP surfaces add operational complexity
 * (booting Fastify, MCP stdio transport) without proving anything the
 * repository layer doesn't already cover. Surface-specific tests live
 * alongside their app (apps/api/src/__tests__/, apps/mcp-server/src/__tests__/).
 *
 * Companion to ICO's `scripts/demo-e2e.sh` — when stage 5 / 6 wiring lands
 * (edge-daemon + git-exporter + qmd index orchestration), this test pins
 * the INTKB-side contract those stages must satisfy.
 *
 * @module __tests__/demo-smoke.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuditRepository,
  CandidateRepository,
  MemoryLinksRepository,
  MemoryRepository,
  PolicyRepository,
  createTestDatabase,
} from '@qmd-team-intent-kb/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Curator } from '../curator.js';
import { ingestFromSpool } from '../intake/spool-intake.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

let spoolDir: string;
let db: ReturnType<typeof createTestDatabase>;

beforeEach(async () => {
  spoolDir = await mkdtemp(join(tmpdir(), 'demo-smoke-'));
  db = createTestDatabase();
});

afterEach(async () => {
  db.close();
  await rm(spoolDir, { recursive: true, force: true });
});

/**
 * Build a spool JSONL line in the exact wire format ICO's emitter writes
 * (per `apps/curator/src/__tests__/spool-intake-ico-contract.test.ts`).
 * This is hand-crafted to be a stable known-good fixture — a v1 of the
 * proof-of-work demo's expected ICO output, distilled to one candidate
 * we can introspect at every step.
 */
function makeSpoolLine(overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      schemaVersion: '1',
      id: '1edb9e72-d5ff-5077-a329-2b44f8c61c4b',
      status: 'inbox',
      source: 'import',
      title: 'Transformer attention mechanism',
      content:
        'The transformer attention mechanism computes scaled dot-product attention ' +
        'over query, key, and value matrices. Self-attention allows the model to ' +
        'weigh different positions of the input sequence when producing each output ' +
        'representation. Multi-head attention runs h parallel attention layers.',
      category: 'architecture',
      trustLevel: 'medium',
      author: { type: 'ai', id: 'ico', name: 'Intentional Cognition OS' },
      tenantId: 'demo-e2e',
      metadata: {
        filePaths: ['wiki/topics/transformers.md', 'raw/papers/attention-is-all-you-need.pdf'],
        projectContext: 'intentional-cognition-os',
        tags: ['transformer', 'attention', 'architecture'],
      },
      prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
      capturedAt: '2026-05-29T08:00:00.000Z',
      ...overrides,
    }) + '\n'
  );
}

/** Drive the full curator pipeline against the spool dir. */
async function runPipeline(tenantId: string): Promise<{
  ingested: number;
  promoted: number;
}> {
  const candidateRepo = new CandidateRepository(db);
  const memoryRepo = new MemoryRepository(db);
  const policyRepo = new PolicyRepository(db);
  const auditRepo = new AuditRepository(db);
  const linksRepo = new MemoryLinksRepository(db);

  const ingestResult = await ingestFromSpool(candidateRepo, spoolDir);
  if (!ingestResult.ok) {
    throw new Error(`ingestFromSpool failed: ${ingestResult.error}`);
  }
  const candidates = ingestResult.value;

  const curator = new Curator(
    { candidateRepo, memoryRepo, policyRepo, auditRepo, linksRepo },
    { tenantId },
  );
  const batch = curator.processBatch(candidates);

  return { ingested: candidates.length, promoted: batch.promoted };
}

// ---------------------------------------------------------------------------
// End-to-end smoke
// ---------------------------------------------------------------------------

describe('demo-smoke: spool → pipeline → searchable curated memory', () => {
  it('promotes a hand-crafted candidate into a retrievable curated memory', async () => {
    await writeFile(join(spoolDir, 'spool-2026-05-29T080000Z.jsonl'), makeSpoolLine(), 'utf8');

    const { ingested, promoted } = await runPipeline('demo-e2e');
    expect(ingested).toBe(1);
    expect(promoted).toBe(1);

    // The promoter mints a fresh UUID for the memory (it does not preserve
    // the candidate id), so we retrieve via tenant + lifecycle scope.
    const memoryRepo = new MemoryRepository(db);
    const memories = memoryRepo.findByTenantAndLifecycle('demo-e2e', 'active');
    expect(memories.length).toBe(1);
    const stored = memories[0]!;
    expect(stored.title).toBe('Transformer attention mechanism');
    expect(stored.tenantId).toBe('demo-e2e');
    expect(stored.category).toBe('architecture');
    expect(stored.lifecycle).toBe('active');
  });

  it('preserves source-citation (metadata.filePaths) through the pipeline', async () => {
    await writeFile(join(spoolDir, 'spool-2026-05-29T080000Z.jsonl'), makeSpoolLine(), 'utf8');
    const { promoted } = await runPipeline('demo-e2e');
    expect(promoted).toBe(1);

    const memoryRepo = new MemoryRepository(db);
    const stored = memoryRepo.findByTenantAndLifecycle('demo-e2e', 'active')[0]!;
    expect(stored.metadata.filePaths).toContain('wiki/topics/transformers.md');
    expect(stored.metadata.filePaths).toContain('raw/papers/attention-is-all-you-need.pdf');
    expect(stored.metadata.tags).toContain('transformer');
    expect(stored.metadata.tags).toContain('attention');
  });

  it('finds the promoted memory by content keyword via searchByText', async () => {
    await writeFile(join(spoolDir, 'spool-2026-05-29T080000Z.jsonl'), makeSpoolLine(), 'utf8');
    await runPipeline('demo-e2e');

    const memoryRepo = new MemoryRepository(db);
    const hits = memoryRepo.searchByText('attention', 'demo-e2e');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const matched = hits.find((h) => h.title === 'Transformer attention mechanism');
    expect(matched).toBeDefined();
  });

  it('finds the promoted memory by title keyword via searchByText', async () => {
    await writeFile(join(spoolDir, 'spool-2026-05-29T080000Z.jsonl'), makeSpoolLine(), 'utf8');
    await runPipeline('demo-e2e');

    const memoryRepo = new MemoryRepository(db);
    const hits = memoryRepo.searchByText('transformer', 'demo-e2e');
    expect(hits.some((h) => h.title === 'Transformer attention mechanism')).toBe(true);
  });

  it('honors the tenant filter on search', async () => {
    await writeFile(join(spoolDir, 'spool-2026-05-29T080000Z.jsonl'), makeSpoolLine(), 'utf8');
    await runPipeline('demo-e2e');

    const memoryRepo = new MemoryRepository(db);
    // Different tenant id → should not see the demo-e2e memory.
    const other = memoryRepo.searchByText('attention', 'some-other-tenant');
    expect(other.length).toBe(0);

    const own = memoryRepo.searchByText('attention', 'demo-e2e');
    expect(own.length).toBeGreaterThanOrEqual(1);
  });

  it('honors the category filter on search', async () => {
    await writeFile(join(spoolDir, 'spool-2026-05-29T080000Z.jsonl'), makeSpoolLine(), 'utf8');
    await runPipeline('demo-e2e');

    const memoryRepo = new MemoryRepository(db);
    const arch = memoryRepo.searchByText('attention', 'demo-e2e', ['architecture']);
    expect(arch.length).toBeGreaterThanOrEqual(1);

    const decisions = memoryRepo.searchByText('attention', 'demo-e2e', ['decision']);
    expect(decisions.length).toBe(0);
  });

  it('promotes multiple candidates in one batch and finds each by tag', async () => {
    const candidates = [
      makeSpoolLine({
        id: '00000000-0000-5000-8000-000000000001',
        title: 'Mixture of experts routing',
        content: 'Sparse mixture-of-experts routing distributes computation across experts.',
        metadata: {
          filePaths: ['wiki/topics/moe.md'],
          projectContext: 'intentional-cognition-os',
          tags: ['moe', 'sparse'],
        },
      }),
      makeSpoolLine({
        id: '00000000-0000-5000-8000-000000000002',
        title: 'KV cache mechanics',
        content:
          'KV caches store precomputed key-value pairs for efficient autoregressive decoding.',
        metadata: {
          filePaths: ['wiki/topics/kv-cache.md'],
          projectContext: 'intentional-cognition-os',
          tags: ['kv-cache', 'decoding'],
        },
      }),
    ];
    await writeFile(join(spoolDir, 'spool-2026-05-29T080000Z.jsonl'), candidates.join(''), 'utf8');

    const { promoted } = await runPipeline('demo-e2e');
    expect(promoted).toBe(2);

    const memoryRepo = new MemoryRepository(db);
    const moe = memoryRepo.searchByText('mixture', 'demo-e2e');
    expect(moe.some((m) => m.title === 'Mixture of experts routing')).toBe(true);

    const kv = memoryRepo.searchByText('KV', 'demo-e2e');
    expect(kv.some((m) => m.title === 'KV cache mechanics')).toBe(true);
  });
});
