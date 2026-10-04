/**
 * Store-level pieces of governed redaction (Epic K bead K3): the candidate
 * content rewrite, the redaction-receipt lookups, the re-ingest choke point and
 * the physical scrub + byte scan. Real SQLite throughout; the physical tests
 * use a FILE-backed store because their subject is the bytes on disk.
 *
 * Every secret-shaped value here is synthetic.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeContentHash, DisclosureRejectedError } from '@qmd-team-intent-kb/common';
import { AuditEvent } from '@qmd-team-intent-kb/schema';
import {
  makeCandidate,
  makeMemory,
  DEFAULT_TENANT,
  FIXED_NOW,
} from '@qmd-team-intent-kb/test-fixtures';

import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  RedactedContentReingestError,
  createDatabase,
  createTestDatabase,
  enableSecureDelete,
  findRowsContaining,
  scanStoreFilesForFragments,
  scrubFreedPages,
  storeFilesOf,
  verifyAuditChain,
} from '../index.js';

/** A synthetic secret: long, unique, and shaped like nothing real. */
const SYNTHETIC = 'zq-synthetic-' + 'secret-7H2kQ9vX4mB8' + '-do-not-use';
const ORIGINAL = `Rotate the staging box. The synthetic value is ${SYNTHETIC} for the drill.`;
const REPLACEMENT = 'Rotate the staging box. [REDACTED] for the drill.';

function redactedReceipt(
  targetId: string,
  oldContent: string,
  newContent: string,
  target: 'memory' | 'candidate' = 'memory',
  tenantId = DEFAULT_TENANT,
): AuditEvent {
  return AuditEvent.parse({
    id: randomUUID(),
    action: 'redacted',
    memoryId: targetId,
    tenantId,
    actor: { type: 'human', id: 'tester' },
    reason: 'synthetic secret removed in a test',
    details: {
      target,
      oldContentHash: computeContentHash(oldContent),
      newContentHash: computeContentHash(newContent),
    },
    timestamp: FIXED_NOW,
  });
}

describe('CandidateRepository.updateContent', () => {
  let db: Database.Database;
  let repo: CandidateRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new CandidateRepository(db);
  });
  afterEach(() => db.close());

  it('replaces content and title and recomputes the stored hash', () => {
    const candidate = makeCandidate({ content: ORIGINAL });
    repo.insert(candidate, computeContentHash(ORIGINAL));

    const newHash = repo.updateContent(candidate.id, DEFAULT_TENANT, {
      content: REPLACEMENT,
      title: 'Rotated staging box',
    });

    expect(newHash).toBe(computeContentHash(REPLACEMENT));
    const after = repo.findById(candidate.id)!;
    expect(after.content).toBe(REPLACEMENT);
    expect(after.title).toBe('Rotated staging box');
    expect(repo.findByContentHashAndTenant(newHash!, DEFAULT_TENANT)?.id).toBe(candidate.id);
    expect(
      repo.findByContentHashAndTenant(computeContentHash(ORIGINAL), DEFAULT_TENANT),
    ).toBeNull();
    expect(repo.findIdsByContentHashAndTenant(newHash!, DEFAULT_TENANT)).toEqual([candidate.id]);
  });

  it('leaves every other column untouched', () => {
    const candidate = makeCandidate({ content: ORIGINAL, status: 'promoted' });
    repo.insert(candidate, computeContentHash(ORIGINAL));
    repo.updateContent(candidate.id, DEFAULT_TENANT, {
      content: REPLACEMENT,
      title: candidate.title,
    });
    const after = repo.findById(candidate.id)!;
    expect({ ...after, content: candidate.content }).toEqual(candidate);
  });

  it('returns null for an unknown id and for another tenant, writing nothing', () => {
    const candidate = makeCandidate({ content: ORIGINAL });
    repo.insert(candidate, computeContentHash(ORIGINAL));
    expect(
      repo.updateContent(randomUUID(), DEFAULT_TENANT, { content: REPLACEMENT, title: 't' }),
    ).toBeNull();
    expect(
      repo.updateContent(candidate.id, 'other-tenant', { content: REPLACEMENT, title: 't' }),
    ).toBeNull();
    expect(repo.findById(candidate.id)!.content).toBe(ORIGINAL);
  });

  it('refuses a replacement that fails the disclosure gate', () => {
    const candidate = makeCandidate({ content: ORIGINAL });
    repo.insert(candidate, computeContentHash(ORIGINAL));
    expect(() =>
      repo.updateContent(candidate.id, DEFAULT_TENANT, {
        content: 'Her SSN is 078-05-1120 per the scanned form.',
        title: candidate.title,
      }),
    ).toThrow(DisclosureRejectedError);
    expect(repo.findById(candidate.id)!.content).toBe(ORIGINAL);
  });

  it('reads and rewrites a legacy row that no longer parses as a MemoryCandidate', () => {
    const candidate = makeCandidate({ content: ORIGINAL });
    repo.insert(candidate, computeContentHash(ORIGINAL));
    db.prepare('UPDATE candidates SET metadata_json = ? WHERE id = ?').run(
      JSON.stringify({ filePaths: [], tags: ['Not A Valid Tag'] }),
      candidate.id,
    );
    expect(() => repo.findById(candidate.id)).toThrow();

    expect(repo.readStoredText(candidate.id, DEFAULT_TENANT)).toEqual({
      content: ORIGINAL,
      title: candidate.title,
    });
    expect(repo.readStoredText(candidate.id, 'other-tenant')).toBeNull();
    expect(repo.readStoredText(randomUUID(), DEFAULT_TENANT)).toBeNull();
    expect(
      repo.updateContent(candidate.id, DEFAULT_TENANT, { content: REPLACEMENT, title: 'Rotated' }),
    ).toBe(computeContentHash(REPLACEMENT));
    expect(repo.readStoredText(candidate.id, DEFAULT_TENANT)!.content).toBe(REPLACEMENT);
  });
});

describe('redaction receipts and the re-ingest choke point', () => {
  let db: Database.Database;
  let candidates: CandidateRepository;
  let audit: AuditRepository;

  beforeEach(() => {
    db = createTestDatabase();
    candidates = new CandidateRepository(db);
    audit = new AuditRepository(db);
  });
  afterEach(() => db.close());

  it('finds a redaction by its OLD content hash, tenant-scoped', () => {
    const memoryId = randomUUID();
    const receipt = redactedReceipt(memoryId, ORIGINAL, REPLACEMENT);
    audit.insert(receipt);

    const found = audit.findRedactionByOldContentHash(computeContentHash(ORIGINAL), DEFAULT_TENANT);
    expect(found).toMatchObject({
      eventId: receipt.id,
      targetId: memoryId,
      target: 'memory',
      oldContentHash: computeContentHash(ORIGINAL),
      newContentHash: computeContentHash(REPLACEMENT),
    });
    // The NEW hash is not a redacted hash, and another tenant sees nothing.
    expect(
      audit.findRedactionByOldContentHash(computeContentHash(REPLACEMENT), DEFAULT_TENANT),
    ).toBeNull();
    expect(
      audit.findRedactionByOldContentHash(computeContentHash(ORIGINAL), 'other-tenant'),
    ).toBeNull();
  });

  it('returns a row’s redaction receipts in chain order', () => {
    const memoryId = randomUUID();
    const second = 'Rotate the staging box.';
    audit.insert(redactedReceipt(memoryId, ORIGINAL, REPLACEMENT));
    audit.insert(redactedReceipt(randomUUID(), 'other old', 'other new'));
    audit.insert(redactedReceipt(memoryId, REPLACEMENT, second));

    const trail = audit.findRedactionsFor(memoryId);
    expect(trail.map((r) => r.oldContentHash)).toEqual([
      computeContentHash(ORIGINAL),
      computeContentHash(REPLACEMENT),
    ]);
    expect(trail[0]!.sequence).toBeLessThan(trail[1]!.sequence);
    expect(audit.findRedactionsFor(randomUUID())).toEqual([]);
  });

  it('ignores a redacted row whose details are not a well-formed receipt', () => {
    const memoryId = randomUUID();
    audit.insert(
      AuditEvent.parse({
        id: randomUUID(),
        action: 'redacted',
        memoryId,
        tenantId: DEFAULT_TENANT,
        actor: { type: 'human', id: 'tester' },
        details: { oldContentHash: 42 },
        timestamp: FIXED_NOW,
      }),
    );
    expect(audit.findRedactionsFor(memoryId)).toEqual([]);
  });

  it('reads a candidate-copy receipt as target "candidate"', () => {
    const candidateId = randomUUID();
    audit.insert(redactedReceipt(candidateId, ORIGINAL, REPLACEMENT, 'candidate'));
    expect(audit.findRedactionsFor(candidateId)[0]!.target).toBe('candidate');
  });

  it('refuses to insert a candidate whose content is the redacted original', () => {
    audit.insert(redactedReceipt(randomUUID(), ORIGINAL, REPLACEMENT));
    expect(candidates.isRedactedContent(ORIGINAL, DEFAULT_TENANT)).toBe(true);

    const comeback = makeCandidate({ content: ORIGINAL });
    // Even with a wrong caller-supplied hash: the content itself is hashed.
    expect(() => candidates.insert(comeback, 'f'.repeat(64))).toThrow(RedactedContentReingestError);
    expect(candidates.findById(comeback.id)).toBeNull();
    expect(candidates.count()).toBe(0);
  });

  it('the refusal is a disclosure rejection and its message carries no content', () => {
    audit.insert(redactedReceipt(randomUUID(), ORIGINAL, REPLACEMENT));
    let thrown: unknown;
    try {
      candidates.insert(makeCandidate({ content: ORIGINAL }), computeContentHash(ORIGINAL));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DisclosureRejectedError);
    expect((thrown as RedactedContentReingestError).category).toBe('secret');
    expect((thrown as Error).message).not.toContain(SYNTHETIC);
    expect((thrown as Error).message).toContain('governed redaction');
  });

  it('still accepts the redacted replacement, other content and other tenants', () => {
    audit.insert(redactedReceipt(randomUUID(), ORIGINAL, REPLACEMENT));
    expect(candidates.isRedactedContent(REPLACEMENT, DEFAULT_TENANT)).toBe(false);
    expect(candidates.isRedactedContent(ORIGINAL, 'other-tenant')).toBe(false);

    candidates.insert(makeCandidate({ content: REPLACEMENT }), computeContentHash(REPLACEMENT));
    candidates.insert(
      makeCandidate({ content: ORIGINAL, tenantId: 'other-tenant' }),
      computeContentHash(ORIGINAL),
    );
    expect(candidates.count()).toBe(2);
  });
});

describe('physical scrub — the removed bytes leave the store files', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'redaction-scrub-'));
    dbPath = join(dir, 'teamkb.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** True when any of the store's files contains `needle` as raw bytes. */
  function bytesContain(needle: string): boolean {
    return storeFilesOf(dbPath).some(
      (file) => existsSync(file) && readFileSync(file).includes(Buffer.from(needle, 'utf8')),
    );
  }

  function seed(db: Database.Database): { memoryId: string; candidateId: string } {
    const candidate = makeCandidate({ content: ORIGINAL });
    new CandidateRepository(db).insert(candidate, computeContentHash(ORIGINAL));
    const memory = makeMemory({ content: ORIGINAL, candidateId: candidate.id });
    const memories = new MemoryRepository(db);
    memories.insert(memory);
    // Filler rows so the store spans many pages, like a real one.
    for (let i = 0; i < 40; i++) {
      memories.insert(makeMemory({ content: `filler memory number ${i} `.repeat(60) }));
    }
    return { memoryId: memory.id, candidateId: candidate.id };
  }

  /** Rewrite both rows the way a redaction does, without any physical scrub. */
  function rewrite(db: Database.Database, ids: { memoryId: string; candidateId: string }): void {
    const memories = new MemoryRepository(db);
    const memory = memories.findById(ids.memoryId)!;
    db.transaction(() => {
      memories.update({
        ...memory,
        content: REPLACEMENT,
        contentHash: computeContentHash(REPLACEMENT),
      });
      new CandidateRepository(db).updateContent(ids.candidateId, DEFAULT_TENANT, {
        content: REPLACEMENT,
        title: 'Rotated staging box',
      });
    })();
  }

  it('the secret is in the files before redaction (the scan can see it)', () => {
    const db = createDatabase({ path: dbPath });
    seed(db);
    db.close();
    expect(bytesContain(SYNTHETIC)).toBe(true);
    const scan = scanStoreFilesForFragments(dbPath, [SYNTHETIC]);
    expect(scan.residualFragmentIndexes).toEqual([0]);
    expect(scan.residualFiles.length).toBeGreaterThan(0);
  });

  it('a plain UPDATE alone leaves the old bytes behind — the reason the scrub exists', () => {
    const db = createDatabase({ path: dbPath });
    const ids = seed(db);
    rewrite(db, ids);
    // No row returns it any more…
    expect(findRowsContaining(db, SYNTHETIC)).toEqual([]);
    // …but the bytes are still on disk (WAL frames, FTS segments, freed cells).
    expect(bytesContain(SYNTHETIC)).toBe(true);
    db.close();
  });

  it('secure_delete + scrub removes the old text from the db, -wal and -shm bytes', () => {
    const db = createDatabase({ path: dbPath });
    const ids = seed(db);

    expect(enableSecureDelete(db)).toBe(true);
    rewrite(db, ids);
    const report = scrubFreedPages(db);

    expect(report).toEqual({ ftsRebuilt: true, walTruncated: true, vacuumed: true, errors: [] });
    const scan = scanStoreFilesForFragments(dbPath, [SYNTHETIC, 'synthetic value is']);
    expect(scan.filesScanned).toContain(dbPath);
    expect(scan.fragmentCount).toBe(2);
    expect(scan.residualFragmentIndexes).toEqual([]);
    expect(scan.residualFiles).toEqual([]);
    expect(bytesContain(SYNTHETIC)).toBe(false);

    // The FTS index no longer answers for a token of the removed text, and
    // still answers for text that was kept.
    const memories = new MemoryRepository(db);
    expect(memories.searchByText('synthetic')).toEqual([]);
    expect(memories.searchByText('staging').map((m) => m.id)).toContain(ids.memoryId);
    db.close();
    expect(bytesContain(SYNTHETIC)).toBe(false);
  });

  it('reports a blocked step instead of throwing when another connection holds the store', () => {
    const db = createDatabase({ path: dbPath });
    seed(db);
    const reader = createDatabase({ path: dbPath, readonly: true });
    // An open read transaction pins the WAL and blocks VACUUM.
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM curated_memories').get();
    db.pragma('busy_timeout = 50');

    const report = scrubFreedPages(db);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.vacuumed && report.walTruncated).toBe(false);

    reader.exec('COMMIT');
    reader.close();
    expect(scrubFreedPages(db).errors).toEqual([]);
    db.close();
  });

  it('scrub is a no-op success on a store without the FTS table', () => {
    const db = createDatabase({ path: dbPath });
    db.exec('DROP TRIGGER curated_memories_fts_insert');
    db.exec('DROP TRIGGER curated_memories_fts_update');
    db.exec('DROP TRIGGER curated_memories_fts_delete');
    db.exec('DROP TABLE curated_memories_fts');
    expect(scrubFreedPages(db).errors).toEqual([]);
    db.close();
  });

  it('finds a fragment that straddles a scan-chunk boundary', () => {
    // The scan reads 4 MiB chunks; put the needle across the first boundary and
    // a second one at the very end of the file.
    const chunk = 4 * 1024 * 1024;
    const needle = Buffer.from(SYNTHETIC, 'utf8');
    const body = Buffer.alloc(chunk * 2 + 1000, 0x2e);
    needle.copy(body, chunk - 7);
    const tail = Buffer.from('tail-marker-at-end-of-file', 'utf8');
    tail.copy(body, body.length - tail.length);
    writeFileSync(dbPath, body);

    const scan = scanStoreFilesForFragments(dbPath, [
      SYNTHETIC,
      'not-in-the-file-anywhere',
      'tail-marker-at-end-of-file',
    ]);
    expect(scan.residualFragmentIndexes).toEqual([0, 2]);
    expect(scan.residualFiles).toEqual([dbPath]);
  });

  it('skips files that do not exist and scans nothing for an empty fragment list', () => {
    const db = createDatabase({ path: dbPath });
    seed(db);
    db.close();
    const scan = scanStoreFilesForFragments(join(dir, 'missing.db'), [SYNTHETIC]);
    expect(scan).toEqual({
      filesScanned: [],
      fragmentCount: 1,
      residualFragmentIndexes: [],
      residualFiles: [],
    });
    expect(scanStoreFilesForFragments(dbPath, []).residualFiles).toEqual([]);
  });

  it('findRowsContaining names the table and id of live rows, never the text', () => {
    const db = createDatabase({ path: dbPath });
    const ids = seed(db);
    const hits = findRowsContaining(db, SYNTHETIC);
    expect(hits).toEqual(
      expect.arrayContaining([
        { table: 'curated_memories', id: ids.memoryId },
        { table: 'candidates', id: ids.candidateId },
      ]),
    );
    expect(JSON.stringify(hits)).not.toContain(SYNTHETIC);
    db.close();
  });

  it('the audit chain verifies before and after a scrub', () => {
    const db = createDatabase({ path: dbPath });
    const ids = seed(db);
    const audit = new AuditRepository(db);
    audit.insert(redactedReceipt(randomUUID(), 'a', 'b'));
    audit.insert(redactedReceipt(randomUUID(), 'c', 'd'));
    const before = verifyAuditChain(audit);
    expect(before.breaks).toEqual([]);
    const tipBefore = audit.findChainTip();

    enableSecureDelete(db);
    rewrite(db, ids);
    scrubFreedPages(db);

    const after = verifyAuditChain(audit);
    expect(after.breaks).toEqual([]);
    expect(after.totalRows).toBe(before.totalRows);
    expect(after.cleanRows).toBe(before.cleanRows);
    expect(audit.findChainTip()).toEqual(tipBefore);
    db.close();
  });
});
