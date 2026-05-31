/**
 * Tests for spool manifest SHA-256 verification on ingest (bead `dmj.4`,
 * threat-model control C11 in 036-AT-THRT-spool-boundary-threat-model.md).
 *
 * Covers the tamper-detection path: a spool file modified after ICO wrote
 * it (so its content no longer matches the manifest's spoolFileSha256) is
 * refused — its candidates are NOT ingested — and quarantined with a
 * `.tamper.json` evidence sidecar. Backward-compat: files without a
 * manifest still ingest (can't-verify, not tamper).
 *
 * @module __tests__/spool-manifest-verify.test
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateRepository, createTestDatabase } from '@qmd-team-intent-kb/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestFromSpool, ingestFromSpoolDetailed } from '../intake/spool-intake.js';
import { makeCandidate } from './fixtures.js';

let spoolDir: string;
let candidateRepo: CandidateRepository;

beforeEach(async () => {
  spoolDir = await mkdtemp(join(tmpdir(), 'spool-manifest-test-'));
  const db = createTestDatabase();
  candidateRepo = new CandidateRepository(db);
});

afterEach(async () => {
  await rm(spoolDir, { recursive: true, force: true });
});

/** Write a spool JSONL file. Returns the file path + raw body written. */
async function writeSpool(
  name: string,
  candidates: ReturnType<typeof makeCandidate>[],
): Promise<{ path: string; body: string }> {
  const path = join(spoolDir, name);
  const body = candidates.map((c) => JSON.stringify(c)).join('\n');
  await writeFile(path, body, 'utf8');
  return { path, body };
}

/** Write a manifest sidecar carrying the given SHA-256. */
async function writeManifest(spoolPath: string, sha256: string): Promise<void> {
  await writeFile(
    `${spoolPath}.manifest.json`,
    JSON.stringify({ schemaVersion: '1', spoolFileSha256: sha256 }, null, 2),
    'utf8',
  );
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Verified — manifest matches
// ---------------------------------------------------------------------------

describe('ingestFromSpool — manifest verified', () => {
  it('ingests a spool file whose manifest SHA-256 matches the content', async () => {
    const { path, body } = await writeSpool('spool-2026-05-30T080000Z.jsonl', [
      makeCandidate({ id: '11111111-1111-4111-8111-111111111111' }),
    ]);
    await writeManifest(path, sha256(body));

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(1);
    expect(candidateRepo.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tampered — manifest mismatch → refuse + quarantine
// ---------------------------------------------------------------------------

describe('ingestFromSpool — manifest tampered', () => {
  it('refuses a spool file whose content no longer matches the manifest', async () => {
    const { path } = await writeSpool('spool-2026-05-30T080100Z.jsonl', [
      makeCandidate({ id: '22222222-2222-4222-8222-222222222222' }),
    ]);
    // Manifest pins a hash for the ORIGINAL content...
    await writeManifest(path, sha256('original trusted content'));
    // ...but the file on disk says something else (tamper after manifest write).
    await writeFile(
      path,
      JSON.stringify(makeCandidate({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })),
      'utf8',
    );

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(0); // refused — nothing ingested
    expect(candidateRepo.count()).toBe(0);
  });

  it('quarantines the tampered file + manifest with a .tamper.json sidecar', async () => {
    const { path } = await writeSpool('spool-2026-05-30T080200Z.jsonl', [
      makeCandidate({ id: '33333333-3333-4333-8333-333333333333' }),
    ]);
    await writeManifest(path, 'deadbeef'.repeat(8)); // deliberately wrong

    const detailed = await ingestFromSpoolDetailed(candidateRepo, spoolDir);
    expect(detailed.ok).toBe(true);
    if (!detailed.ok) return;

    expect(detailed.value.ingested).toHaveLength(0);
    expect(detailed.value.tampered).toHaveLength(1);
    const rec = detailed.value.tampered[0]!;
    expect(rec.expectedSha256).toBe('deadbeef'.repeat(8));
    expect(rec.actualSha256).toBeDefined();
    expect(rec.quarantinedTo).not.toBeNull();

    // Quarantine dir holds the moved file + manifest + evidence sidecar.
    const qDir = join(spoolDir, 'quarantine');
    const qFiles = await readdir(qDir);
    expect(qFiles).toContain('spool-2026-05-30T080200Z.jsonl');
    expect(qFiles).toContain('spool-2026-05-30T080200Z.jsonl.manifest.json');
    expect(qFiles).toContain('spool-2026-05-30T080200Z.jsonl.tamper.json');

    // The original spool dir no longer has the tampered file (it was moved).
    const remaining = await readdir(spoolDir);
    expect(remaining).not.toContain('spool-2026-05-30T080200Z.jsonl');

    // Evidence sidecar records the mismatch + a detection timestamp + reason.
    const evidence = JSON.parse(
      await readFile(join(qDir, 'spool-2026-05-30T080200Z.jsonl.tamper.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(evidence['expectedSha256']).toBe('deadbeef'.repeat(8));
    expect(evidence['actualSha256']).toBeDefined();
    expect(evidence['reason']).toMatch(/SPOOL_TAMPERED/);
    expect(typeof evidence['detectedAt']).toBe('string');
  });

  it('honors a custom quarantine directory', async () => {
    const { path } = await writeSpool('spool-2026-05-30T080300Z.jsonl', [
      makeCandidate({ id: '44444444-4444-4444-8444-444444444444' }),
    ]);
    await writeManifest(path, 'f'.repeat(64));
    const customQ = join(spoolDir, 'custom-quarantine');

    const detailed = await ingestFromSpoolDetailed(candidateRepo, spoolDir, {
      quarantineDir: customQ,
    });
    expect(detailed.ok).toBe(true);
    if (!detailed.ok) return;
    expect(detailed.value.tampered[0]!.quarantinedTo).toContain('custom-quarantine');
    const qFiles = await readdir(customQ);
    expect(qFiles).toContain('spool-2026-05-30T080300Z.jsonl');
  });

  it('processes a clean file even when a sibling file is tampered', async () => {
    const clean = await writeSpool('spool-2026-05-30T080400Z.jsonl', [
      makeCandidate({ id: '55555555-5555-4555-8555-555555555555' }),
    ]);
    await writeManifest(clean.path, sha256(clean.body));

    const dirty = await writeSpool('spool-2026-05-30T080500Z.jsonl', [
      makeCandidate({ id: '66666666-6666-4666-8666-666666666666' }),
    ]);
    await writeManifest(dirty.path, 'a'.repeat(64)); // wrong

    const detailed = await ingestFromSpoolDetailed(candidateRepo, spoolDir);
    expect(detailed.ok).toBe(true);
    if (!detailed.ok) return;
    expect(detailed.value.ingested).toHaveLength(1); // the clean one
    expect(detailed.value.tampered).toHaveLength(1); // the dirty one
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — no manifest, and verifyManifest:false
// ---------------------------------------------------------------------------

describe('ingestFromSpool — verification backward compatibility', () => {
  it('ingests a spool file with NO manifest (can-not-verify, not tamper)', async () => {
    await writeSpool('spool-2026-05-30T080600Z.jsonl', [
      makeCandidate({ id: '77777777-7777-4777-8777-777777777777' }),
    ]);
    // no manifest written

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(1);
  });

  it('ingests a tampered file when verifyManifest is explicitly disabled', async () => {
    const { path } = await writeSpool('spool-2026-05-30T080700Z.jsonl', [
      makeCandidate({ id: '88888888-8888-4888-8888-888888888888' }),
    ]);
    await writeManifest(path, 'totally-wrong-hash');

    const result = await ingestFromSpool(candidateRepo, spoolDir, { verifyManifest: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(1); // verification skipped
  });

  it('skips a file with a malformed manifest (verification error, not ingest)', async () => {
    const { path } = await writeSpool('spool-2026-05-30T080800Z.jsonl', [
      makeCandidate({ id: '99999999-9999-4999-8999-999999999999' }),
    ]);
    await writeFile(`${path}.manifest.json`, 'NOT VALID JSON {{{', 'utf8');

    const result = await ingestFromSpool(candidateRepo, spoolDir);
    expect(result.ok).toBe(true);
    // Malformed manifest → verification errors → file skipped (not ingested,
    // not counted as tamper). Conservative: don't ingest what we can't verify.
    if (result.ok) expect(result.value).toHaveLength(0);
  });
});
