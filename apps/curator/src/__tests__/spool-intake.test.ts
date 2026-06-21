import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDatabase, CandidateRepository } from '@qmd-team-intent-kb/store';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { ingestFromSpool, ingestFromSpoolDetailed } from '../intake/spool-intake.js';
import { makeCandidate } from './fixtures.js';

/** Serialise a candidate to a JSONL line */
function candidateToJsonl(candidate: ReturnType<typeof makeCandidate>): string {
  return JSON.stringify(candidate);
}

/** Write candidates to a spool-*.jsonl file in the given directory */
async function writeSpoolFile(
  dir: string,
  name: string,
  candidates: ReturnType<typeof makeCandidate>[],
): Promise<string> {
  const filepath = join(dir, name);
  const lines = candidates.map(candidateToJsonl).join('\n');
  await writeFile(filepath, lines, 'utf8');
  return filepath;
}

describe('ingestFromSpool', () => {
  let spoolDir: string;
  let candidateRepo: CandidateRepository;

  beforeEach(async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'spool-intake-test-'));
    const db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
  });

  afterEach(async () => {
    await rm(spoolDir, { recursive: true, force: true });
  });

  it('returns empty array when spool directory is empty', async () => {
    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });

  it('inserts candidates from a single spool file into the store', async () => {
    const candidate = makeCandidate();
    await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
    }
    expect(candidateRepo.count()).toBe(1);
  });

  it('returns the ingested candidates', async () => {
    const candidate = makeCandidate({ title: 'Important architecture decision' });
    await writeSpoolFile(spoolDir, 'spool-002.jsonl', [candidate]);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.id).toBe(candidate.id);
      expect(result.value[0]?.title).toBe('Important architecture decision');
    }
  });

  it('preserves candidate IDs from spool file', async () => {
    const candidate = makeCandidate();
    await writeSpoolFile(spoolDir, 'spool-003.jsonl', [candidate]);

    await ingestFromSpool(candidateRepo, spoolDir);

    const stored = candidateRepo.findById(candidate.id);
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe(candidate.id);
  });

  it('skips already-ingested candidates (idempotency by ID)', async () => {
    const candidate = makeCandidate();
    const hash = computeContentHash(candidate.content);
    candidateRepo.insert(candidate, hash);

    await writeSpoolFile(spoolDir, 'spool-004.jsonl', [candidate]);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0); // nothing new ingested
    }
    expect(candidateRepo.count()).toBe(1); // still just the original
  });

  it('processes multiple spool files', async () => {
    const c1 = makeCandidate({ title: 'Candidate from file one here' });
    const c2 = makeCandidate({ title: 'Candidate from file two here' });
    const c3 = makeCandidate({ title: 'Second candidate from file two' });

    await writeSpoolFile(spoolDir, 'spool-010.jsonl', [c1]);
    await writeSpoolFile(spoolDir, 'spool-011.jsonl', [c2, c3]);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
    }
    expect(candidateRepo.count()).toBe(3);
  });

  it('computes and stores content hash for each candidate', async () => {
    const content = 'Unique content for hash verification in spool intake test';
    const candidate = makeCandidate({ content });
    await writeSpoolFile(spoolDir, 'spool-005.jsonl', [candidate]);

    await ingestFromSpool(candidateRepo, spoolDir);

    const stored = candidateRepo.findById(candidate.id);
    expect(stored).not.toBeNull();
    // Verify by content hash lookup
    const byHash = candidateRepo.findByContentHash(computeContentHash(content));
    expect(byHash).not.toBeNull();
    expect(byHash?.id).toBe(candidate.id);
  });

  it('handles unreadable spool file gracefully without aborting batch', async () => {
    // Create a file with invalid JSON — should be skipped
    const badFile = join(spoolDir, 'spool-bad.jsonl');
    await writeFile(badFile, 'this is not valid json\n', 'utf8');

    const goodCandidate = makeCandidate();
    await writeSpoolFile(spoolDir, 'spool-good.jsonl', [goodCandidate]);

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    // Should succeed overall even with bad file
    expect(result.ok).toBe(true);
    // The good file should still be processed
    expect(candidateRepo.count()).toBe(1);
  });

  it('returns error when spool directory does not exist', async () => {
    const nonExistentDir = join(tmpdir(), 'does-not-exist-spool-' + Date.now().toString());
    const result = await ingestFromSpool(candidateRepo, nonExistentDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it('only reads files named spool-*.jsonl, ignores other files', async () => {
    const candidate = makeCandidate();
    // Write a file that does NOT match the spool-*.jsonl pattern
    const otherFile = join(spoolDir, 'not-a-spool-file.txt');
    await writeFile(otherFile, candidateToJsonl(candidate), 'utf8');

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0); // non-matching file ignored
    }
  });
});

// Epic 0 (compile-then-govern-c5k): the spool-intake path (ICO ingest + MCP
// propose→spool) previously bypassed the disclosure filter — it called
// candidateRepo.insert() directly with no PII / comp / secret check. The
// repository-layer choke point now rejects disallowed content on this path too.
// A poisoned candidate is refused WITHOUT aborting the batch (fail-closed on the
// bad candidate, not a DoS on the whole spool), and surfaced in `rejected`.
describe('ingestFromSpool — disclosure / secret choke point (spool bypass path)', () => {
  let spoolDir: string;
  let candidateRepo: CandidateRepository;

  beforeEach(async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'spool-disclosure-test-'));
    const db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
  });

  afterEach(async () => {
    await rm(spoolDir, { recursive: true, force: true });
  });

  it('refuses a PII candidate and does NOT write it', async () => {
    const dirty = makeCandidate({ content: 'applicant ssn 123-45-6789 on file' });
    await writeSpoolFile(spoolDir, 'spool-pii.jsonl', [dirty]);

    const result = await ingestFromSpoolDetailed(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ingested).toHaveLength(0);
      expect(result.value.rejected).toHaveLength(1);
      expect(result.value.rejected[0]?.category).toBe('pii');
      expect(result.value.rejected[0]?.candidateId).toBe(dirty.id);
    }
    expect(candidateRepo.count()).toBe(0);
  });

  it('refuses a secret candidate (gitleaks-class)', async () => {
    const dirty = makeCandidate({
      content: 'token leaked: ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz12',
    });
    await writeSpoolFile(spoolDir, 'spool-secret.jsonl', [dirty]);

    const result = await ingestFromSpoolDetailed(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rejected[0]?.category).toBe('secret');
    }
    expect(candidateRepo.count()).toBe(0);
  });

  it('one poisoned candidate does NOT block clean candidates in the same batch', async () => {
    const clean1 = makeCandidate({ content: 'clean note one about caching strategy' });
    const dirty = makeCandidate({ content: 'his base salary was leaked here' });
    const clean2 = makeCandidate({ content: 'clean note two about retry backoff' });
    // All three in one spool file — the dirty one must not abort the batch.
    await writeSpoolFile(spoolDir, 'spool-mixed.jsonl', [clean1, dirty, clean2]);

    const result = await ingestFromSpoolDetailed(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ingested).toHaveLength(2);
      expect(result.value.rejected).toHaveLength(1);
      expect(result.value.rejected[0]?.category).toBe('compensation');
    }
    // Exactly the two clean candidates landed.
    expect(candidateRepo.count()).toBe(2);
    expect(candidateRepo.findById(clean1.id)).not.toBeNull();
    expect(candidateRepo.findById(clean2.id)).not.toBeNull();
    expect(candidateRepo.findById(dirty.id)).toBeNull();
  });

  it('does not leak the matched value in the rejection record', async () => {
    const dirty = makeCandidate({ content: 'applicant ssn 123-45-6789 on file' });
    await writeSpoolFile(spoolDir, 'spool-pii2.jsonl', [dirty]);

    const result = await ingestFromSpoolDetailed(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.value.rejected)).not.toContain('123-45-6789');
    }
  });
});
