/**
 * Repository-layer disclosure / secret choke-point tests
 * (Epic 0, compile-then-govern-c5k).
 *
 * `CandidateRepository.insert()` is the single SQL INSERT every candidate write
 * path crosses (API intake, curator bulk-import, spool-intake / ICO ingest, MCP
 * propose→spool, promotion re-scan). Three of those paths previously bypassed the
 * api-layer disclosure filter entirely. These tests prove the gate now lives at
 * the repository layer: a candidate carrying PII, comp, or a secret is REJECTED
 * and never lands in the table, regardless of which method built it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DisclosureRejectedError } from '@qmd-team-intent-kb/common';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../database.js';
import { CandidateRepository } from '../repositories/candidate-repository.js';
import { makeCandidate } from './fixtures.js';

describe('CandidateRepository.insert — disclosure / secret choke point', () => {
  let db: Database.Database;
  let repo: CandidateRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new CandidateRepository(db);
  });

  it('rejects PII in content and never writes the row', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'employee ssn is 123-45-6789 on file',
    });
    expect(() => repo.insert(candidate, contentHash)).toThrow(DisclosureRejectedError);
    // The choke point fires BEFORE the INSERT — the table stays empty.
    expect(repo.count()).toBe(0);
    expect(repo.findById(candidate.id)).toBeNull();
  });

  it('rejects compensation material in content', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'his base salary and signing bonus were leaked here',
    });
    expect(() => repo.insert(candidate, contentHash)).toThrow(DisclosureRejectedError);
    expect(repo.count()).toBe(0);
  });

  it('rejects a credential / secret in content (gitleaks-class)', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'left a token in the notes: ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz12',
    });
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DisclosureRejectedError);
    expect((err as DisclosureRejectedError).category).toBe('secret');
    expect(repo.count()).toBe(0);
  });

  it('rejects PII that appears only in the title', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'totally clean technical body',
      title: 'DOB: 1990-01-01 (do not store)',
    });
    expect(() => repo.insert(candidate, contentHash)).toThrow(DisclosureRejectedError);
    expect(repo.count()).toBe(0);
  });

  it('rejects PII that appears only in a tag (SSN-format tag passes Zod but trips the gate)', () => {
    // The Tag schema permits lowercase alphanumerics + hyphens, so an SSN-format
    // value `123-45-6789` is a structurally VALID tag — yet it is PII and must be
    // rejected by the choke point.
    const { candidate, contentHash } = makeCandidate({
      content: 'clean body',
      title: 'clean title',
      metadata: { filePaths: [], tags: ['ok', '123-45-6789'] },
    });
    expect(() => repo.insert(candidate, contentHash)).toThrow(DisclosureRejectedError);
    expect(repo.count()).toBe(0);
  });

  it('rejects a homoglyph-obfuscated keyword (defeats naive ASCII regex)', () => {
    // Leading "s" is U+0455 Cyrillic dze; folds to "salary" before scanning.
    const { candidate, contentHash } = makeCandidate({
      content: 'his ѕalary was disclosed in the channel',
    });
    expect(() => repo.insert(candidate, contentHash)).toThrow(DisclosureRejectedError);
    expect(repo.count()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // metadata_json / author_json free-text surfaces (compile-then-govern-c5k.1).
  // These fields are serialized into the row but previously bypassed the gate:
  // only content/title/tags were scanned. A candidate carrying PII in
  // metadata.projectContext, a secret in metadata.repoUrl, comp in author.name,
  // PII in author.id, or a secret in a filePaths entry must now be REJECTED at
  // the repository choke point before the INSERT. Content/title stay clean so the
  // ONLY field tripping the gate is the newly-scanned one.
  // ---------------------------------------------------------------------------

  it('rejects PII (SSN) hidden in metadata.projectContext', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'clean technical body',
      title: 'clean title',
      metadata: { filePaths: [], tags: [], projectContext: 'onboarding ssn 123-45-6789 ticket' },
    });
    expect(() => repo.insert(candidate, contentHash)).toThrow(DisclosureRejectedError);
    expect(repo.count()).toBe(0);
    expect(repo.findById(candidate.id)).toBeNull();
  });

  it('rejects a credential / secret hidden in metadata.repoUrl', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'clean technical body',
      title: 'clean title',
      // Token split with concatenation so the contiguous secret shape never
      // appears in source (defeats push-protection + our own scanner).
      metadata: {
        filePaths: [],
        tags: [],
        repoUrl: 'https://ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz12@github.com/x/y',
      },
    });
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DisclosureRejectedError);
    expect((err as DisclosureRejectedError).category).toBe('secret');
    expect(repo.count()).toBe(0);
  });

  it('rejects a secret hidden in a metadata.filePaths entry', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'clean technical body',
      title: 'clean title',
      metadata: {
        filePaths: ['src/ok.ts', 'notes/sk_live_' + 'abcdefghijklmnopqrstuvwx.txt'],
        tags: [],
      },
    });
    expect(() => repo.insert(candidate, contentHash)).toThrow(DisclosureRejectedError);
    expect(repo.count()).toBe(0);
  });

  it('rejects compensation material hidden in author.name', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'clean technical body',
      title: 'clean title',
      author: { type: 'human', id: 'u-1', name: 'salary leak via display name' },
    });
    expect(() => repo.insert(candidate, contentHash)).toThrow(DisclosureRejectedError);
    expect(repo.count()).toBe(0);
  });

  it('rejects PII (SSN) hidden in author.id', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'clean technical body',
      title: 'clean title',
      author: { type: 'human', id: '123-45-6789' },
    });
    expect(() => repo.insert(candidate, contentHash)).toThrow(DisclosureRejectedError);
    expect(repo.count()).toBe(0);
  });

  it('rejects a homoglyph-obfuscated SSN token in metadata.branch (normalization path)', () => {
    // U+0405 (Cyrillic capital dze) + SN → SSN after homoglyph fold.
    const { candidate, contentHash } = makeCandidate({
      content: 'clean technical body',
      title: 'clean title',
      metadata: { filePaths: [], tags: [], branch: 'feat/ЅSN-handling' },
    });
    expect(() => repo.insert(candidate, contentHash)).toThrow(DisclosureRejectedError);
    expect(repo.count()).toBe(0);
  });

  it('allows clean metadata free-text + author through unchanged', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'always return Result<T, E> from the kernel for fallible ops',
      title: 'clean title',
      metadata: {
        filePaths: ['src/kernel.ts'],
        tags: ['kernel'],
        projectContext: 'governed brain control plane',
        repoUrl: 'https://github.com/jeremylongshore/qmd-team-intent-kb',
        branch: 'main',
        language: 'typescript',
      },
      author: { type: 'human', id: 'jeremy', name: 'Jeremy Longshore' },
    });
    expect(() => repo.insert(candidate, contentHash)).not.toThrow();
    expect(repo.count()).toBe(1);
    expect(repo.findById(candidate.id)?.id).toBe(candidate.id);
  });

  it('does NOT echo the matched value in the error message (PII non-leak)', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'leak 123-45-6789 here',
    });
    let message = '';
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('123-45-6789');
  });

  it('allows clean technical content through unchanged', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'always return Result<T, E> from the kernel for fallible ops',
    });
    expect(() => repo.insert(candidate, contentHash)).not.toThrow();
    expect(repo.count()).toBe(1);
    expect(repo.findById(candidate.id)?.id).toBe(candidate.id);
  });

  it('allows client revenue / deal value (not flagged as compensation)', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'the deal value is $50k for this client engagement',
    });
    expect(() => repo.insert(candidate, contentHash)).not.toThrow();
    expect(repo.count()).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // tenant_id free-text surface (compile-then-govern-c5k.1).
  //
  // tenant_id is a persisted free-text column (TenantId = NonEmptyString,
  // unconstrained). It was absent from the old hand-enumerated scan list, so an
  // adversarial probe drove the REAL insert() and landed an SSN-shaped and a
  // comp-shaped tenant_id in durable state (COUNT=1, REJECTED=false). insert()
  // callers other than the tenant-bound API path (bulk import, spool, ICO ingest)
  // can carry an untrusted tenant_id, so the choke point must scan it. content /
  // title stay clean so the ONLY field tripping the gate is tenant_id. Secret-
  // shaped literals are split with concatenation so the contiguous shape never
  // appears in source.
  // ---------------------------------------------------------------------------

  it('rejects an SSN-shaped tenant_id and never writes the row', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'clean technical body',
      title: 'clean title',
      tenantId: '123-45-' + '6789',
    });
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DisclosureRejectedError);
    expect((err as DisclosureRejectedError).category).toBe('pii');
    // The choke point fires BEFORE the INSERT — the table stays empty.
    expect(repo.count()).toBe(0);
    expect(repo.findById(candidate.id)).toBeNull();
  });

  it('rejects a compensation-shaped tenant_id and never writes the row', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'clean technical body',
      title: 'clean title',
      tenantId: 'team-salary-' + '90000',
    });
    let err: unknown;
    try {
      repo.insert(candidate, contentHash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DisclosureRejectedError);
    expect((err as DisclosureRejectedError).category).toBe('compensation');
    expect(repo.count()).toBe(0);
    expect(repo.findById(candidate.id)).toBeNull();
  });

  it('allows a clean tenant_id through unchanged', () => {
    const { candidate, contentHash } = makeCandidate({
      content: 'always return Result<T, E> from the kernel for fallible ops',
      title: 'clean title',
      tenantId: 'acme-prod',
    });
    expect(() => repo.insert(candidate, contentHash)).not.toThrow();
    expect(repo.count()).toBe(1);
    expect(repo.findById(candidate.id)?.tenantId).toBe('acme-prod');
  });
});
