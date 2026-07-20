#!/usr/bin/env tsx
/**
 * CI groundedness gate (Wave-2 C2) — runs the DETERMINISTIC groundedness
 * scorer (scorer v1) over the labeled fixture (fixture/v1: real promoted-memory
 * excerpts + synthetic claims) and FAILS CLOSED when:
 *
 *   - any scorer error is UNDOCUMENTED (a wrong prediction the fixture does
 *     not already carry as a known limitation), or
 *   - a segmented metric falls below its committed floor
 *     (supported-precision / unsupported-catch-rate — floors were MEASURED on
 *     the first real run, then committed; see GROUNDEDNESS_FLOORS).
 *
 * No LLM runs here or anywhere in CI: scorer v1 is pure token/number/negation
 * arithmetic. The optional MiniMax judge is an offline comparison arm only
 * (scripts/groundedness-judge-compare.ts, run by hand with explicit env).
 *
 * Mirrors ci-govern-decision.ts (the moat-eval gate pattern): prints the
 * segmented numbers so CI logs carry real measurements, exits non-zero on a
 * genuine regression, and treats documented limitations as reported data.
 */

import { evaluateGroundedness, GROUNDEDNESS_FLOORS } from '../src/index.js';
import type { GroundednessReport } from '../src/index.js';

const result = evaluateGroundedness();
const report = JSON.parse(String(result.details.report_json)) as GroundednessReport;

process.stdout.write(
  `groundedness eval — fixture v${report.fixtureVersion}: ${report.totalItems} items ` +
    `(${report.supportedItems} supported / ${report.unsupportedItems} unsupported)\n\n`,
);
process.stdout.write('SEGMENTED metrics (floors in parentheses):\n');
process.stdout.write(
  `  supported-precision    ${report.supportedPrecision.toFixed(4)} ` +
    `(floor ${GROUNDEDNESS_FLOORS.supportedPrecision.toFixed(4)})\n`,
);
process.stdout.write(`  supported-recall       ${report.supportedRecall.toFixed(4)}\n`);
process.stdout.write(
  `  unsupported-catch-rate ${report.unsupportedCatchRate.toFixed(4)} ` +
    `(floor ${GROUNDEDNESS_FLOORS.unsupportedCatchRate.toFixed(4)})\n`,
);
process.stdout.write(`  balanced accuracy      ${report.balancedAccuracy.toFixed(4)}\n`);

process.stdout.write('\nUnsupported catch by perturbation:\n');
for (const p of report.perPerturbation) {
  if (p.items === 0) continue;
  process.stdout.write(`  ${p.perturbation.padEnd(18)} ${p.caught}/${p.items}\n`);
}

if (report.errors.length > 0) {
  process.stdout.write('\nScorer errors (documented = a known v1 limitation):\n');
  for (const e of report.errors) {
    process.stdout.write(
      `  ${e.itemId.padEnd(32)} label=${e.label} predicted=${e.predicted} ` +
        `${e.perturbation !== undefined ? `perturbation=${e.perturbation} ` : ''}` +
        `documented=${e.documented}\n`,
    );
  }
}

if (!result.passed) {
  process.stderr.write(
    `\nci-groundedness FAILED: ` +
      `${report.undocumentedErrors.length} undocumented scorer error(s), ` +
      `supported-precision=${report.supportedPrecision} ` +
      `(floor ${GROUNDEDNESS_FLOORS.supportedPrecision}), ` +
      `unsupported-catch-rate=${report.unsupportedCatchRate} ` +
      `(floor ${GROUNDEDNESS_FLOORS.unsupportedCatchRate}). ` +
      `Fix the scorer or the fixture — never relabel to hide a regression.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    '\nci-groundedness OK — zero undocumented scorer errors and both segment ' +
      'floors held (documented limitations reported above, tracked, not hidden).\n',
  );
}
