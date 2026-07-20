/**
 * govern-decision DECISION-CASE labeled dataset — v1 (Wave-2 C3).
 *
 * Labeled cases for the three STATE-DEPENDENT govern decisions: does the
 * pipeline catch a candidate that duplicates, contradicts, or supersedes an
 * existing ACTIVE memory? Each case seeds real active memories into a real
 * in-memory store and runs the real `PolicyPipeline` (`dedup_check` +
 * `contradiction_check`) and the real `detectSupersession` — no mocks of the
 * decision under test (see ../decision-eval.ts).
 *
 * ## Provenance of the labels
 *
 * Every `expectFiredBy` / `knownFalseNegativeOf` label was set from an
 * EMPIRICAL run of the real detectors on this exact material. The eval
 * re-derives the outcomes and fails closed on any UNDOCUMENTED false-negative,
 * so labels and code cannot silently disagree (same contract as dataset/v1).
 *
 * The documented gaps this set proves out — honest output, not hidden:
 *   - exact-hash dedup misses trivially-reworded/re-cased duplicates
 *     (`dup-recased-01`) — caught instead by the contradiction flag;
 *   - the token-overlap contradiction heuristic misses a genuine semantic
 *     contradiction phrased with different vocabulary (`contra-low-overlap-01`)
 *     and is blind across categories (`contra-cross-category-01`);
 *   - title-Jaccard supersession misses a fully reworded title
 *     (`sup-reworded-title-01`);
 *   - the token-overlap contradiction heuristic FIRES on a compatible
 *     restatement (`contra-restated-01`) — a KNOWN false positive on a clean
 *     case, counted against precision and held by the committed floors.
 *
 * DECISION_DATASET_VERSION is bumped on any case add/remove/relabel.
 */

import type { DecisionCase } from '../../decision-types.js';

/**
 * Semantic version of THIS decision-case set. Bump on any change.
 *
 * 1.1.0 (PR #301 review, finding 1) — `contra-restated-01` relabeled
 * contradiction→clean with `knownFalsePositiveOf: ['contradiction-rule']`:
 * a compatible restatement is ground-truth NON-contradiction, so the rule's
 * firing is a documented false positive (counted against precision, gated by
 * the measured precision floors), not a true positive inflating the
 * contradiction catch-rate.
 * 1.0.0 — initial decision set.
 */
export const DECISION_DATASET_VERSION = '1.1.0';

/** Tenant every decision case runs under (the store is per-case and ephemeral). */
export const DECISION_TENANT = 'govern-eval-tenant';

export const DECISION_CASES: readonly DecisionCase[] = [
  /* ------------------------------ DUPLICATES ------------------------------ */
  {
    id: 'dup-exact-01',
    description: 'Byte-identical content under a different title — exact-hash dedup must catch',
    decisionClass: 'duplicate',
    candidate: {
      title: 'Input validation rule (restated)',
      content: 'All API endpoints must validate input with Zod schemas before any handler runs.',
      category: 'convention',
    },
    existingActives: [
      {
        title: 'API input validation convention',
        content: 'All API endpoints must validate input with Zod schemas before any handler runs.',
        category: 'convention',
      },
    ],
    // contradiction_check deliberately SKIPS byte-identical content (dedup's
    // job) and the titles share too little for supersession — both out of scope.
    expectFiredBy: ['dedup-rule'],
  },
  {
    id: 'dup-exact-02',
    description: 'Identical content AND identical title — dedup and supersession both catch',
    decisionClass: 'duplicate',
    candidate: {
      title: 'Retry budget convention',
      content: 'Every outbound HTTP call gets at most two retries with exponential backoff.',
      category: 'convention',
    },
    existingActives: [
      {
        title: 'Retry budget convention',
        content: 'Every outbound HTTP call gets at most two retries with exponential backoff.',
        category: 'convention',
      },
    ],
    expectFiredBy: ['dedup-rule', 'supersession-detector'],
  },
  {
    id: 'dup-recased-01',
    description:
      'Re-cased duplicate (same words, different casing) — exact-hash dedup MISSES; the contradiction flag is the safety net',
    decisionClass: 'duplicate',
    candidate: {
      title: 'Result types note',
      content: 'use result types for all fallible operations in the parser core.',
      category: 'pattern',
    },
    existingActives: [
      {
        title: 'Fallible-operation convention',
        content: 'Use Result types for all fallible operations in the parser core.',
        category: 'pattern',
      },
    ],
    // SHA-256 over exact bytes: one changed letter defeats it — the documented
    // dedup blind spot. The token-overlap contradiction rule (case-insensitive)
    // sees an identical token set and flags it for review instead.
    expectFiredBy: ['contradiction-rule'],
    knownFalseNegativeOf: ['dedup-rule'],
  },

  /* ----------------------------- CONTRADICTIONS --------------------------- */
  {
    id: 'contra-inverted-policy-01',
    description: 'Direct negation of an existing convention (allowed → never allowed)',
    decisionClass: 'contradiction',
    candidate: {
      title: 'Deploy window update',
      content:
        'Production deploys are never allowed on Tuesdays and Thursdays even after the smoke suite passes.',
      category: 'convention',
    },
    existingActives: [
      {
        title: 'Production deploy window',
        content:
          'Production deploys are allowed only on Tuesdays and Thursdays after the smoke suite passes.',
        category: 'convention',
      },
    ],
    expectFiredBy: ['contradiction-rule'],
  },
  {
    id: 'contra-number-flip-01',
    description: 'Same sentence with the two retention numbers swapped (token set identical)',
    decisionClass: 'contradiction',
    candidate: {
      title: 'Backup retention note',
      content:
        'The backup retention window is 7 days for the audit log and 30 days for derived indexes.',
      category: 'reference',
    },
    existingActives: [
      {
        title: 'Retention windows',
        content:
          'The backup retention window is 30 days for the audit log and 7 days for derived indexes.',
        category: 'reference',
      },
    ],
    expectFiredBy: ['contradiction-rule'],
  },
  {
    id: 'contra-restated-01',
    description:
      'Compatible restatement of the same convention — NOT a contradiction. The v1 token heuristic still fires on it (same-topic surface, not semantics): a KNOWN false positive, kept as a clean case so the firing counts against precision instead of inflating contradiction recall',
    // Relabeled contradiction→clean under DECISION_DATASET_VERSION 1.1.0
    // (PR #301 review, finding 1): a restatement is ground-truth NON-
    // contradiction, so treating the rule's firing as a TP both inflated the
    // contradiction-class catch-rate and set a trap where FIXING the heuristic
    // would look like a regression. The firing is now a documented false
    // positive; the review-routing value of the flag is unchanged in
    // production, but the eval scores it honestly.
    decisionClass: 'clean',
    candidate: {
      title: 'Commit message rule restated',
      content:
        'Commit messages must explain what changed and why the change was needed in every commit.',
      category: 'convention',
    },
    existingActives: [
      {
        title: 'Commit message convention',
        content: 'Every commit message must explain what changed and why the change was needed.',
        category: 'convention',
      },
    ],
    expectFiredBy: [],
    knownFalsePositiveOf: ['contradiction-rule'],
  },
  {
    id: 'contra-low-overlap-01',
    description:
      'Genuine semantic contradiction phrased with different vocabulary — the token-overlap heuristic MISSES (documented v1 gap; semantic detection is deferred by design)',
    decisionClass: 'contradiction',
    candidate: {
      title: 'Where credentials belong',
      content: 'Credentials belong in the platform vault service and never inside a repository.',
      category: 'convention',
    },
    existingActives: [
      {
        title: 'Secrets storage convention',
        content: 'Secrets are stored in SOPS-encrypted files committed to git.',
        category: 'convention',
      },
    ],
    expectFiredBy: [],
    knownFalseNegativeOf: ['contradiction-rule'],
  },
  {
    id: 'contra-cross-category-01',
    description:
      'Contradicting text filed under a DIFFERENT category — the category-scoped lookup never sees it (documented blind spot)',
    decisionClass: 'contradiction',
    candidate: {
      title: 'Deploy window pattern',
      content:
        'Production deploys are never allowed on Tuesdays and Thursdays even after the smoke suite passes.',
      category: 'pattern',
    },
    existingActives: [
      {
        title: 'Production deploy window',
        content:
          'Production deploys are allowed only on Tuesdays and Thursdays after the smoke suite passes.',
        category: 'convention',
      },
    ],
    expectFiredBy: [],
    knownFalseNegativeOf: ['contradiction-rule'],
  },

  /* ------------------------------ SUPERSESSIONS --------------------------- */
  {
    id: 'sup-title-refresh-01',
    description: 'Revision of an existing memory keeping the title stem (title Jaccard 0.78)',
    decisionClass: 'supersession',
    candidate: {
      title: 'Error handling convention for the API layer 2026 revision',
      content:
        'API-layer errors are wrapped in a typed envelope with a machine-readable code and retry hint.',
      category: 'convention',
    },
    existingActives: [
      {
        title: 'Error handling convention for the API layer',
        content: 'API-layer errors bubble up as plain thrown exceptions logged at the boundary.',
        category: 'convention',
      },
    ],
    expectFiredBy: ['supersession-detector'],
  },
  {
    id: 'sup-close-title-01',
    description: 'Near-identical title with one extra word (title Jaccard 0.83)',
    decisionClass: 'supersession',
    candidate: {
      title: 'Deploy runbook for the VPS host',
      content: 'Deploys go through the Actions workflow with an OIDC-authenticated forced command.',
      category: 'reference',
    },
    existingActives: [
      {
        title: 'Deploy runbook for the VPS',
        content: 'Deploys are performed by hand over SSH from the operator laptop.',
        category: 'reference',
      },
    ],
    expectFiredBy: ['supersession-detector'],
  },
  {
    id: 'sup-reworded-title-01',
    description:
      'Same subject with a fully reworded title — title-Jaccard supersession MISSES (documented v1 gap)',
    decisionClass: 'supersession',
    candidate: {
      title: 'Rollback procedure for failed deploys',
      content:
        'When a deploy fails its smoke check the previous release is restored automatically.',
      category: 'reference',
    },
    existingActives: [
      {
        title: 'How we roll back a bad deploy',
        content: 'A failed deploy is rolled back by re-running the workflow against the prior tag.',
        category: 'reference',
      },
    ],
    expectFiredBy: [],
    knownFalseNegativeOf: ['supersession-detector'],
  },

  /* -------------------------------- CLEAN --------------------------------- */
  {
    id: 'clean-same-category-01',
    description: 'Unrelated memory in the same category — nothing may fire',
    decisionClass: 'clean',
    candidate: {
      title: 'Timezone handling convention',
      content: 'Store timestamps as UTC ISO-8601 strings and convert at the presentation edge.',
      category: 'convention',
    },
    existingActives: [
      {
        title: 'API input validation convention',
        content: 'All API endpoints must validate input with Zod schemas before any handler runs.',
        category: 'convention',
      },
    ],
    expectFiredBy: [],
  },
  {
    id: 'clean-shared-vocab-01',
    description:
      'Same domain vocabulary (deploy/CI words) but a genuinely different topic — precision probe, nothing may fire',
    decisionClass: 'clean',
    candidate: {
      title: 'Grafana dashboard generation',
      content:
        'Grafana dashboards for the deploy fleet are generated from a shared metrics package.',
      category: 'reference',
    },
    existingActives: [
      {
        title: 'CI gate ordering',
        content: 'The CI pipeline must run the full unit suite before any deploy job starts.',
        category: 'reference',
      },
    ],
    expectFiredBy: [],
  },
  {
    id: 'clean-empty-store-01',
    description: 'No existing actives at all — every state-dependent check must stay silent',
    decisionClass: 'clean',
    candidate: {
      title: 'First memory of a fresh tenant',
      content: 'The governed brain of a brand-new tenant starts with an empty curated set.',
      category: 'reference',
    },
    existingActives: [],
    expectFiredBy: [],
  },
];
