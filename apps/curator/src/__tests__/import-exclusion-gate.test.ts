/**
 * Tests for the import exclusion gate (bead 5kw.1): verdict table, the
 * policy-pipeline-shaped rejection (mirror of the origin gate / PR #302),
 * and the Curator integration — an import-source junk candidate is rejected
 * WITH a receipted audit event while an identical interactive-source
 * candidate is untouched.
 *
 * @module __tests__/import-exclusion-gate.test
 */

import { describe, expect, it } from 'vitest';

import {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  createTestDatabase,
} from '@qmd-team-intent-kb/store';
import { makeCandidate, DEFAULT_TENANT } from '@qmd-team-intent-kb/test-fixtures';

import { Curator } from '../curator.js';
import {
  checkImportExclusion,
  IMPORT_EXCLUSION_RULE_TYPE,
} from '../import-exclusion/import-exclusion-gate.js';
import { parseBrainignore, type BrainignoreRuleset } from '../import-exclusion/brainignore.js';

const PROSE =
  'A perfectly ordinary imported note about the deployment pipeline and its gates, ' +
  'long enough to clear the content-length floor and lexically varied enough to read as prose.';

describe('checkImportExclusion — verdict table', () => {
  it('is not applicable to interactive sources, junk content or not', () => {
    for (const source of ['claude_session', 'manual', 'mcp'] as const) {
      const candidate = makeCandidate({
        source,
        metadata: { filePaths: ['node_modules/pkg/README.md'], tags: [] },
      });
      expect(checkImportExclusion(candidate).verdict).toBe('not_applicable');
    }
  });

  it('clears an import candidate with clean paths and prose content', () => {
    const candidate = makeCandidate({
      source: 'import',
      content: PROSE,
      metadata: { filePaths: ['docs/deployment.md'], tags: [] },
    });
    expect(checkImportExclusion(candidate).verdict).toBe('clear');
  });

  it('rejects an import candidate on a vendored path with a pipeline-shaped receipt', () => {
    const candidate = makeCandidate({
      source: 'import',
      content: PROSE,
      metadata: {
        filePaths: ['iams-gcp-resources/node_modules/@google-cloud/storage/README.md'],
        tags: [],
      },
    });
    const result = checkImportExclusion(candidate);
    expect(result.verdict).toBe('rejected');
    if (result.verdict !== 'rejected') throw new Error('unreachable');
    expect(result.match.code).toBe('brainignore_path');
    // Policy-pipeline-shaped (the #302 origin-gate mirror): flows through the
    // existing receipted rejection path, never a crash.
    expect(result.pipelineResult.outcome).toBe('rejected');
    expect(result.pipelineResult.rejectedBy).toBe('brainignore_path');
    expect(result.pipelineResult.evaluations[0]?.ruleType).toBe(IMPORT_EXCLUSION_RULE_TYPE);
    expect(result.pipelineResult.evaluations[0]?.reason).toContain('node_modules');
  });

  it('rejects bulk_import candidates the same way', () => {
    const candidate = makeCandidate({
      source: 'bulk_import',
      trustLevel: 'low',
      content: PROSE,
      metadata: { filePaths: ['repo/pnpm-lock.yaml'], tags: [] },
    });
    const result = checkImportExclusion(candidate);
    expect(result.verdict).toBe('rejected');
  });

  it('rejects on content heuristics even when every path is clean', () => {
    const candidate = makeCandidate({
      source: 'import',
      content:
        'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
      metadata: { filePaths: ['docs/innocent-name.md'], tags: [] },
    });
    const result = checkImportExclusion(candidate);
    expect(result.verdict).toBe('rejected');
    if (result.verdict !== 'rejected') throw new Error('unreachable');
    expect(result.match.code).toBe('brainignore_license_boilerplate');
  });

  it('honors an override ruleset whose negation re-admits a default exclusion', () => {
    const ruleset: BrainignoreRuleset = {
      patterns: parseBrainignore(
        ['**/node_modules/**', '!**/node_modules/my-own-pkg/**'].join('\n'),
        'override',
      ),
      overridePath: '/tmp/brainignore',
    };
    const candidate = makeCandidate({
      source: 'import',
      content: PROSE,
      metadata: { filePaths: ['node_modules/my-own-pkg/NOTES.md'], tags: [] },
    });
    expect(checkImportExclusion(candidate, ruleset).verdict).toBe('clear');
  });
});

describe('Curator integration (5kw.1)', () => {
  function makeCurator(overrides: Record<string, unknown> = {}) {
    const db = createTestDatabase();
    const deps = {
      candidateRepo: new CandidateRepository(db),
      memoryRepo: new MemoryRepository(db),
      policyRepo: new PolicyRepository(db),
      auditRepo: new AuditRepository(db),
    };
    const curator = new Curator(deps, { tenantId: DEFAULT_TENANT, ...overrides });
    return { curator, deps };
  }

  it('rejects an import-source vendored doc and writes a receipted audit event', () => {
    const { curator, deps } = makeCurator();
    const candidate = makeCandidate({
      source: 'import',
      content: PROSE,
      metadata: { filePaths: ['node_modules/@google-cloud/storage/README.md'], tags: [] },
    });

    const result = curator.processSingle(candidate);
    expect(result.outcome).toBe('rejected');
    expect(result.pipelineResult?.rejectedBy).toBe('brainignore_path');
    expect(result.reason).toContain('brainignore_path');

    // Receipted: the rejection landed on the audit chain with the evidence.
    const events = deps.auditRepo.findByMemory(candidate.id);
    expect(events.length).toBe(1);
    const details = events[0]!.details as {
      outcome: string;
      evaluations: Array<{ ruleId: string; ruleType: string; reason: string }>;
    };
    expect(details.outcome).toBe('rejected');
    expect(details.evaluations[0]?.ruleId).toBe('brainignore_path');
    expect(details.evaluations[0]?.ruleType).toBe(IMPORT_EXCLUSION_RULE_TYPE);
    expect(details.evaluations[0]?.reason).toContain('node_modules');

    // Nothing was promoted.
    expect(deps.memoryRepo.findByTenant(DEFAULT_TENANT).length).toBe(0);
  });

  it('promotes an identical candidate from an interactive source untouched', () => {
    const { curator, deps } = makeCurator();
    const candidate = makeCandidate({
      source: 'claude_session',
      content: PROSE,
      metadata: { filePaths: ['node_modules/@google-cloud/storage/README.md'], tags: [] },
    });

    const result = curator.processSingle(candidate);
    expect(result.outcome).toBe('promoted');
    expect(deps.memoryRepo.findByTenant(DEFAULT_TENANT).length).toBe(1);
  });

  it('a configured override ruleset lets a negated path promote', () => {
    const ruleset: BrainignoreRuleset = {
      patterns: parseBrainignore(
        ['**/node_modules/**', '!**/node_modules/my-own-pkg/**'].join('\n'),
        'override',
      ),
      overridePath: '/tmp/brainignore',
    };
    const { curator } = makeCurator({ importExclusions: ruleset });
    const candidate = makeCandidate({
      source: 'import',
      content: PROSE,
      metadata: { filePaths: ['node_modules/my-own-pkg/NOTES.md'], tags: [] },
    });
    expect(curator.processSingle(candidate).outcome).toBe('promoted');
  });
});
