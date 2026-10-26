import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CandidateRepository, createTestDatabase } from '@qmd-team-intent-kb/store';
import { ingestFromSpoolDetailed, type IngestResult } from '../intake/spool-intake.js';
import { summarizeSpoolIntake } from '../intake/spool-intake-summary.js';
import { makeCandidate } from './fixtures.js';

describe('safe spool intake observations', () => {
  it('uses fixed category keys and counters despite hostile diagnostic strings', () => {
    const marker = 'private-fixture-marker';
    const input: IngestResult = {
      ingested: [makeCandidate({ content: marker })],
      rejected: ['pii', 'compensation', 'secret', '__proto__', marker, 'PII'].map((category) => ({
        candidateId: marker,
        category,
      })),
      tampered: [
        { spoolFile: marker, expectedSha256: marker, actualSha256: marker, quarantinedTo: marker },
      ],
      admissionRejected: [{ spoolFile: marker, reason: marker, batchId: marker }],
    };
    const summary = summarizeSpoolIntake(input);
    expect(summary).toStrictEqual({
      ingestedCandidates: 1,
      disclosureRejectedCandidates: 6,
      disclosureCategories: { pii: 1, compensation: 1, secret: 1, other: 3 },
      tamperedFiles: 1,
      admissionRejectedFiles: 1,
    });
    expect(JSON.stringify(summary)).not.toContain(marker);
    expect(Object.hasOwn(summary.disclosureCategories, '__proto__')).toBe(false);
    expect(input.rejected).toHaveLength(6);
  });
});

describe('real spool refusal retention and repeated observations', () => {
  let root: string;
  let db: Database.Database;
  let candidateRepo: CandidateRepository;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'spool-summary-test-'));
    db = createTestDatabase();
    candidateRepo = new CandidateRepository(db);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function mixedSpool() {
    const clean = makeCandidate({
      content: 'A clean note about cache eviction and retry backoff.',
    });
    const refused = [
      makeCandidate({
        content: 'Synthetic disclosure fixture: SSN marker only; no identifying number.',
      }),
      makeCandidate({
        content: 'Synthetic disclosure fixture: salary keyword only; no person or amount.',
      }),
      makeCandidate({
        content:
          'Synthetic disclosure fixture: -----BEGIN PRIVATE KEY----- marker only; no key material.',
      }),
    ];
    const source = join(root, 'spool-mixed.jsonl');
    const bytes = Buffer.from([clean, ...refused].map((c) => JSON.stringify(c)).join('\n') + '\n');
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: '1',
        spoolFileSha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    );
    await writeFile(source, bytes);
    await writeFile(`${source}.manifest.json`, manifest);
    return { clean, refused, source, bytes, manifest };
  }

  async function observe(archiveIngestedDir?: string) {
    const result = await ingestFromSpoolDetailed(candidateRepo, root, { archiveIngestedDir });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Fixture intake failed');
    return summarizeSpoolIntake(result.value);
  }

  function assertOnlyCleanCandidate(fixture: Awaited<ReturnType<typeof mixedSpool>>) {
    expect(candidateRepo.count()).toBe(1);
    expect(candidateRepo.findById(fixture.clean.id)).not.toBeNull();
    for (const candidate of fixture.refused)
      expect(candidateRepo.findById(candidate.id)).toBeNull();
    // Intake does not govern or invent audit receipts for pre-intake refusals.
    expect(db.prepare('SELECT count(*) AS n FROM curated_memories').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  }

  it('keeps raw bytes without archiving and reports refused observations again', async () => {
    const fixture = await mixedSpool();
    const first = await observe();
    expect(first).toStrictEqual({
      ingestedCandidates: 1,
      disclosureRejectedCandidates: 3,
      disclosureCategories: { pii: 1, compensation: 1, secret: 1, other: 0 },
      tamperedFiles: 0,
      admissionRejectedFiles: 0,
    });
    expect(await observe()).toStrictEqual({ ...first, ingestedCandidates: 0 });
    expect(await readFile(fixture.source)).toEqual(fixture.bytes);
    expect(await readFile(`${fixture.source}.manifest.json`)).toEqual(fixture.manifest);
    assertOnlyCleanCandidate(fixture);
  });

  it('archives the exact mixed raw file and sidecar, then reports zero observations', async () => {
    const fixture = await mixedSpool();
    const archive = join(root, 'ingested');
    expect((await observe(archive)).disclosureRejectedCandidates).toBe(3);
    expect(await readFile(join(archive, 'spool-mixed.jsonl'))).toEqual(fixture.bytes);
    expect(await readFile(join(archive, 'spool-mixed.jsonl.manifest.json'))).toEqual(
      fixture.manifest,
    );
    await expect(readFile(fixture.source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await observe(archive)).toStrictEqual({
      ingestedCandidates: 0,
      disclosureRejectedCandidates: 0,
      disclosureCategories: { pii: 0, compensation: 0, secret: 0, other: 0 },
      tamperedFiles: 0,
      admissionRejectedFiles: 0,
    });
    assertOnlyCleanCandidate(fixture);
  });

  it('repeats refusal observations after a best-effort archive failure without losing raw bytes', async () => {
    const fixture = await mixedSpool();
    const blockedArchive = join(root, 'blocked');
    await writeFile(blockedArchive, 'not a directory');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect((await observe(blockedArchive)).disclosureRejectedCandidates).toBe(3);
    const repeat = await observe(blockedArchive);
    expect(repeat.ingestedCandidates).toBe(0);
    expect(repeat.disclosureRejectedCandidates).toBe(3);
    expect(stderr).toHaveBeenCalled();
    expect(await readFile(fixture.source)).toEqual(fixture.bytes);
    expect(await readFile(`${fixture.source}.manifest.json`)).toEqual(fixture.manifest);
    assertOnlyCleanCandidate(fixture);
  });

  it('propagates a later unexpected insert failure after an earlier write', async () => {
    const first = makeCandidate({ content: 'First clean candidate about cache invalidation.' });
    const second = makeCandidate({ content: 'Second clean candidate about bounded retries.' });
    const source = join(root, 'spool-partial.jsonl');
    const bytes = [first, second].map((c) => JSON.stringify(c)).join('\n');
    await writeFile(source, bytes);
    const insert = candidateRepo.insert.bind(candidateRepo);
    vi.spyOn(candidateRepo, 'insert')
      .mockImplementationOnce(insert)
      .mockImplementationOnce(() => {
        throw new Error('fixture storage failure');
      });
    await expect(ingestFromSpoolDetailed(candidateRepo, root)).rejects.toThrow(
      'fixture storage failure',
    );
    expect(candidateRepo.findById(first.id)).not.toBeNull();
    expect(candidateRepo.findById(second.id)).toBeNull();
    expect(await readFile(source, 'utf8')).toBe(bytes);
    expect(db.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });
});
