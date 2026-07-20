/**
 * govern-decision evaluator — does the deterministic govern decision actually
 * CATCH what it must, or is it merely deterministic?
 *
 * ## Why (010-AT-RISK R5/R10 · bead compile-then-govern-e06.3 · umbrella #27)
 *
 * The 8 policy rules are verified-*deterministic* (same input → same verdict)
 * but their EFFICACY was never measured. Determinism is not correctness: a
 * line-based regex secret-scan is perfectly deterministic AND misses a key
 * split across two lines or a base64-wrapped token — the CISO's top fear (a
 * leaked key promoted with a clean receipt). This evaluator runs the govern
 * decision over an adversarial labeled set (dataset/v1) and reports PER-CHECK
 * precision / recall + a false-negative list, so the moat's efficacy is a
 * measured number, not a claim.
 *
 * It scores four independent detection surfaces (see {@link GovernCheck}):
 *   - `policy-pipeline`     — the full `PolicyPipeline.evaluate` verdict (rejected?)
 *   - `secret-scanner`      — `scanForSecrets` (claude-runtime)
 *   - `content-classifier`  — `classifyContent` (claude-runtime) → non-public?
 *   - `boundary-disclosure` — `scanForDisclosure` over the SAME free-text surfaces
 *                             the repository-boundary gate (`assertDisclosureClean`)
 *                             walks — content + title + tags + metadata free-text
 *                             (filePaths, projectContext, …) + tenantId + author.
 *
 * Scoring is honest by construction: labels in the dataset are empirical, and a
 * MEASURED false-negative NOT already documented in a case's
 * `knownFalseNegativeOf` is surfaced in `undocumentedFalseNegatives` — the CI
 * gate fails closed on any such surprise. Documented gaps (split keys, base64,
 * boundary-filter blind spots) are reported but do not fail the build; they are
 * the honest output of the eval, tracked as follow-ups, never hidden by
 * weakening a rule.
 *
 * Pure w.r.t. durable state: takes no repositories, reads no files, emits/signs
 * nothing. It classifies in-memory candidates and returns a verdict — the same
 * measure-don't-mutate posture as the other eval-surface evaluators.
 */

import { classifyContent, scanForSecrets } from '@qmd-team-intent-kb/claude-runtime';
import { collectFreeTextFields, scanDisclosureFields } from '@qmd-team-intent-kb/common';
import { PolicyPipeline } from '@qmd-team-intent-kb/policy-engine';
import { GovernancePolicy, type MemoryCandidate } from '@qmd-team-intent-kb/schema';

import type { EvaluatorResult } from './types.js';
import type {
  CheckMetrics,
  FalseNegative,
  GovernCase,
  GovernCheck,
  GovernDecisionReport,
} from './govern-decision/types.js';
import type { DecisionCase } from './govern-decision/decision-types.js';
import { evaluateDecisionCases } from './govern-decision/decision-eval.js';
import { DATASET_VERSION } from './govern-decision/dataset/v1/index.js';
import { loadDataset, type LoadedCase } from './govern-decision/dataset/v1/load.js';

const ALL_CHECKS: readonly GovernCheck[] = [
  'policy-pipeline',
  'secret-scanner',
  'content-classifier',
  'boundary-disclosure',
];

/**
 * The govern policy the eval exercises: the security-relevant subset of the 8
 * rules, both set to `reject`, so `policy-pipeline` = "does the govern decision
 * REJECT this candidate". Priorities mirror the production ordering (secret
 * detection first). Built via Zod parse so it is a real GovernancePolicy.
 */
function buildGovernPolicy(): GovernancePolicy {
  return GovernancePolicy.parse({
    id: '00000000-0000-4000-8000-00000000e063',
    name: 'govern-decision eval policy (secret + sensitivity, reject)',
    tenantId: 'govern-eval-tenant',
    rules: [
      {
        id: 'rule-secret-detect',
        type: 'secret_detection',
        action: 'reject',
        enabled: true,
        priority: 0,
        parameters: {},
      },
      {
        id: 'rule-sensitivity-gate',
        type: 'sensitivity_gate',
        action: 'reject',
        enabled: true,
        priority: 1,
        // Block the two most-sensitive levels (restricted = creds, confidential
        // = PII). `internal` (path leaks) is intentionally NOT rejected — the
        // content_sanitization rule FLAGS those; rejecting would over-block.
        parameters: { blockedLevels: ['restricted', 'confidential'] },
      },
    ],
    enabled: true,
    version: 1,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
  });
}

/** Did a given check FIRE on this candidate (detect something sensitive)? */
function checkFired(
  check: GovernCheck,
  candidate: MemoryCandidate,
  pipeline: PolicyPipeline,
): boolean {
  switch (check) {
    case 'policy-pipeline': {
      // The govern decision fires when the pipeline REJECTS the candidate.
      return pipeline.evaluate(candidate).outcome === 'rejected';
    }
    case 'secret-scanner': {
      return scanForSecrets(candidate.content).length > 0;
    }
    case 'content-classifier': {
      // Fires when the content is classified above `public` (internal / PII /
      // credentials all count as "the classifier saw something").
      return classifyContent(candidate.content).sensitivityLevel !== 'public';
    }
    case 'boundary-disclosure': {
      // Scan the SAME derived free-text surface the repository-boundary gate
      // walks (content, title, tags, ALL metadata free-text incl. filePaths /
      // projectContext, tenantId, author) — the structural set from
      // collectFreeTextFields. This is what `assertDisclosureClean` enforces and
      // what the R10 fix makes the API intake early-check consistent with.
      return scanDisclosureFields(collectFreeTextFields(candidate)) !== null;
    }
  }
}

/** Compute precision / recall / F1 from raw confusion-matrix counts. */
function metricsFor(
  check: GovernCheck,
  tp: number,
  fp: number,
  fn: number,
  tn: number,
): CheckMetrics {
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

/** Whether the case documented this check as a known miss. */
function isDocumentedMiss(def: GovernCase, check: GovernCheck): boolean {
  return (def.knownFalseNegativeOf ?? []).includes(check);
}

export interface GovernDecisionOptions {
  /** Override the labeled set (defaults to dataset/v1). Used by tests. */
  readonly cases?: readonly GovernCase[];
  /** Override the decision-case set (defaults to decision-dataset/v1). Used by tests. */
  readonly decisionCases?: readonly DecisionCase[];
  /**
   * Pass threshold for the aggregate score. The GATING property, however, is
   * not the score — it is "zero UNDOCUMENTED false-negatives" (see below).
   * Default 0.0 (score is reporting-only; the binary gate is FN-driven).
   */
  readonly threshold?: number;
}

/**
 * Run the govern-decision efficacy eval.
 *
 * Verdict (`passed`) is the SECURITY property, mirroring provenance-integrity's
 * "fail only on genuine tampering":
 *
 *     passed = undocumentedFalseNegatives.length === 0
 *
 * i.e. every positive case is either CAUGHT by an expected check, or its miss
 * is already DOCUMENTED in the dataset (a known, tracked gap). A NEW miss —
 * a regression where a check that used to catch a case stops firing, or a case
 * whose expected catch silently fails — flips `passed:false`. Documented gaps
 * (split keys, base64, boundary blind spots) are reported in `details` but do
 * NOT fail the build: they are the honest measured output, tracked as
 * follow-up beads, and the point of the whole eval is to surface them.
 *
 * The continuous `score` is the mean per-check F1 across all four checks — a
 * reporting number, never the pass/fail decision (per the eval-surface
 * contract: the platform refuses gradient scores AS the verdict).
 */
export function evaluateGovernDecision(options: GovernDecisionOptions = {}): EvaluatorResult {
  const loaded: LoadedCase[] = loadDataset(options.cases);
  const pipeline = new PolicyPipeline(buildGovernPolicy());

  const positives = loaded.filter((l) => l.def.sensitiveClass !== 'none');
  const negatives = loaded.filter((l) => l.def.sensitiveClass === 'none');

  const perCheck: CheckMetrics[] = [];
  const falseNegatives: FalseNegative[] = [];

  for (const check of ALL_CHECKS) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;

    for (const { def, candidate } of positives) {
      // A positive is "in scope" for a check when the case expects THAT check to
      // catch it, OR documents that check as a known miss. Checks a case never
      // names (e.g. secret-scanner on a pure-PII case — SSNs are not secrets)
      // are out of scope for that case and do not count toward its recall.
      const expected = def.expectCaughtBy.includes(check);
      const documentedMiss = isDocumentedMiss(def, check);
      if (!expected && !documentedMiss) continue;

      const fired = checkFired(check, candidate, pipeline);
      if (fired) {
        tp += 1;
      } else {
        fn += 1;
        falseNegatives.push({
          caseId: def.id,
          check,
          sensitiveClass: def.sensitiveClass,
          surface: def.surface,
          documented: documentedMiss,
        });
      }
    }

    for (const { candidate } of negatives) {
      // Every negative is in scope for every check: a firing check on a benign
      // case is a FALSE POSITIVE (precision hit), regardless of labels.
      const fired = checkFired(check, candidate, pipeline);
      if (fired) fp += 1;
      else tn += 1;
    }

    perCheck.push(metricsFor(check, tp, fp, fn, tn));
  }

  const undocumentedFalseNegatives = falseNegatives.filter((f) => !f.documented);

  // Wave-2 C3: the state-dependent decision section (dedup / contradiction /
  // supersession over real store + real pipeline + real detector).
  const decisionCases = evaluateDecisionCases(options.decisionCases);

  const report: GovernDecisionReport = {
    totalCases: loaded.length,
    positives: positives.length,
    negatives: negatives.length,
    perCheck,
    falseNegatives,
    undocumentedFalseNegatives,
    decisionCases,
  };

  const meanF1 =
    perCheck.length === 0 ? 1 : perCheck.reduce((s, m) => s + m.f1, 0) / perCheck.length;

  // GATING property: zero undocumented (surprise / regression) false-negatives —
  // across BOTH sections (sensitive-material checks AND the C3 decision checks).
  const passed =
    undocumentedFalseNegatives.length === 0 &&
    decisionCases.undocumentedFalseNegatives.length === 0;
  const threshold = options.threshold ?? 0;

  return {
    name: 'govern-decision',
    passed,
    score: Number(meanF1.toFixed(4)),
    threshold,
    details: {
      dataset_version: DATASET_VERSION,
      total_cases: report.totalCases,
      positives: report.positives,
      negatives: report.negatives,
      undocumented_false_negatives: undocumentedFalseNegatives.length,
      documented_false_negatives: falseNegatives.length - undocumentedFalseNegatives.length,
      mean_f1: Number(meanF1.toFixed(4)),
      // C3 decision section — flat summary fields (full breakout in report_json).
      decision_dataset_version: decisionCases.datasetVersion,
      decision_total_cases: decisionCases.totalCases,
      decision_undocumented_false_negatives: decisionCases.undocumentedFalseNegatives.length,
      decision_documented_false_negatives:
        decisionCases.falseNegatives.length - decisionCases.undocumentedFalseNegatives.length,
      ...Object.fromEntries(
        decisionCases.perCheck.flatMap((m) => [
          [`decision.precision.${m.check}`, m.precision],
          [`decision.recall.${m.check}`, m.recall],
        ]),
      ),
      ...Object.fromEntries(
        decisionCases.perClass.map((c) => [`decision.catchrate.${c.decisionClass}`, c.catchRate]),
      ),
      // Per-check precision/recall as flat, JSON-serialisable fields (the
      // EvaluatorResult.details value type is number|string|boolean).
      ...flattenPerCheck(perCheck),
      // The full structured report for the CI script / bundle, as JSON.
      report_json: JSON.stringify(report),
    },
  };
}

/** Flatten per-check metrics into `precision.<check>` / `recall.<check>` fields. */
function flattenPerCheck(perCheck: readonly CheckMetrics[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of perCheck) {
    out[`precision.${m.check}`] = m.precision;
    out[`recall.${m.check}`] = m.recall;
    out[`f1.${m.check}`] = m.f1;
  }
  return out;
}
