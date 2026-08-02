import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Architectural guard: the eval/serving split must be ENFORCED, not merely
 * conventional (bead `compile-then-govern-39z.6`).
 *
 * ## What this protects
 *
 * `resolveDenseConfig` (in `@qmd-team-intent-kb/common`) decides whether dense
 * retrieval is on **in production**. The retrieval eval deliberately does NOT
 * use it: it opts in with its own switch (`GOVERNED_EVAL_DENSE=1`) and builds
 * its adapter with explicit options — `ci-retrieval-ratchet.ts` constructs
 * `new QmdAdapter({ tenantId, exportDir })` with no `dense` field at all.
 *
 * That split is load-bearing. The committed anchor floors were measured on the
 * LEXICAL arm. If eval code ever resolved its config from the serving policy,
 * flipping `TEAMKB_DENSE` would silently change what the daily timer measures —
 * either failing it every night, or worse, passing against a stale baseline and
 * approving a ranking change nobody reviewed.
 *
 * ## Why a test rather than a comment
 *
 * This package declares `@qmd-team-intent-kb/common` as a `workspace:*`
 * dependency, so `resolveDenseConfig` is genuinely REACHABLE from here and is
 * the obvious thing for a future contributor to reach for. A docstring asking
 * them not to is a convention; this test is a guard. Raised in adversarial
 * review of PR #327 ("the decoupling is enforced by convention today").
 *
 * If you are here because this test failed: you almost certainly want to build
 * the adapter with explicit `dense` options instead. Wiring the serving policy
 * into eval or adapter code is a deliberate change to what the floors mean, and
 * belongs in a PR that re-measures and re-commits them.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `.ts` file under `packages/qmd-adapter/src`, excluding this guard. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.startsWith('dense-policy-import-discipline')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('architecture: qmd-adapter must not consume the serving dense policy', () => {
  it('no source file references resolveDenseConfig', () => {
    const offenders = collectSourceFiles(SRC_DIR)
      .filter((f) => readFileSync(f, 'utf-8').includes('resolveDenseConfig'))
      .map((f) => f.slice(SRC_DIR.length + 1));

    expect(
      offenders,
      'qmd-adapter (including the eval harness) must build adapters with EXPLICIT dense options, ' +
        'never by resolving the production serving policy — see this file’s header for why.',
    ).toEqual([]);
  });

  it('the CI retrieval ratchet builds its adapter without a dense field', () => {
    // The ratchet is what gates merges on retrieval quality. If it ever grew a
    // `dense` field, the committed lexical floors would stop describing the arm
    // being measured — silently, and in the direction that looks like success.
    const ratchet = readFileSync(join(SRC_DIR, 'eval', 'ci-retrieval-ratchet.ts'), 'utf-8');
    const construction = /new QmdAdapter\(\{[^}]*\}\)/s.exec(ratchet)?.[0] ?? '';

    expect(construction, 'expected a QmdAdapter construction in ci-retrieval-ratchet.ts').not.toBe(
      '',
    );
    expect(
      construction.includes('dense'),
      `ratchet now configures dense: ${construction} — re-measure and re-commit the floors`,
    ).toBe(false);
  });
});
