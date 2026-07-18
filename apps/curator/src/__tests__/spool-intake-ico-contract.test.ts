/**
 * Cross-repo contract test: ICO emission → INTKB ingestFromSpool round-trip.
 *
 * This is the load-bearing integration test for the ICO → INTKB spool boundary
 * (Build Item A per the post-thesis council Decision Record at
 * `000-docs/035-AT-DECR-post-thesis-build-direction-2026-05-23.md`).
 *
 * Validates that a SpoolMemoryCandidate JSONL line produced by ICO's
 * `packages/kernel/src/spool.ts` emitter parses cleanly through INTKB's
 * `ingestFromSpool` + `MemoryCandidate` Zod schema. The fixture mirrors
 * ICO's actual output shape (with `schemaVersion: '1'`, `source: 'import'`,
 * `author: {type:'ai', id:'ico', ...}`, and UTC Z-suffixed `capturedAt`).
 *
 * If this test fails, ICO's emitter is producing JSONL lines that INTKB's
 * reader will silently drop (per the skip-unknown behaviour of safeParse).
 * Resync by reading ICO's `packages/types/src/spool.ts` and reconciling
 * fields here AND in INTKB's `packages/schema/src/memory-candidate.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateRepository, createTestDatabase } from '@qmd-team-intent-kb/store';

import { ingestFromSpool } from '../intake/spool-intake.js';

/**
 * Build a sample ICO-shape candidate matching the exact wire format ICO's
 * `packages/kernel/src/spool.ts` emits. Do NOT use INTKB's `makeCandidate`
 * fixture — that one is shaped by INTKB's own conventions and would
 * accidentally pass this test without exercising the ICO contract.
 */
function makeIcoEmission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1', // ICO-only field; INTKB strips unknown silently
    id: '1edb9e72-d5ff-5077-a329-2b44f8c61c4b', // UUID v5 (5 in 7th hex digit)
    status: 'inbox',
    source: 'import', // ICO uses 'import' (no enum entry for ico_compile yet)
    content: 'A compiled wiki page body about transformer attention.',
    title: 'Transformer attention',
    category: 'architecture',
    trustLevel: 'medium',
    author: { type: 'ai', id: 'ico', name: 'Intentional Cognition OS' },
    tenantId: 'intentional-cognition-os',
    metadata: {
      filePaths: ['wiki/topics/transformers.md'],
      projectContext: 'intentional-cognition-os',
      tags: ['transformer', 'attention'],
    },
    prePolicyFlags: {
      potentialSecret: false,
      lowConfidence: false,
      duplicateSuspect: false,
    },
    capturedAt: '2026-05-24T03:00:00.000Z', // Z-suffix required by Zod 4 datetime
    ...overrides,
  };
}

async function writeIcoSpoolFile(
  dir: string,
  isoTimestamp: string,
  candidates: Array<Record<string, unknown>>,
): Promise<string> {
  // ICO writes files named `spool-YYYY-MM-DDTHHMMSSZ.jsonl`. The INTKB reader
  // glob is `spool-*.jsonl` so this matches.
  const filename = `spool-${isoTimestamp}.jsonl`;
  const filepath = join(dir, filename);
  const lines = candidates.map((c) => JSON.stringify(c)).join('\n');
  await writeFile(filepath, lines, 'utf8');
  return filepath;
}

describe('cross-repo contract: ICO emission → INTKB ingestFromSpool', () => {
  let spoolDir: string;
  let candidateRepo: CandidateRepository;

  beforeEach(async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'ico-intkb-contract-'));
    const db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
  });

  afterEach(async () => {
    await rm(spoolDir, { recursive: true, force: true });
  });

  it('ingests an ICO-shape candidate end-to-end', async () => {
    const emission = makeIcoEmission();
    await writeIcoSpoolFile(spoolDir, '2026-05-24T030000Z', [emission]);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(emission['id']);
      expect(result.value[0]?.tenantId).toBe('intentional-cognition-os');
      expect(result.value[0]?.author.type).toBe('ai');
      expect(result.value[0]?.author.id).toBe('ico');
    }
    expect(candidateRepo.count()).toBe(1);
  });

  it("preserves ICO's schemaVersion '1' rather than stripping it (5bm.6)", async () => {
    const emission = makeIcoEmission();
    await writeIcoSpoolFile(spoolDir, '2026-05-24T030100Z', [emission]);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // INTKB now defines schemaVersion (z.literal('1')), so the version is a
      // validated, retained field — not a silently-stripped unknown. This is the
      // gate that lets a v2 line be rejected (next test) instead of downgraded.
      expect(result.value[0]?.schemaVersion).toBe('1');
    }
    expect(candidateRepo.count()).toBe(1);
  });

  it('rejects a v2 spool line instead of ingesting it as v1 (5bm.6)', async () => {
    // A future ICO v2 sets schemaVersion:'2'. The literal-'1' schema fails
    // safeParse on that line, so readSpoolFile skips it — the line is NOT
    // silently downgraded to v1 with its new fields dropped.
    const v2 = { ...makeIcoEmission(), schemaVersion: '2' };
    await writeIcoSpoolFile(spoolDir, '2026-05-24T030200Z', [v2]);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    // The v2 line was rejected, so nothing was ingested.
    expect(candidateRepo.count()).toBe(0);
  });

  it('handles ICO timestamp-granular spool filenames (spool-YYYY-MM-DDTHHMMSSZ.jsonl)', async () => {
    // ICO emits per-invocation files. Verify INTKB's glob picks them up.
    await writeIcoSpoolFile(spoolDir, '2026-05-24T030000Z', [
      makeIcoEmission({ id: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa' }),
    ]);
    await writeIcoSpoolFile(spoolDir, '2026-05-24T030200Z', [
      makeIcoEmission({ id: 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb' }),
    ]);
    await writeIcoSpoolFile(spoolDir, '2026-05-24T030400Z', [
      makeIcoEmission({ id: 'cccccccc-cccc-5ccc-8ccc-cccccccccccc' }),
    ]);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
    }
  });

  it('dedupes on ID across multiple ICO emissions (idempotent re-emit)', async () => {
    // ICO uses deterministic UUID v5 → re-emitting unchanged content produces
    // the same candidate ID, which INTKB id-dedupe must silently skip.
    const emission = makeIcoEmission();
    await writeIcoSpoolFile(spoolDir, '2026-05-24T030000Z', [emission]);
    await writeIcoSpoolFile(spoolDir, '2026-05-24T040000Z', [emission]); // same ID

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // First emission ingests; second is silently skipped on id collision.
      expect(result.value).toHaveLength(1);
    }
    expect(candidateRepo.count()).toBe(1);
  });

  it('rejects an emission missing the tenantId field', async () => {
    const bad = makeIcoEmission({ tenantId: undefined }); // shouldn't even exist
    delete bad['tenantId'];
    await writeIcoSpoolFile(spoolDir, '2026-05-24T030000Z', [bad]);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Invalid line silently skipped per the reader's safeParse-skip semantics.
      expect(result.value).toHaveLength(0);
    }
  });

  it('accepts all 7 INTKB MemoryCategory values from ICO emissions', async () => {
    const cats = [
      'decision',
      'pattern',
      'convention',
      'architecture',
      'troubleshooting',
      'onboarding',
      'reference',
    ];
    const candidates = cats.map((c, i) =>
      makeIcoEmission({
        category: c,
        id: `00000000-0000-5000-8000-00000000000${i}`,
        title: `Cat ${c}`,
      }),
    );
    await writeIcoSpoolFile(spoolDir, '2026-05-24T030000Z', candidates);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(cats.length);
    }
  });
});
