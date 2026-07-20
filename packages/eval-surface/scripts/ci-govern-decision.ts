#!/usr/bin/env tsx
/**
 * CI govern-decision gate — runs the govern-decision efficacy eval over the
 * versioned adversarial labeled set (dataset/v1) and FAILS CLOSED if any
 * KNOWN-POSITIVE case is an UNDOCUMENTED false-negative (a missed secret/PII
 * that the dataset did not already flag as a known gap).
 *
 * Why this exists (010-AT-RISK R5/R10 · bead compile-then-govern-e06.3 · umbrella #27):
 * the 8 govern rules are verified-deterministic but were UNEVALUATED for
 * efficacy. Determinism is not correctness — a line-based regex secret-scan is
 * deterministic AND misses a split/base64 key (the CISO's top fear). This gate
 * makes the govern decision's efficacy a required, measured property:
 *
 *   - It prints PER-CHECK precision / recall / F1 and the full false-negative
 *     list (documented gaps + any surprises) so the numbers are visible in CI
 *     logs — the deliverable is real numbers, even when they reveal gaps.
 *   - It EXITS NON-ZERO on any UNDOCUMENTED false-negative: a regression where a
 *     check that used to catch a positive stops firing, or a labeled catch that
 *     silently fails. Documented gaps (split keys, base64, boundary blind spots)
 *     do NOT fail the build — they are tracked follow-ups, surfaced not hidden.
 *
 * Mirrors packages/eval-surface/scripts/ci-provenance-integrity.ts (the R5 gate
 * pattern): a real end-to-end run, wired into ci.yml + nightly.yml as a named
 * step. No durable state touched — the eval is pure.
 *
 * Exit 0 when there are zero undocumented false-negatives; non-zero (with a
 * diagnostic) otherwise.
 */

import { evaluateGovernDecision } from '../src/index.js';
import type { GovernDecisionReport } from '../src/index.js';

const result = evaluateGovernDecision();
const report = JSON.parse(String(result.details.report_json)) as GovernDecisionReport;

process.stdout.write(
  `govern-decision eval — dataset v${String(result.details.dataset_version)}: ` +
    `${report.totalCases} cases (${report.positives} positive / ${report.negatives} negative)\n`,
);

process.stdout.write('\nPER-CHECK precision / recall / F1:\n');
for (const m of report.perCheck) {
  process.stdout.write(
    `  ${m.check.padEnd(22)} P=${m.precision.toFixed(4)} R=${m.recall.toFixed(4)} ` +
      `F1=${m.f1.toFixed(4)}  (TP=${m.truePositives} FP=${m.falsePositives} ` +
      `FN=${m.falseNegatives} TN=${m.trueNegatives})\n`,
  );
}
process.stdout.write(`\nmean F1 (reporting score): ${result.score}\n`);

// Wave-2 C3: state-dependent decision section — dedup / contradiction /
// supersession through the real store + pipeline + detector.
const dec = report.decisionCases;
process.stdout.write(
  `\nDECISION cases — dataset v${dec.datasetVersion}: ` +
    `${dec.totalCases} cases (${dec.positives} positive / ${dec.negatives} clean)\n`,
);
process.stdout.write('PER-CHECK precision / recall / F1:\n');
for (const m of dec.perCheck) {
  process.stdout.write(
    `  ${m.check.padEnd(22)} P=${m.precision.toFixed(4)} R=${m.recall.toFixed(4)} ` +
      `F1=${m.f1.toFixed(4)}  (TP=${m.truePositives} FP=${m.falsePositives} ` +
      `FN=${m.falseNegatives} TN=${m.trueNegatives})\n`,
  );
}
process.stdout.write('PER-CLASS catch-rate (the required class breakout):\n');
for (const c of dec.perClass) {
  process.stdout.write(
    `  ${c.decisionClass.padEnd(14)} catch=${c.catchRate.toFixed(4)} ` +
      `(${c.caught}/${c.scoredPairs} scored pairs, ${c.documentedMisses} documented miss(es))\n`,
  );
}
if (dec.falseNegatives.length > 0) {
  process.stdout.write('Decision false-negatives (documented = a known, tracked gap):\n');
  for (const f of dec.falseNegatives) {
    process.stdout.write(
      `  ${f.caseId.padEnd(28)} ${f.check.padEnd(22)} ` +
        `class=${f.decisionClass} documented=${f.documented}\n`,
    );
  }
}

if (report.falseNegatives.length > 0) {
  process.stdout.write('\nFalse-negatives (documented = a known, tracked gap):\n');
  for (const f of report.falseNegatives) {
    process.stdout.write(
      `  ${f.caseId.padEnd(28)} ${f.check.padEnd(22)} ` +
        `class=${f.sensitiveClass} surface=${f.surface} documented=${f.documented}\n`,
    );
  }
}

const decisionSurprises = dec.undocumentedFalseNegatives;
if (report.undocumentedFalseNegatives.length > 0 || decisionSurprises.length > 0) {
  process.stderr.write(
    `\nci-govern-decision FAILED: ` +
      `${report.undocumentedFalseNegatives.length + decisionSurprises.length} ` +
      `UNDOCUMENTED false-negative(s) — a missed secret/PII/duplicate/contradiction/` +
      `supersession the dataset did not already flag as a known gap. Either the ` +
      `govern decision regressed, or a new evasion needs a fix (not a relabel). Cases:\n`,
  );
  for (const f of report.undocumentedFalseNegatives) {
    process.stderr.write(`  - ${f.caseId} (${f.check}, ${f.sensitiveClass}/${f.surface})\n`);
  }
  for (const f of decisionSurprises) {
    process.stderr.write(`  - ${f.caseId} (${f.check}, class=${f.decisionClass})\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    '\nci-govern-decision OK — zero undocumented false-negatives across both ' +
      'sections (all misses are documented, tracked gaps).\n',
  );
}
