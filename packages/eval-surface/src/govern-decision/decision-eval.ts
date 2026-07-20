/**
 * govern-decision DECISION-CASE runner (Wave-2 C3) — scores the three
 * STATE-DEPENDENT govern decisions over the labeled decision set:
 *
 *   - `dedup-rule`             — the production `dedup_check` rule inside the
 *                                real `PolicyPipeline` (exact SHA-256 hash)
 *   - `contradiction-rule`     — the production Phase-1 `contradiction_check`
 *                                rule inside the same pipeline (token overlap)
 *   - `supersession-detector`  — the real `detectSupersession` (policy-engine)
 *
 * Wired through the REAL machinery end to end: each case seeds its existing
 * actives into a real in-memory store (`createTestDatabase` +
 * `MemoryRepository.insert`, so the write-side enum guards run too), builds
 * the pipeline context EXACTLY the way the curator does (`existingHashes`
 * from content hashes, `getActiveMemoriesInCategory` from a live repository
 * query), and evaluates the candidate through `PolicyPipeline.evaluate`. A
 * false-negative measured here is therefore a real production miss, not a
 * harness artifact. The store is ephemeral (`:memory:`) — no durable state.
 *
 * Scoring semantics mirror the main govern-decision eval: a positive case is
 * in scope for a check only when it names it in `expectFiredBy` or
 * `knownFalseNegativeOf`; every `clean` case is in scope for every check
 * (a firing check there is a false positive — counted against precision even
 * when `knownFalsePositiveOf` documents it, so the numbers stay honest).
 * The gating properties are ZERO UNDOCUMENTED false-negatives AND the
 * per-check precision floors ({@link DECISION_PRECISION_FLOORS}, measured
 * then committed); documented gaps and known FPs are reported, never hidden.
 */

import { computeContentHash } from '@qmd-team-intent-kb/common';
import {
  DEFAULT_SUPERSESSION_THRESHOLD,
  detectSupersession,
  PolicyPipeline,
} from '@qmd-team-intent-kb/policy-engine';
import {
  CuratedMemory,
  GovernancePolicy,
  MemoryCandidate,
  type MemoryCategory,
} from '@qmd-team-intent-kb/schema';
import { createTestDatabase, MemoryRepository } from '@qmd-team-intent-kb/store';
import { randomUUID } from 'node:crypto';

import type {
  DecisionCase,
  DecisionCasesReport,
  DecisionCheck,
  DecisionCheckMetrics,
  DecisionClass,
  DecisionClassMetrics,
  DecisionFalseNegative,
  DecisionFalsePositive,
} from './decision-types.js';
import {
  DECISION_CASES,
  DECISION_DATASET_VERSION,
  DECISION_TENANT,
} from './decision-dataset/v1/index.js';

const ALL_DECISION_CHECKS: readonly DecisionCheck[] = [
  'dedup-rule',
  'contradiction-rule',
  'supersession-detector',
];

const POSITIVE_CLASSES: ReadonlyArray<Exclude<DecisionClass, 'clean'>> = [
  'duplicate',
  'contradiction',
  'supersession',
];

// Supersession threshold: consumed from the policy-engine single source
// (DEFAULT_SUPERSESSION_THRESHOLD) — the exact constant curator + api use, so
// the eval can never measure a different threshold than production runs.

/**
 * Measured-then-committed per-check PRECISION floors (PR #301 review,
 * finding 1). Known false positives (a clean case a check is documented to
 * fire on, e.g. the contradiction heuristic on a compatible restatement)
 * count honestly against precision; these floors — taken from the real run
 * over decision-dataset v1.1.0, never invented — are what the gate holds.
 * A NEW (undocumented) firing on a clean case drops the check below its
 * floor and fails the eval closed.
 */
export const DECISION_PRECISION_FLOORS: Record<DecisionCheck, number> = {
  'dedup-rule': 1.0,
  'contradiction-rule': 0.75,
  'supersession-detector': 1.0,
};

/**
 * The policy the decision cases run under: the two state-dependent rules with
 * their production semantics — `dedup_check` rejects (as in the recommended
 * policy), `contradiction_check` is Phase-1 flag-only by construction.
 */
function buildDecisionPolicy(): GovernancePolicy {
  return GovernancePolicy.parse({
    id: '00000000-0000-4000-8000-00000000c301',
    name: 'govern-decision eval policy (dedup + contradiction)',
    tenantId: DECISION_TENANT,
    rules: [
      {
        id: 'rule-contradiction-check',
        type: 'contradiction_check',
        action: 'flag',
        enabled: true,
        priority: 0,
        parameters: {},
      },
      {
        id: 'rule-dedup-check',
        type: 'dedup_check',
        action: 'reject',
        enabled: true,
        priority: 1,
        parameters: {},
      },
    ],
    enabled: true,
    version: 1,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
  });
}

/** Build a Zod-valid candidate for a decision case. */
function buildCandidate(def: DecisionCase): MemoryCandidate {
  return MemoryCandidate.parse({
    id: randomUUID(),
    status: 'inbox',
    source: 'claude_session',
    content: def.candidate.content,
    title: def.candidate.title,
    category: def.candidate.category,
    trustLevel: 'medium',
    author: { type: 'ai', id: 'govern-eval' },
    tenantId: DECISION_TENANT,
    metadata: { filePaths: [], tags: [] },
    prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
    capturedAt: '2026-07-19T00:00:00.000Z',
  });
}

/** Build a Zod-valid ACTIVE curated memory to seed the store with. */
function buildActiveMemory(
  title: string,
  content: string,
  category: MemoryCategory,
): CuratedMemory {
  return CuratedMemory.parse({
    id: randomUUID(),
    candidateId: randomUUID(),
    source: 'claude_session',
    content,
    title,
    category,
    trustLevel: 'medium',
    sensitivity: 'internal',
    author: { type: 'ai', id: 'govern-eval' },
    tenantId: DECISION_TENANT,
    metadata: { filePaths: [], tags: [] },
    lifecycle: 'active',
    contentHash: computeContentHash(content),
    policyEvaluations: [],
    promotedAt: '2026-07-19T00:00:00.000Z',
    promotedBy: { type: 'human', id: 'govern-eval' },
    updatedAt: '2026-07-19T00:00:00.000Z',
    version: 1,
  });
}

/** Which decision checks fired for this case, measured through the real machinery. */
function firedChecks(def: DecisionCase): ReadonlySet<DecisionCheck> {
  const db = createTestDatabase();
  try {
    const repo = new MemoryRepository(db);
    for (const active of def.existingActives) {
      repo.insert(buildActiveMemory(active.title, active.content, active.category));
    }

    const candidate = buildCandidate(def);
    const pipeline = new PolicyPipeline(buildDecisionPolicy());

    // EXACTLY the curator's context wiring (apps/curator/src/curator.ts):
    // hashes of every existing content, and a live category-scoped repo query.
    const result = pipeline.evaluate(candidate, {
      existingHashes: new Set(def.existingActives.map((a) => computeContentHash(a.content))),
      tenantId: DECISION_TENANT,
      getActiveMemoriesInCategory: (category) =>
        repo
          .findByTenantAndLifecycleAndCategory(DECISION_TENANT, 'active', category)
          .map((m) => ({ id: m.id, content: m.content })),
    });

    const fired = new Set<DecisionCheck>();
    if (result.evaluations.some((e) => e.ruleType === 'dedup_check' && e.outcome === 'fail')) {
      fired.add('dedup-rule');
    }
    if (
      result.evaluations.some((e) => e.ruleType === 'contradiction_check' && e.outcome === 'flag')
    ) {
      fired.add('contradiction-rule');
    }
    if (detectSupersession(candidate, repo, DEFAULT_SUPERSESSION_THRESHOLD) !== null) {
      fired.add('supersession-detector');
    }
    return fired;
  } finally {
    db.close();
  }
}

function metricsFor(
  check: DecisionCheck,
  tp: number,
  fp: number,
  fn: number,
  tn: number,
): DecisionCheckMetrics {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    check,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
  };
}

/**
 * Run the decision-case eval. Pure w.r.t. durable state (ephemeral in-memory
 * stores only). Returns the full per-check + per-class report; the caller
 * (evaluateGovernDecision) folds the undocumented-FN count into the gate.
 */
export function evaluateDecisionCases(
  cases: readonly DecisionCase[] = DECISION_CASES,
): DecisionCasesReport {
  const fired = new Map<string, ReadonlySet<DecisionCheck>>();
  for (const def of cases) {
    fired.set(def.id, firedChecks(def));
  }

  const positives = cases.filter((c) => c.decisionClass !== 'clean');
  const negatives = cases.filter((c) => c.decisionClass === 'clean');

  const perCheck: DecisionCheckMetrics[] = [];
  const falseNegatives: DecisionFalseNegative[] = [];
  const falsePositives: DecisionFalsePositive[] = [];

  for (const check of ALL_DECISION_CHECKS) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;

    for (const def of positives) {
      const expected = def.expectFiredBy.includes(check);
      const documentedMiss = (def.knownFalseNegativeOf ?? []).includes(check);
      if (!expected && !documentedMiss) continue; // out of scope for this case

      if (fired.get(def.id)!.has(check)) {
        tp += 1;
      } else {
        fn += 1;
        falseNegatives.push({
          caseId: def.id,
          check,
          decisionClass: def.decisionClass,
          documented: documentedMiss,
        });
      }
    }

    for (const def of negatives) {
      if (fired.get(def.id)!.has(check)) {
        // Every firing on a clean case is a FALSE POSITIVE and counts against
        // precision — including KNOWN FPs (documented via knownFalsePositiveOf).
        // "Known" only means it is reported as documented rather than as a
        // surprise; the committed precision floors are what hold the line.
        fp += 1;
        falsePositives.push({
          caseId: def.id,
          check,
          documented: (def.knownFalsePositiveOf ?? []).includes(check),
        });
      } else {
        tn += 1;
      }
    }

    perCheck.push(metricsFor(check, tp, fp, fn, tn));
  }

  // Per-class breakout: catch-rate over every scored (case, check) pair of the
  // class — the number the report must surface so a dedup regression is not
  // averaged away by contradiction/supersession health (and vice versa).
  const perClass: DecisionClassMetrics[] = POSITIVE_CLASSES.map((decisionClass) => {
    let scoredPairs = 0;
    let caught = 0;
    let documentedMisses = 0;
    for (const def of positives.filter((c) => c.decisionClass === decisionClass)) {
      const scoredChecks = new Set<DecisionCheck>([
        ...def.expectFiredBy,
        ...(def.knownFalseNegativeOf ?? []),
      ]);
      for (const check of scoredChecks) {
        scoredPairs += 1;
        if (fired.get(def.id)!.has(check)) {
          caught += 1;
        } else if ((def.knownFalseNegativeOf ?? []).includes(check)) {
          documentedMisses += 1;
        }
      }
    }
    return {
      decisionClass,
      scoredPairs,
      caught,
      catchRate: scoredPairs === 0 ? 1 : Number((caught / scoredPairs).toFixed(4)),
      documentedMisses,
    };
  });

  return {
    datasetVersion: DECISION_DATASET_VERSION,
    totalCases: cases.length,
    positives: positives.length,
    negatives: negatives.length,
    perCheck,
    perClass,
    falseNegatives,
    undocumentedFalseNegatives: falseNegatives.filter((f) => !f.documented),
    falsePositives,
    knownFalsePositives: falsePositives.filter((f) => f.documented),
  };
}
