#!/usr/bin/env tsx
/**
 * ci-seed-receipts-fixture — seed a small ON-DISK governed brain fixture for
 * the `verify-receipts-model-free` seam-independence CI job (blueprint bead
 * B3; workflow `.github/workflows/seam-independence.yml`).
 *
 * The job's claim: every receipt verifier (verify-audit-chain,
 * verify-corpus-accounting, provenance-walk, the provenance-integrity eval)
 * runs to a verdict in an environment where NO ML dependency is loadable —
 * no qmd binary on PATH, the retrieval package's source deleted. To exercise
 * the verifiers for real (not against an empty in-memory DB), this script
 * builds the same fixture shape as `__tests__/provenance-walk.test.ts`, but
 * on disk and WITHOUT importing test-fixtures (which production-adjacent
 * code must not import — dep-cruiser invariant 5):
 *
 *   <out>/teamkb.db   governed store: 1 candidate + 1 promoted memory +
 *                     the 'promoted' audit receipt, all planted through the
 *                     REAL CandidateRepository.insert + promote() path
 *   <out>/brain/      fabricated ICO brain root with one compile-trace event
 *   <out>/spool/      spool file + SHA-256 manifest sidecar naming the candidate
 *   <out>/fixture.json  { dbPath, brainDir, spoolDir, memoryId }
 *
 * The candidate id is content-addressed exactly as ICO derives it
 * (deriveCandidateId(workspaceId, relPath, sha256(body))), so a
 * `provenance-walk` over this fixture walks all 7 links to PASS / exit 0.
 *
 * Usage: tsx scripts/ci-seed-receipts-fixture.ts --out <dir>
 * Exit 0 on success; 1 on any failure.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { computeContentHash, deriveCandidateId } from '@qmd-team-intent-kb/common';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  createDatabase,
} from '@qmd-team-intent-kb/store';

import { promote } from '../src/promotion/promoter.js';

const REL_PATH = 'wiki/concepts/seam-receipts-fixture.md';
const BODY = '## Seam fixture\n\nA compiled page body used to content-address the candidate.';
const TENANT = 'ci-seam-receipts';

function main(): void {
  const outFlag = process.argv.indexOf('--out');
  if (outFlag === -1 || process.argv[outFlag + 1] === undefined) {
    process.stderr.write('usage: ci-seed-receipts-fixture --out <dir>\n');
    process.exit(1);
  }
  const out = resolve(process.argv[outFlag + 1] as string);
  rmSync(out, { recursive: true, force: true });
  const brainDir = join(out, 'brain');
  const spoolDir = join(out, 'spool');
  mkdirSync(join(brainDir, 'audit', 'traces'), { recursive: true });
  mkdirSync(spoolDir, { recursive: true });

  // Candidate id derived exactly as ICO derives it: workspaceId is the
  // basename of the brain root; body sha is the sha256 of the page body.
  const bodySha256 = computeContentHash(BODY);
  const candidateId = deriveCandidateId(basename(brainDir), REL_PATH, bodySha256);
  const candidate = MemoryCandidate.parse({
    id: candidateId,
    status: 'inbox',
    source: 'import',
    content: BODY,
    title: 'Seam receipts fixture',
    category: 'convention',
    trustLevel: 'medium',
    author: { type: 'ai', id: 'ci-seam' },
    tenantId: TENANT,
    metadata: { filePaths: [REL_PATH], projectContext: 'ico', tags: [] },
    prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
    capturedAt: '2026-01-01T00:00:00.000Z',
  });

  const dbPath = join(out, 'teamkb.db');
  const db = createDatabase({ path: dbPath });
  try {
    const contentHash = computeContentHash(candidate.content);
    new CandidateRepository(db).insert(candidate, contentHash);
    const pipelineResult: PipelineResult = {
      candidateId: candidate.id,
      outcome: 'approved',
      evaluations: [],
    };
    const memory = promote(
      { candidate, contentHash, pipelineResult },
      new MemoryRepository(db),
      new AuditRepository(db),
    );

    // Spool file + manifest sidecar, shaped like ICO's emit (spoolFileSha256
    // pins the file bytes; candidateIds lists the emitted ids).
    const spoolFile = join(spoolDir, 'spool-2026-01-01T000000Z.jsonl');
    const spoolBody = JSON.stringify({ id: candidateId }) + '\n';
    writeFileSync(spoolFile, spoolBody);
    writeFileSync(
      `${spoolFile}.manifest.json`,
      JSON.stringify({
        schemaVersion: '1',
        emittedCount: 1,
        spoolFile: basename(spoolFile),
        spoolFileSha256: createHash('sha256').update(spoolBody, 'utf8').digest('hex'),
        candidateIds: [candidateId],
      }),
    );

    // One hash-chained ICO trace event referencing the compiled page.
    writeFileSync(
      join(brainDir, 'audit', 'traces', '2026-01-01.jsonl'),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        event_type: 'compile.summarize',
        event_id: 'seam-fixture-event-1',
        payload: { sourceId: 'seam-fixture-source', outputPath: REL_PATH },
        prev_hash: 'a'.repeat(64),
      }) + '\n',
    );

    writeFileSync(
      join(out, 'fixture.json'),
      JSON.stringify({ dbPath, brainDir, spoolDir, memoryId: memory.id }, null, 2) + '\n',
    );
    process.stderr.write(`seeded receipts fixture: ${out} (memory ${memory.id})\n`);
  } finally {
    db.close();
  }
}

main();
