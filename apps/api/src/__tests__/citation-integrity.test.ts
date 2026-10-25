import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import { getRelativePath, isExportRestricted, runExport } from '@qmd-team-intent-kb/git-exporter';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  createTestDatabase,
  ExportStateRepository,
  MemoryRepository,
} from '@qmd-team-intent-kb/store';
import { makeAuditEvent } from '@qmd-team-intent-kb/test-fixtures';

import { buildApp } from '../app.js';
import { checkPromotedCitationIntegrity } from '../services/citation-integrity.js';
import { makeCandidate } from './fixtures.js';

const TENANT = 'citation-integrity-alpha';
const OTHER_TENANT = 'citation-integrity-beta';

describe('promoted receipt → canonical memory → cited export integrity', () => {
  let work: string;
  let exportDir: string;
  let db: Database.Database;
  let app: FastifyInstance;
  let memoryRepo: MemoryRepository;
  let auditRepo: AuditRepository;
  let exportStateRepo: ExportStateRepository;
  let fixtureSequence: number;

  beforeEach(async () => {
    fixtureSequence = 0;
    work = mkdtempSync(join(tmpdir(), 'citation-integrity-'));
    exportDir = join(work, 'export');
    db = createTestDatabase();
    memoryRepo = new MemoryRepository(db);
    auditRepo = new AuditRepository(db);
    exportStateRepo = new ExportStateRepository(db);
    app = buildApp({
      db,
      silent: true,
      indexRefresher: {
        async refreshAfterPromotion(tenantId) {
          // Real promotion/export, deliberately no qmd, index or service probe.
          runExport(memoryRepo, exportStateRepo, {
            tenantId,
            outputDir: exportDir,
            targetId: `citation-test-${tenantId}`,
            // This proof supplies a converged export snapshot. Incremental
            // same-millisecond watermark freshness is tracked by 6ps.22.
            reconcile: true,
          });
          return { ok: true };
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(work, { recursive: true, force: true });
  });

  async function promote(
    category: CuratedMemory['category'] = 'reference',
    tenantId = TENANT,
  ): Promise<CuratedMemory> {
    // Random UUID text can match the canonical phone-PII classifier. Keep
    // synthetic content deterministic while real candidate IDs remain UUIDs.
    const sequence = ++fixtureSequence;
    const candidate = makeCandidate({
      tenantId,
      category,
      title: `Synthetic citation fixture ${sequence}`,
      content: `Synthetic promotion sequence ${sequence} requires inspecting the fixture ledger quarterly and retaining its receipt.`,
    });
    new CandidateRepository(db).insert(candidate, computeContentHash(candidate.content));
    const response = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/promote?tenantId=${tenantId}`,
    });
    expect(response.statusCode).toBe(200);
    const id = response.json<{ id: string }>().id;
    const memory = memoryRepo.findById(id);
    expect(memory).not.toBeNull();
    if (memory === null) throw new Error('Fixture promotion missing canonical memory');
    expect(isExportRestricted(memory)).toBe(false);
    return memory;
  }

  function check(tenantId = TENANT) {
    return checkPromotedCitationIntegrity({ tenantId, exportDir, memoryRepo, auditRepo });
  }

  function reconcile() {
    runExport(memoryRepo, exportStateRepo, {
      tenantId: TENANT,
      outputDir: exportDir,
      targetId: 'citation-reconcile',
      reconcile: true,
    });
  }

  it('checks ALL actual promoted receipts against exact category citations, without writes', async () => {
    const memories = await Promise.all(
      ['reference', 'decision', 'pattern'].map((category) =>
        promote(category as CuratedMemory['category']),
      ),
    );
    const before = db.serialize();
    const filesBefore = memories.map((memory) => {
      const file = join(exportDir, getRelativePath(memory));
      return { file, bytes: readFileSync(file), stat: lstatSync(file) };
    });
    const report = check();
    expect(report.passed).toBe(true);
    expect(report.totalPromotionCount).toBe(3);
    expect(report.eligiblePromotionCount).toBe(3);
    expect(report.checkedPromotionCount).toBe(3);
    expect(report.excludedPromotionCount).toBe(0);
    expect(report.failedPromotionCount).toBe(0);
    const collections = ['kb-guides', 'kb-decisions', 'kb-curated'];
    for (const [index, memory] of memories.entries()) {
      const receipt = auditRepo
        .findByMemoryAndTenant(memory.id, TENANT)
        .find((event) => event.action === 'promoted');
      expect(receipt).toBeDefined();
      expect(report.entries).toContainEqual({
        receiptId: receipt!.id,
        memoryId: memory.id,
        citation: `qmd://${collections[index]}/${memory.id}.md`,
        status: 'checked',
      });
      expect(receipt).not.toHaveProperty('citation');
    }
    expect(db.serialize()).toEqual(before);
    for (const { file, bytes, stat } of filesBefore) {
      expect(readFileSync(file)).toEqual(bytes);
      expect(lstatSync(file).mtimeMs).toBe(stat.mtimeMs);
      expect(lstatSync(file).ino).toBe(stat.ino);
    }
  });

  it('accepts an aliased export root while retaining the same canonical receipt mapping', async () => {
    await promote();
    const direct = check();
    const alias = join(work, 'export-alias');
    symlinkSync(exportDir, alias, 'dir');
    const aliased = checkPromotedCitationIntegrity({
      tenantId: TENANT,
      exportDir: alias,
      memoryRepo,
      auditRepo,
    });
    expect(direct.passed).toBe(true);
    expect(aliased).toEqual(direct);
  });

  it('fails when any one of multiple promoted exports is absent', async () => {
    const first = await promote();
    await promote('decision');
    const file = join(exportDir, getRelativePath(first));
    rmSync(file);
    const report = check();
    expect(report.passed).toBe(false);
    expect(report.totalPromotionCount).toBe(2);
    expect(report.checkedPromotionCount).toBe(1);
    expect(report.failedPromotionCount).toBe(1);
    expect(report.entries.find((entry) => entry.memoryId === first.id)?.code).toBe(
      'EXPORT_MISSING',
    );
    expect(() => readFileSync(file)).toThrow();
  });

  it('refuses a tenant-A receipt referring to a real tenant-B promoted memory', async () => {
    const memory = await promote('reference', OTHER_TENANT);
    auditRepo.insert(makeAuditEvent({ action: 'promoted', tenantId: TENANT, memoryId: memory.id }));
    const report = check();
    expect(report.passed).toBe(false);
    expect(report.entries[0]?.code).toBe('MEMORY_TENANT_MISMATCH');
    expect(report.entries[0]?.citation).toBeNull();
    expect(check(OTHER_TENANT).passed).toBe(true);
  });

  it.each(['tenant_id', 'id'])('rejects substituted canonical %s frontmatter', async (field) => {
    const memory = await promote();
    const file = join(exportDir, getRelativePath(memory));
    const original = readFileSync(file, 'utf8');
    const value = field === 'id' ? memory.id : TENANT;
    writeFileSync(file, original.replace(`${field}: "${value}"`, `${field}: "${randomUUID()}"`));
    const report = check();
    expect(report.passed).toBe(false);
    expect(report.entries[0]?.code).toBe('HEADER_IDENTITY_MISMATCH');
  });

  it('rejects missing frontmatter even when the filename identifies a real memory', async () => {
    const memory = await promote();
    writeFileSync(join(exportDir, getRelativePath(memory)), '# synthetic body only\n');
    expect(check().entries[0]?.code).toBe('HEADER_IDENTITY_MISMATCH');
    expect(check().passed).toBe(false);
  });

  it.each(['symlink', 'directory'])('refuses an exported %s leaf', async (kind) => {
    const memory = await promote();
    const file = join(exportDir, getRelativePath(memory));
    const outside = join(work, 'outside.md');
    const original = readFileSync(file);
    writeFileSync(outside, original);
    rmSync(file);
    if (kind === 'symlink') symlinkSync(outside, file);
    else mkdirSync(file);
    expect(check().entries[0]?.code).toBe('EXPORT_NOT_REGULAR');
    expect(check().passed).toBe(false);
    expect(readFileSync(outside)).toEqual(original);
  });

  it('refuses a symlinked collection ancestor even when it points to matching bytes', async () => {
    const memory = await promote();
    const file = join(exportDir, getRelativePath(memory));
    const original = readFileSync(file);
    const outside = join(work, 'outside-collection');
    mkdirSync(outside);
    writeFileSync(join(outside, `${memory.id}.md`), original);
    rmSync(dirname(file), { recursive: true });
    symlinkSync(outside, dirname(file));
    expect(check().entries[0]?.code).toBe('UNSAFE_EXPORT_PATH');
    expect(check().passed).toBe(false);
    expect(readdirSync(outside)).toEqual([`${memory.id}.md`]);
    expect(readFileSync(join(outside, `${memory.id}.md`))).toEqual(original);
  });

  it('honors intentional sensitivity and audience exclusions without vacuous success', async () => {
    const confidential = await promote();
    const narrow = await promote('decision');
    memoryRepo.update({ ...confidential, sensitivity: 'confidential' });
    memoryRepo.update({ ...narrow, metadata: { ...narrow.metadata, audience: 'admins' } });
    reconcile();
    const report = check();
    expect(report.passed).toBe(false);
    expect(report.totalPromotionCount).toBe(2);
    expect(report.excludedPromotionCount).toBe(2);
    expect(report.eligiblePromotionCount).toBe(0);
    expect(report.checkedPromotionCount).toBe(0);
    expect(report.entries.every((entry) => entry.code === 'EXPORT_RESTRICTED')).toBe(true);
    await promote('pattern');
    expect(check().passed).toBe(true);
    expect(check().excludedPromotionCount).toBe(2);
    expect(check().checkedPromotionCount).toBe(1);
  });

  it('resolves a retired promoted identity through the canonical archive mapping', async () => {
    const memory = await promote();
    expect(memoryRepo.updateLifecycle(memory.id, 'archived', new Date().toISOString())).toBe(true);
    reconcile();
    const report = check();
    expect(report.passed).toBe(true);
    expect(report.entries[0]?.citation).toBe(`qmd://kb-archive/${memory.id}.md`);
    expect(report.checkedPromotionCount).toBe(1);
  });

  it('resolves a promoted bulk-import identity through the canonical bulk mapping', async () => {
    const memory = await promote();
    expect(memoryRepo.update({ ...memory, source: 'bulk_import' })).toBe(true);
    reconcile();
    const report = check();
    expect(report.passed).toBe(true);
    expect(report.entries[0]?.citation).toBe(`qmd://kb-bulk/${memory.id}.md`);
    expect(report.checkedPromotionCount).toBe(1);
  });

  it('rejects a repository returning a foreign-tenant receipt without resolving its memory', async () => {
    const memory = await promote();
    const receipt = auditRepo.findByTenantAndAction(TENANT, 'promoted')[0]!;
    let lookedUp = false;
    const report = checkPromotedCitationIntegrity({
      tenantId: TENANT,
      exportDir,
      auditRepo: { findByTenantAndAction: () => [{ ...receipt, tenantId: OTHER_TENANT }] },
      memoryRepo: {
        findById: () => {
          lookedUp = true;
          return memory;
        },
      },
    });
    expect(report.passed).toBe(false);
    expect(report.entries[0]?.code).toBe('RECEIPT_TENANT_MISMATCH');
    expect(report.failedPromotionCount).toBe(1);
    expect(lookedUp).toBe(false);
  });

  it('rejects a repository returning a different canonical identity for the requested ID', async () => {
    const memory = await promote();
    const report = checkPromotedCitationIntegrity({
      tenantId: TENANT,
      exportDir,
      auditRepo,
      memoryRepo: { findById: () => ({ ...memory, id: randomUUID() }) },
    });
    expect(report.passed).toBe(false);
    expect(report.entries[0]?.code).toBe('MEMORY_ID_MISMATCH');
    expect(report.entries[0]?.citation).toBeNull();
    expect(report.totalPromotionCount).toBe(
      report.checkedPromotionCount + report.excludedPromotionCount + report.failedPromotionCount,
    );
  });

  it('refuses malformed path identity supplied by a repository seam without opening outside files', async () => {
    const memory = await promote();
    const receipt = auditRepo.findByTenantAndAction(TENANT, 'promoted')[0]!;
    const outside = join(work, 'outside.md');
    writeFileSync(outside, 'outside sentinel');
    // Deliberately malformed read results, never persisted as schema-invalid rows.
    const malformedId = '../outside';
    const report = checkPromotedCitationIntegrity({
      tenantId: TENANT,
      exportDir,
      auditRepo: { findByTenantAndAction: () => [{ ...receipt, memoryId: malformedId }] },
      memoryRepo: { findById: () => ({ ...memory, id: malformedId }) },
    });
    expect(report.passed).toBe(false);
    expect(report.entries[0]?.code).toBe('UNRESOLVABLE_CITATION');
    expect(report.failedPromotionCount).toBe(1);
    expect(readFileSync(outside, 'utf8')).toBe('outside sentinel');
  });

  it('does not pass an empty promotion snapshot', () => {
    const report = check();
    expect(report.passed).toBe(false);
    expect(report.totalPromotionCount).toBe(0);
    expect(report.entries).toEqual([]);
  });

  it('reports an unresolved canonical memory without inventing a citation', async () => {
    await promote();
    const report = checkPromotedCitationIntegrity({
      tenantId: TENANT,
      exportDir,
      auditRepo,
      memoryRepo: { findById: () => null },
    });
    expect(report.passed).toBe(false);
    expect(report.entries[0]?.code).toBe('MEMORY_MISSING');
    expect(report.entries[0]?.citation).toBeNull();
  });
});
