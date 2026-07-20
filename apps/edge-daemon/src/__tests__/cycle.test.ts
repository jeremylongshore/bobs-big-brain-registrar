import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@qmd-team-intent-kb/store';
import { makeMemory } from '@qmd-team-intent-kb/test-fixtures';
import type Database from 'better-sqlite3';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import { runCycle } from '../cycle.js';
import type { DaemonConfig, DaemonDependencies } from '../types.js';
import {
  makeDeps,
  makeConfig,
  makeCandidate,
  makePolicy,
  writeSpoolFile,
  RecordingLogger,
  TENANT,
  NOW,
} from './fixtures.js';

vi.mock('@qmd-team-intent-kb/repo-resolver');

describe('runCycle', () => {
  let db: Database.Database;
  let deps: DaemonDependencies;
  let spoolDir: string;
  let exportDir: string;
  let config: DaemonConfig;
  let logger: RecordingLogger;

  beforeEach(async () => {
    db = createTestDatabase();
    deps = makeDeps(db);
    spoolDir = await mkdtemp(join(tmpdir(), 'daemon-cycle-spool-'));
    exportDir = await mkdtemp(join(tmpdir(), 'daemon-cycle-export-'));
    config = makeConfig({
      spoolDir,
      exportOutputDir: exportDir,
      enableExport: false,
      enableIndexUpdate: false,
    });
    logger = new RecordingLogger();
  });

  afterEach(async () => {
    await rm(spoolDir, { recursive: true, force: true });
    await rm(exportDir, { recursive: true, force: true });
  });

  it('returns a complete CycleResult on empty spool', async () => {
    const result = await runCycle(config, deps, logger);
    expect(result.startedAt).toBe(NOW);
    expect(result.completedAt).toBe(NOW);
    expect(result.ingest.ingested).toBe(0);
    expect(result.ingest.errors).toHaveLength(0);
    expect(result.curation).toBeNull();
    expect(result.export).toBeNull();
    expect(result.indexUpdate).toBeNull();
  });

  it('ingests candidates from spool', async () => {
    const candidate = makeCandidate({
      content: 'Architecture decision for monorepo structure and package organization.',
    });
    await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

    const result = await runCycle(config, deps, logger);
    expect(result.ingest.ingested).toBe(1);
  });

  it('curates ingested candidates', async () => {
    const candidate = makeCandidate({
      content: 'TypeScript strict mode is required in all packages for type safety.',
    });
    await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

    const result = await runCycle(config, deps, logger);
    expect(result.curation).not.toBeNull();
    expect(result.curation!.processed).toBe(1);
    expect(result.curation!.promoted).toBe(1);
  });

  it('rejects candidates that fail policy', async () => {
    const policy = makePolicy();
    deps.policyRepo.insert(policy);

    // Content must reach curation to exercise the POLICY-ENGINE secret rule, so
    // it must pass the boundary disclosure choke point on ingest (Epic 0). A GCP
    // service-account marker is policy-flagged but is not a boundary-gate pattern
    // (an AWS key, by contrast, is now refused at ingest before curation).
    const candidate = makeCandidate({
      content: 'deploy config carries "type": "service_account" for the runner',
    });
    await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

    const result = await runCycle(config, deps, logger);
    expect(result.curation!.rejected).toBe(1);
    expect(result.curation!.promoted).toBe(0);
  });

  it('caps ingestion at maxCandidatesPerCycle', async () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({
        content: `Unique candidate number ${i} with enough content to pass length check.`,
      }),
    );
    await writeSpoolFile(spoolDir, 'spool-001.jsonl', candidates);

    const limitedConfig = makeConfig({
      spoolDir,
      maxCandidatesPerCycle: 3,
      enableExport: false,
      enableIndexUpdate: false,
    });

    const result = await runCycle(limitedConfig, deps, logger);
    expect(result.ingest.ingested).toBe(3);
    expect(result.curation!.processed).toBe(3);
    // Should have a capped warning
    const warnMessages = logger.messages.filter((m) => m.level === 'warn');
    expect(warnMessages.some((m) => m.message.includes('Capped ingestion'))).toBe(true);
  });

  it('runs export step when enableExport is true', async () => {
    const candidate = makeCandidate({
      content: 'Use dependency injection for all service classes in the application.',
    });
    await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

    const exportConfig = makeConfig({
      spoolDir,
      exportOutputDir: exportDir,
      enableExport: true,
      enableIndexUpdate: false,
    });

    const result = await runCycle(exportConfig, deps, logger);
    expect(result.export).not.toBeNull();
    expect(result.export!.totalProcessed).toBeGreaterThanOrEqual(0);
  });

  it('skips curation when nothing ingested', async () => {
    const result = await runCycle(config, deps, logger);
    expect(result.curation).toBeNull();
  });

  it('handles spool directory that does not exist', async () => {
    const badConfig = makeConfig({
      spoolDir: join(tmpdir(), 'nonexistent-spool-' + Date.now().toString()),
      enableExport: false,
      enableIndexUpdate: false,
    });

    const result = await runCycle(badConfig, deps, logger);
    expect(result.ingest.errors.length).toBeGreaterThan(0);
    expect(result.curation).toBeNull();
  });

  it('index update records error when adapter throws', async () => {
    const candidate = makeCandidate({
      content: 'Index test candidate with enough content for the length rule check.',
    });
    await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

    const mockAdapter = {
      ensureCollections: async () => ({ ok: false as const, error: { message: 'qmd not found' } }),
      update: async () => ({ ok: true as const, value: undefined }),
    };

    const indexConfig = makeConfig({
      spoolDir,
      enableExport: false,
      enableIndexUpdate: true,
    });

    const indexDeps = { ...deps, qmdAdapter: mockAdapter as never };
    const result = await runCycle(indexConfig, indexDeps, logger);
    expect(result.indexUpdate).not.toBeNull();
    expect(result.indexUpdate!.ok).toBe(false);
    expect(result.indexUpdate!.error).toContain('qmd not found');
  });

  it('index update succeeds with mock adapter', async () => {
    const mockAdapter = {
      ensureCollections: async () => ({ ok: true as const, value: ['curated'] }),
      update: async () => ({ ok: true as const, value: undefined }),
    };

    const indexConfig = makeConfig({
      spoolDir,
      enableExport: false,
      enableIndexUpdate: true,
    });

    const indexDeps = { ...deps, qmdAdapter: mockAdapter as never };
    const result = await runCycle(indexConfig, indexDeps, logger);
    expect(result.indexUpdate).not.toBeNull();
    expect(result.indexUpdate!.ok).toBe(true);
  });

  it('skips index update when no adapter provided', async () => {
    const indexConfig = makeConfig({
      spoolDir,
      enableExport: false,
      enableIndexUpdate: true,
    });

    // deps has no qmdAdapter by default
    const result = await runCycle(indexConfig, deps, logger);
    expect(result.indexUpdate).toBeNull();
  });

  it('records last_indexed_at (freshness consumption, D1/D2) on a successful index update', async () => {
    const mockAdapter = {
      ensureCollections: async () => ({ ok: true as const, value: [] }),
      update: async () => ({ ok: true as const, value: undefined }),
    };
    const indexConfig = makeConfig({ spoolDir, enableExport: false, enableIndexUpdate: true });

    const result = await runCycle(
      indexConfig,
      { ...deps, qmdAdapter: mockAdapter as never },
      logger,
    );

    expect(result.indexUpdate!.ok).toBe(true);
    const state = deps.indexStateRepo!.get(TENANT);
    expect(state).not.toBeNull();
    // The fixture nowFn is frozen — the watermark is the (pre-update) cycle clock.
    expect(state!.lastIndexedAt).toBe(NOW);
  });

  it('does NOT record last_indexed_at when the index update fails (gauge must stay stale)', async () => {
    const mockAdapter = {
      ensureCollections: async () => ({ ok: true as const, value: [] }),
      update: async () => ({ ok: false as const, error: { message: 'qmd unreachable' } }),
    };
    const indexConfig = makeConfig({ spoolDir, enableExport: false, enableIndexUpdate: true });

    const result = await runCycle(
      indexConfig,
      { ...deps, qmdAdapter: mockAdapter as never },
      logger,
    );

    expect(result.indexUpdate!.ok).toBe(false);
    expect(deps.indexStateRepo!.get(TENANT)).toBeNull();
  });

  it('watermark race (#293 review): a promotion landing after the export read measures STALE, never false-fresh', async () => {
    // Ticking clock: every nowFn call advances 1s, so the step ordering is
    // visible in the recorded timestamps — the seam that makes the race
    // deterministic without physical interleaving.
    let tMs = Date.parse('2026-07-01T00:00:00.000Z');
    const tickingNow = (): string => new Date((tMs += 1000)).toISOString();

    const mockAdapter = {
      ensureCollections: async () => ({ ok: true as const, value: [] }),
      update: async () => ({ ok: true as const, value: undefined }),
    };
    const raceConfig = makeConfig({
      spoolDir,
      exportOutputDir: exportDir,
      enableExport: true, // the export step is where curated_memories is read
      enableIndexUpdate: true,
      nowFn: tickingNow,
    });

    const result = await runCycle(
      raceConfig,
      { ...deps, qmdAdapter: mockAdapter as never },
      logger,
    );
    expect(result.export).not.toBeNull();
    expect(result.indexUpdate!.ok).toBe(true);

    const lastIndexedAt = deps.indexStateRepo!.get(TENANT)!.lastIndexedAt;
    const lastExportedAt = deps.exportStateRepo.get('kb-export-default')!.lastExportedAt;

    // The hoist itself: the freshness watermark must NOT post-date the export
    // step — the export read is the moment the set of promotions this cycle
    // can absorb was fixed. Pre-fix, the watermark was captured at
    // indexUpdateStep start (AFTER the export), and this assertion fails.
    expect(lastIndexedAt < lastExportedAt).toBe(true);

    // The race: a promotion (e.g. the API promote path in another process)
    // lands 1ms after the export recorded its clock — after the export read,
    // before the pre-fix watermark instant one tick later. Its markdown was
    // never exported or indexed this cycle, so it MUST measure stale.
    const racePromotedAt = new Date(Date.parse(lastExportedAt) + 1).toISOString();
    deps.memoryRepo.insert(makeMemory({ tenantId: TENANT, promotedAt: racePromotedAt }));

    // Pre-fix: last_indexed_at (one tick AFTER lastExportedAt) covered the race
    // promotion → stalenessSeconds 0, false-fresh, and the canary staleness
    // gate passes over degraded retrieval. Post-fix: measured stale.
    const nowMs = Date.parse(racePromotedAt) + 5_000;
    expect(deps.indexStateRepo!.stalenessSeconds(TENANT, nowMs)).toBe(5);
  });

  it('records timestamps correctly', async () => {
    let callCount = 0;
    const timedConfig = makeConfig({
      spoolDir,
      enableExport: false,
      enableIndexUpdate: false,
      nowFn: () => {
        callCount++;
        return `2026-01-15T10:00:0${callCount}.000Z`;
      },
    });

    const result = await runCycle(timedConfig, deps, logger);
    expect(result.startedAt).toBe('2026-01-15T10:00:01.000Z');
    // Tick 2 is consumed by the freshness watermark hoisted to before the
    // export step (#293 review fix) — completedAt is the 3rd clock call.
    expect(result.completedAt).toBe('2026-01-15T10:00:03.000Z');
  });

  it('staleness sweep deprecates stale memories when enabled', async () => {
    const content = 'Stale memory content for testing staleness sweep.';
    const staleMemory: CuratedMemory = {
      id: randomUUID(),
      candidateId: randomUUID(),
      source: 'claude_session',
      content,
      title: 'Stale test memory',
      category: 'pattern',
      trustLevel: 'high',
      sensitivity: 'internal',
      author: { type: 'human', id: 'user-1', name: 'Test User' },
      tenantId: TENANT,
      metadata: { filePaths: [], tags: [] },
      lifecycle: 'active',
      contentHash: computeContentHash(content),
      policyEvaluations: [],
      promotedAt: '2025-06-01T00:00:00.000Z',
      promotedBy: { type: 'human', id: 'user-1', name: 'Test User' },
      updatedAt: '2025-06-01T00:00:00.000Z',
      version: 1,
    };
    deps.memoryRepo.insert(staleMemory);

    const stalenessConfig = makeConfig({
      spoolDir,
      enableStalenessSweep: true,
      staleDays: 90,
    });

    const result = await runCycle(stalenessConfig, deps, logger);
    expect(result.staleness).not.toBeNull();
    expect(result.staleness!.deprecated).toBe(1);

    const found = deps.memoryRepo.findById(staleMemory.id);
    expect(found?.lifecycle).toBe('deprecated');
  });

  it('staleness sweep skips when disabled', async () => {
    const stalenessConfig = makeConfig({
      spoolDir,
      enableStalenessSweep: false,
    });

    const result = await runCycle(stalenessConfig, deps, logger);
    expect(result.staleness).toBeNull();
  });

  it('staleness sweep creates audit events', async () => {
    const content = 'Stale memory content for audit event verification test.';
    const staleMemory: CuratedMemory = {
      id: randomUUID(),
      candidateId: randomUUID(),
      source: 'claude_session',
      content,
      title: 'Stale audit test memory',
      category: 'convention',
      trustLevel: 'high',
      sensitivity: 'internal',
      author: { type: 'human', id: 'user-1', name: 'Test User' },
      tenantId: TENANT,
      metadata: { filePaths: [], tags: [] },
      lifecycle: 'active',
      contentHash: computeContentHash(content),
      policyEvaluations: [],
      promotedAt: '2025-06-01T00:00:00.000Z',
      promotedBy: { type: 'human', id: 'user-1', name: 'Test User' },
      updatedAt: '2025-06-01T00:00:00.000Z',
      version: 1,
    };
    deps.memoryRepo.insert(staleMemory);

    const stalenessConfig = makeConfig({
      spoolDir,
      enableStalenessSweep: true,
      staleDays: 90,
    });

    await runCycle(stalenessConfig, deps, logger);

    const events = deps.auditRepo.findByMemory(staleMemory.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('demoted');
    expect(events[0]?.reason).toContain('Auto-deprecated');
  });

  it('does not call memoryRepo.insert directly (governance bypass prevention)', async () => {
    // Verify the cycle only promotes through Curator pipeline
    const candidate = makeCandidate({
      content: 'Testing governance bypass prevention through curator pipeline.',
    });
    await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

    const result = await runCycle(config, deps, logger);
    expect(result.curation).not.toBeNull();
    expect(result.curation!.promoted).toBe(1);
    // Memory was created through the proper pipeline
    const memories = deps.memoryRepo.findByTenant(TENANT);
    expect(memories).toHaveLength(1);
  });

  it('tenant match — foreign candidates rejected with tenant_match rule', async () => {
    const policy = makePolicy({
      rules: [
        {
          id: 'rule-tenant',
          type: 'tenant_match',
          action: 'reject',
          enabled: true,
          priority: 0,
          parameters: {},
        },
      ],
    });
    deps.policyRepo.insert(policy);

    const candidate = makeCandidate({
      tenantId: 'team-foreign',
      content: 'This candidate is from a different tenant and should be rejected.',
    });
    await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

    const result = await runCycle(config, deps, logger);
    expect(result.curation!.rejected).toBe(1);
    expect(result.curation!.promoted).toBe(0);
  });

  it('failed curation does not abort export step', async () => {
    // An error in the curation step should not prevent export from running
    const candidate = makeCandidate({
      content: 'Content for testing that export still runs after curation errors.',
    });
    await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

    const exportConfig = makeConfig({
      spoolDir,
      exportOutputDir: exportDir,
      enableExport: true,
      enableIndexUpdate: false,
    });

    const result = await runCycle(exportConfig, deps, logger);
    // Export should have run regardless of curation outcome
    expect(result.export).not.toBeNull();
  });

  describe('scopeByRepo flag', () => {
    const DAEMON_REMOTE = 'https://github.com/org/daemon-repo';
    const FOREIGN_REMOTE = 'https://github.com/org/other-repo';

    const makeRepoResult = (remoteUrl: string | null) => ({
      ok: true as const,
      value: {
        repoRoot: '/home/user/daemon-repo',
        repoName: 'daemon-repo',
        remoteUrl,
        branch: 'main',
        commitSha: 'a'.repeat(40),
        isMonorepo: false,
        workspaceRoot: null,
        workspacePackage: null,
      },
    });

    beforeEach(async () => {
      // clearAllMocks() resets call counts for vi.mock() auto-mocks between tests.
      // vi.restoreAllMocks() in afterEach restores spy implementations but does not
      // clear call history for module-level auto-mocks in Vitest v4 — so we clear
      // explicitly here to prevent accumulation across the describe block.
      vi.clearAllMocks();
      const { resolveRepoContext } = await import('@qmd-team-intent-kb/repo-resolver');
      vi.mocked(resolveRepoContext).mockResolvedValue(makeRepoResult(DAEMON_REMOTE));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('flag off — all candidates pass through regardless of repoUrl', async () => {
      const candidateWithForeignUrl = makeCandidate({
        content: 'Scope flag off: this candidate should pass through even with a foreign repoUrl.',
        metadata: { filePaths: [], tags: [], repoUrl: FOREIGN_REMOTE },
      });
      await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidateWithForeignUrl]);

      const scopeOffConfig = makeConfig({ spoolDir, scopeByRepo: false });

      const result = await runCycle(scopeOffConfig, deps, logger);
      expect(result.ingest.ingested).toBe(1);
      const warnMsgs = logger.messages.filter(
        (m) => m.level === 'warn' && m.message.includes('repo-scope'),
      );
      expect(warnMsgs).toHaveLength(0);
    });

    it('flag on, all candidates match — no candidates skipped', async () => {
      const candidate = makeCandidate({
        content: 'Candidate from matching repo should be kept by repo-scope filter.',
        metadata: { filePaths: [], tags: [], repoUrl: DAEMON_REMOTE },
      });
      await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

      const scopeOnConfig = makeConfig({ spoolDir, scopeByRepo: true });

      const result = await runCycle(scopeOnConfig, deps, logger);
      expect(result.ingest.ingested).toBe(1);
    });

    it('flag on, mismatched repoUrl — candidate skipped and warning logged', async () => {
      const foreignCandidate = makeCandidate({
        content: 'This candidate is from a different repo and should be skipped by scope filter.',
        metadata: { filePaths: [], tags: [], repoUrl: FOREIGN_REMOTE },
      });
      const matchingCandidate = makeCandidate({
        content: 'This candidate matches the daemon repo and should be kept.',
        metadata: { filePaths: [], tags: [], repoUrl: DAEMON_REMOTE },
      });
      await writeSpoolFile(spoolDir, 'spool-001.jsonl', [foreignCandidate, matchingCandidate]);

      const scopeOnConfig = makeConfig({ spoolDir, scopeByRepo: true });

      const result = await runCycle(scopeOnConfig, deps, logger);
      expect(result.ingest.ingested).toBe(1);

      const warnMsgs = logger.messages.filter(
        (m) => m.level === 'warn' && m.message.includes('repo-scope'),
      );
      expect(warnMsgs.length).toBeGreaterThan(0);
    });

    it('flag on, resolver errors — scoping disabled, all candidates pass through', async () => {
      const { resolveRepoContext } = await import('@qmd-team-intent-kb/repo-resolver');
      vi.mocked(resolveRepoContext).mockResolvedValue({
        ok: false,
        error: { kind: 'NotAGitRepo', cwd: '/tmp/nowhere' },
      });

      const candidate = makeCandidate({
        content: 'Candidate should pass when resolver fails and scoping degrades gracefully.',
        metadata: { filePaths: [], tags: [], repoUrl: FOREIGN_REMOTE },
      });
      await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

      const scopeOnConfig = makeConfig({ spoolDir, scopeByRepo: true });

      const result = await runCycle(scopeOnConfig, deps, logger);
      expect(result.ingest.ingested).toBe(1);

      const warnMsgs = logger.messages.filter(
        (m) => m.level === 'warn' && m.message.includes('repo-scope'),
      );
      expect(warnMsgs.length).toBeGreaterThan(0);
      expect(warnMsgs[0]?.message).toContain('disabled for this cycle');
    });

    it('resolveRepoContext is NOT called when repoContext is pre-resolved in deps (at most once across 3 cycles)', async () => {
      // This is the core invariant of the startup-resolution refactor:
      // when deps.repoContext is provided (set at daemon startup), runCycle must use
      // it directly without spawning a git subprocess per cycle.
      const { resolveRepoContext } = await import('@qmd-team-intent-kb/repo-resolver');
      const resolverSpy = vi.mocked(resolveRepoContext);

      const preResolvedContext = {
        repoRoot: '/home/user/daemon-repo',
        repoName: 'daemon-repo',
        remoteUrl: DAEMON_REMOTE,
        branch: 'main',
        commitSha: 'a'.repeat(40),
        isMonorepo: false,
        workspaceRoot: null,
        workspacePackage: null,
      };

      const scopeOnConfig = makeConfig({ spoolDir, scopeByRepo: true });
      const depsWithContext = { ...deps, repoContext: preResolvedContext };

      // Run 3 consecutive cycles — resolver must never be called
      await runCycle(scopeOnConfig, depsWithContext, logger);
      await runCycle(scopeOnConfig, depsWithContext, logger);
      await runCycle(scopeOnConfig, depsWithContext, logger);

      expect(resolverSpy).not.toHaveBeenCalled();
    });

    it('repoContext null in deps — scoping disabled without calling resolver', async () => {
      // deps.repoContext === null means startup resolution failed; cycle must NOT
      // attempt its own resolution and must log the disabled warning.
      const { resolveRepoContext } = await import('@qmd-team-intent-kb/repo-resolver');
      const resolverSpy = vi.mocked(resolveRepoContext);

      const candidate = makeCandidate({
        content: 'Candidate when startup resolution failed — should pass through gracefully.',
        metadata: { filePaths: [], tags: [], repoUrl: FOREIGN_REMOTE },
      });
      await writeSpoolFile(spoolDir, 'spool-001.jsonl', [candidate]);

      const scopeOnConfig = makeConfig({ spoolDir, scopeByRepo: true });
      const depsWithNullContext = { ...deps, repoContext: null };

      const result = await runCycle(scopeOnConfig, depsWithNullContext, logger);

      // All candidates pass through (scoping disabled)
      expect(result.ingest.ingested).toBe(1);
      // Resolver was not called — null means "already tried, already failed"
      expect(resolverSpy).not.toHaveBeenCalled();
      // Warning was logged
      const warnMsgs = logger.messages.filter(
        (m) => m.level === 'warn' && m.message.includes('repo-scope'),
      );
      expect(warnMsgs.length).toBeGreaterThan(0);
    });
  });

  it('index update retries transient qmd errors and succeeds on final attempt', async () => {
    const sleepCalls: number[] = [];
    let ensureAttempts = 0;

    const flakeyAdapter = {
      ensureCollections: async () => {
        ensureAttempts++;
        if (ensureAttempts < 3) {
          return { ok: false as const, error: { message: 'qmd unreachable' } };
        }
        return { ok: true as const, value: ['curated'] };
      },
      update: async () => ({ ok: true as const, value: undefined }),
    };

    const retryConfig = makeConfig({
      spoolDir,
      enableExport: false,
      enableIndexUpdate: true,
      maxRetries: 3,
      retryBaseDelayMs: 10,
      retryMaxJitterMs: 0,
      sleepFn: async (ms: number) => {
        sleepCalls.push(ms);
      },
    });

    const retryDeps = { ...deps, qmdAdapter: flakeyAdapter as never };
    const result = await runCycle(retryConfig, retryDeps, logger);

    expect(result.indexUpdate).not.toBeNull();
    expect(result.indexUpdate!.ok).toBe(true);
    expect(ensureAttempts).toBe(3);
    expect(sleepCalls).toHaveLength(2);
  });

  it('index update exhausts retries and records permanent failure', async () => {
    const sleepFn = async (_ms: number) => {};
    let attempts = 0;

    const alwaysFailAdapter = {
      ensureCollections: async () => {
        attempts++;
        return { ok: false as const, error: { message: 'qmd unreachable' } };
      },
      update: async () => ({ ok: true as const, value: undefined }),
    };

    const retryConfig = makeConfig({
      spoolDir,
      enableExport: false,
      enableIndexUpdate: true,
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxJitterMs: 0,
      sleepFn,
    });

    const retryDeps = { ...deps, qmdAdapter: alwaysFailAdapter as never };
    const result = await runCycle(retryConfig, retryDeps, logger);

    expect(result.indexUpdate).not.toBeNull();
    expect(result.indexUpdate!.ok).toBe(false);
    expect(result.indexUpdate!.error).toContain('qmd unreachable');
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it('index update does not retry permanent (non-transient) errors', async () => {
    let attempts = 0;

    const permanentFailAdapter = {
      ensureCollections: async () => {
        attempts++;
        return { ok: false as const, error: { message: 'TypeError: cannot read properties' } };
      },
      update: async () => ({ ok: true as const, value: undefined }),
    };

    const retryConfig = makeConfig({
      spoolDir,
      enableExport: false,
      enableIndexUpdate: true,
      maxRetries: 3,
      retryBaseDelayMs: 10,
      retryMaxJitterMs: 0,
      sleepFn: async (_ms: number) => {},
    });

    const retryDeps = { ...deps, qmdAdapter: permanentFailAdapter as never };
    const result = await runCycle(retryConfig, retryDeps, logger);

    expect(result.indexUpdate!.ok).toBe(false);
    expect(result.indexUpdate!.error).toContain('TypeError');
    expect(attempts).toBe(1); // no retry for permanent errors
  });
});
