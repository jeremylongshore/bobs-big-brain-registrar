#!/usr/bin/env tsx
/**
 * OFFLINE groundedness judge comparison — run BY HAND, never in CI, never a
 * gate (Wave-2 C2 comparison arm).
 *
 *   GROUNDEDNESS_LLM_JUDGE=minimax MINIMAX_API_KEY=… \
 *     pnpm --filter @qmd-team-intent-kb/eval-surface groundedness:judge-compare
 *
 * Prints scorer v1's deterministic verdict next to the LLM judge's for every
 * fixture item plus an agreement summary. Disagreement is INFORMATION about
 * the deterministic scorer's blind spots (e.g. argument swaps) — it changes
 * nothing automatically; a human decides whether a scorer-v2 heuristic or a
 * fixture annotation is warranted. Exits 0 unless the judge is unconfigured
 * or errors (so a broken comparison is loud, per "a metric that cannot fail
 * is worthless").
 */

import { GROUNDEDNESS_ITEMS, judgeFromEnv, scoreGroundedness } from '../src/index.js';

const judge = judgeFromEnv();
if (judge === null) {
  process.stderr.write(
    'groundedness-judge-compare: not configured. Set GROUNDEDNESS_LLM_JUDGE=minimax ' +
      'and MINIMAX_API_KEY to run the offline comparison arm. (CI never sets these.)\n',
  );
  process.exit(1);
}

let agree = 0;
let disagree = 0;
for (const item of GROUNDEDNESS_ITEMS) {
  const deterministic = scoreGroundedness(item.claim, item.memoryExcerpt).predicted;
  const llm = await judge.judge(item);
  const match = deterministic === llm ? 'agree   ' : 'DISAGREE';
  if (deterministic === llm) agree++;
  else disagree++;
  process.stdout.write(
    `${match} ${item.id.padEnd(32)} label=${item.label.padEnd(11)} ` +
      `scorer=${deterministic.padEnd(11)} ${judge.name}=${llm}\n`,
  );
}
process.stdout.write(
  `\nAgreement: ${agree}/${agree + disagree} ` +
    `(comparison only — the deterministic scorer remains the sole CI arbiter)\n`,
);
