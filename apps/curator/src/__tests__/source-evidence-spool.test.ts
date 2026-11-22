import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { createTestDatabase, CandidateRepository } from '@qmd-team-intent-kb/store';
import { readSpoolFile, writeToSpool } from '@qmd-team-intent-kb/claude-runtime';
import { ingestFromSpoolDetailed } from '../intake/spool-intake.js';
import { makeCandidate } from './fixtures.js';

describe('spool v1 does not silently strip source evidence', () => {
  it.each(['sourceEvidence', 'sourceAssertion', 'sourceClassification', 'assertion'])(
    'refuses %s at schema, writer, reader and intake boundaries while retaining the raw file',
    async (field) => {
      const root = await mkdtemp(join(tmpdir(), 'source-spool-'));
      const db = createTestDatabase();
      try {
        const candidate = { ...makeCandidate(), [field]: 'synthetic-evidence' };
        expect(MemoryCandidate.safeParse(candidate).success).toBe(false);
        expect(await writeToSpool(candidate, root)).toMatchObject({
          ok: false,
          error: expect.stringContaining('source_evidence_unsupported'),
        });
        expect(await readdir(root)).toEqual([]);
        const file = join(root, 'spool-fixture.jsonl');
        const bytes = JSON.stringify(candidate) + '\n';
        await writeFile(file, bytes);
        expect(await readSpoolFile(file)).toMatchObject({
          ok: false,
          error: expect.stringContaining('source_evidence_unsupported'),
        });
        const repo = new CandidateRepository(db);
        const result = await ingestFromSpoolDetailed(repo, root, {
          archiveIngestedDir: join(root, 'ingested'),
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('unexpected intake failure');
        expect(result.value.ingested).toHaveLength(0);
        expect(result.value.admissionRejected).toEqual([
          { spoolFile: file, reason: expect.stringContaining('source_evidence_unsupported') },
        ]);
        expect(repo.findById(candidate.id)).toBeNull();
        expect(await readFile(file, 'utf8')).toBe(bytes);
      } finally {
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
