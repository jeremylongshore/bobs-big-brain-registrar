# Testing Strategy — qmd-team-intent-kb

## Classification

- **Repo type**: Monorepo-package (pnpm workspace)
- **Stack**: TypeScript 5.7, Node 20, ESM
- **Compliance overlay**: None

## Thresholds

| Metric          | Floor | Note                                                                                                                               |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| coverage.line   | 80    |                                                                                                                                    |
| coverage.branch | 70    |                                                                                                                                    |
| mutation.kill   | 70    |                                                                                                                                    |
| crap.prod       | 30    | Wall 5 ideal. Tightened from 40 once `apps/edge-daemon` `runCycle` was refactored 36 → thin coordinator (`qmd-team-intent-kb-igs`) |
| crap.test       | 15    |                                                                                                                                    |
| crap.average    | 10    |                                                                                                                                    |

## Waived layers

- L6 (E2E/BDD) — CLI-first backend with no UI; API tested via Fastify inject
- L7 (Acceptance/UAT) — no user-facing frontend; governance validated by policy-engine unit tests

### Contract testing — Pact replaced by OpenAPI snapshot (Batch 6)

Per `qmd-team-intent-kb-apt`, a Pact-tool install would be the wrong fit for this monorepo. A 2026-05-15 survey confirmed: no service-to-service HTTP boundary exists internally (`apps/mcp-server` imports `@qmd-team-intent-kb/store` and `curator` in-process; every cross-module call is TypeScript-imports-with-shared-types). The only HTTP surface is `apps/api`'s REST endpoints, exposed for eventual external consumers — but no consumer code lives in this repo or any sibling yet.

Pact's value (catching breaking changes across deployment boundaries with different release cadences) has no current target. But the `apps/api` surface still wants stability — an SDK generator pointing at `/openapi.json` should not see surprise schema changes between releases.

**Shipped instead:** `apps/api/src/__tests__/openapi-contract.test.ts` — snapshots the structural parts of the OpenAPI 3.1 spec (paths × methods, schema names, security schemes, tag names). Any unintentional change to the API surface fails CI until a contributor explicitly runs `pnpm vitest --update-snapshots` and the diff becomes a code-review signal.

**Forward trigger to install actual Pact:** when an external consumer repo (SDK, web UI, partner integration) is created AND that consumer is deployed independently from `apps/api` with a different release cadence. Tracked in `qmd-team-intent-kb-4zw`.

### L4 — partial waiver on container-based integration (Batch 5)

Per the 2026-04-24 audit and a 2026-05-15 re-survey, this repo has no current code path with a real-service dependency that testcontainers buys us:

| Surface                         | Reality                                                                                            | Container needed? |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------- |
| `packages/store` ↔ SQLite       | SQLite is a file, not a service. Real-SQLite via temp files already covers L4.                     | No                |
| `apps/api` ↔ `store`            | Fastify inject (in-process, real store).                                                           | No                |
| `apps/curator`                  | Pure file operations.                                                                              | No                |
| `apps/git-exporter`             | Explicit: "Does NOT run git commit or git push — file generation only."                            | No                |
| `apps/mcp-server`               | stdio MCP protocol; in-process.                                                                    | No                |
| `apps/edge-daemon` ↔ qmd binary | Intentionally skipped via `describe.skipIf(!qmdAvailable)`. No public qmd Docker image exists yet. | Future            |
| `apps/edge-daemon` ↔ git remote | Currently mocked.                                                                                  | Future            |

**One demonstrative integration test ships in Batch 5** (`tests/integration/postgres-forward-compat.test.ts`) — spins up `postgres:16-alpine` via testcontainers, applies the store DDL (with SQLite→postgres translation), exercises insert / select / UNIQUE-constraint round-trips. Purpose: establish the testcontainers + Docker-in-CI pattern as a reference, and surface dialect-specific SQL early (today: `DEFAULT (datetime('now'))` is the only SQLite-ism).

**Trigger conditions to expand L4 integration testing:**

| Trigger                                                           | What to add                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/store` grows a non-SQLite backend                       | Promote the postgres forward-compat test from "demonstrative" to "executed against the real production driver."         |
| `apps/git-exporter` (or any other app) grows a real git-push step | Add a `gitea/gitea` container test for the push cycle.                                                                  |
| Public qmd Docker image becomes available                         | Replace `describe.skipIf(!qmdAvailable)` blocks with a real `QmdContainer` in `packages/qmd-adapter` integration tests. |

The integration test suite lives at `tests/integration/`, runs under `pnpm test:integration` (separate config `vitest.integration.config.ts`), and is gated as a dedicated CI job (`integration`) that fires on push to main and on PRs labeled `integration`. It does not run in the fast `validate` loop.

## Installed gates

Observed 2026-10-27 at source tree `24347cd` (Node 22 in CI). The policy
classification and dated waiver rationale above are preserved. Their historical
statements about absent external consumers and label-only integration do not
describe the current wiring below; this audit does not change those waivers.

| Gate                       | Current source/configuration                                                                  | Measurement or limit                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Harness                    | Installed `@intentsolutions/audit-harness` 1.5.1; stock and owning wrapper share one manifest | Both verification entry points pass                                                              |
| Format/lint/types          | Prettier 3.9.9, ESLint 10.12.0, TypeScript 5.9.3; CI uses Node 22                             | Required validate job; lint-staged also runs format/lint                                         |
| Unit and coverage          | Vitest/coverage-v8 5.0.3                                                                      | CI enforces 80 statements/80 lines/70 branches/75 functions                                      |
| Mutation                   | Stryker configuration with break threshold 70                                                 | No executable mutation invocation found in checked-in workflows; current score not measured      |
| Hooks                      | Husky and lint-staged 17.6.0, policy-change and Beads shims                                   | Hook presence does not prove local execution cannot be bypassed                                  |
| Architecture               | dependency-cruiser                                                                            | CI result: zero errors, six warnings                                                             |
| Complexity                 | `scripts/crap-score.ts`, TypeScript AST cyclomatic complexity                                 | CI threshold 30; not coverage-weighted CRAP and excludes tests                                   |
| Secrets/SAST               | gitleaks and Semgrep workflow                                                                 | Inspect individual check semantics; Semgrep is advisory                                          |
| Integration                | testcontainers 12.2.0/Postgres; real SQLite, Fastify inject, qmd fixtures                     | Dedicated integration job runs on every PR and push; excluded from ordinary Vitest configuration |
| Contract                   | OpenAPI snapshot                                                                              | Structural API regression signal; not a verified external consumer contract                      |
| Retrieval/governance evals | Required `retrieval-eval` and `moat-evals` jobs                                               | Synthetic/disposable acceptance; separate from live corpus/service lanes                         |
| Dead code                  | Knip 6.39.0                                                                                   | Available tooling, not a required CI invocation here                                             |
| Policy pin                 | `scripts/harness-pin.sh` and stock verifier                                                   | Whole-file pins include this document; hashes detect drift, not reviewer identity                |

The generic `audit-harness audit --deep` CRAP result is excluded: it reported
PASS while scoring zero production and zero test methods. Its default child
also wrote local reports despite the audit command's read-only description.
The generated files were retained outside the checkout; no policy or source
change was accepted from that run. Tracked under `compile-then-govern-8pg.1`.
OSV and j-rig measurements were unavailable in this diagnostic session. Missing
standalone markdownlint on PATH does not negate the separate owning docs CI.

## Hash manifest

`scripts/harness-pin.sh` delegates to the installed stock audit-harness verifier.
Both `pnpm harness-pin` and `pnpm exec audit-harness verify` check the same
`.harness-hash`. Stock defaults plus `.harness-hash-extra-patterns` select the
protected files. All eight original policy paths remain covered:

| Original pinned file      | Why it is policy                             |
| ------------------------- | -------------------------------------------- |
| `tests/TESTING.md`        | Thresholds, classification, waivers          |
| `tests/RTM.md`            | Requirements with MoSCoW tags                |
| `tests/PERSONAS.md`       | Persona declarations and critical-tier flags |
| `tests/JOURNEYS.md`       | End-to-end journey contracts                 |
| `.dependency-cruiser.cjs` | Architecture rules                           |
| `stryker.config.mjs`      | Mutation-testing thresholds                  |
| `vitest.config.ts`        | Coverage thresholds                          |
| `scripts/crap-score.ts`   | Complexity threshold                         |

The stock defaults additionally protect `package.json` and the checked-in
`.github/workflows/*.yml` / `*.yaml` files. The additive selector, compatibility
wrapper and Node mutation-control script are pinned too. The checked-in
manifest is the exact current inventory; matching new default-pattern files
also require an explicit reviewed re-pin. This consolidation changes protection
coverage, not existing test thresholds, requirements, personas or waivers.

### Why this matters

The AI agent assisting in this repo can update **observational** sections (Installed gates, Last audit, Traceability counts, test files) freely. But it cannot silently change **policy** (thresholds, MoSCoW tags, waiver rationale, architecture rules) without leaving a visible trail.

The CI step `Policy-artifact hash pin (harness-pin --verify)` fails if any pinned file's bytes change without a fresh `.harness-hash`. To re-pin (engineer-initiated, with full review):

```bash
pnpm harness-pin:init     # re-pin: writes new SHA-256s to .harness-hash
git add .harness-hash <the policy file you changed>
git commit -m "policy: <what changed and why>"
```

The diff in the commit makes the policy change visible at code-review time. An AI-proposed PR that touches a pinned file without also updating `.harness-hash` fails CI.

### One verifier and explicit initialization

The former local pattern implementation is retired. Installed audit-harness
1.5.1 supports additive extra patterns, so retaining a separate implementation
would let the owning and stock commands disagree. The small wrapper preserves
the existing `--verify`, `--init` and `--list` entrypoints. It refuses alternate
`MANIFEST` values; use `ROOT` to select an isolated fixture checkout. Missing
verifiers or manifests refuse verification without installing or initializing.

`node --test scripts/harness-pin.node-test.mjs` runs in CI. Private copied-file
fixtures check both commands against intact input, mutations of every protected
file, removal of an extra-pattern entry or selector file, newly matched default
files, explicit initialization/listing, missing manifests, alternate manifests,
unsupported arguments and a missing installed verifier. The tests assert an
independent minimum of retained policy/enforcement paths; additional mutation
inputs derive from the manifest. Adding a correctly selected custom path does
not require a second complete test inventory. Production selection remains the
stock defaults plus additive selector, with one hash manifest.

These tripwires detect protected bytes that differ from the manifest. Approval
of coordinated file-and-manifest updates remains a repository review and branch
policy matter. A maintainer who changes the manifest or installed verifier remains
inside the local trust boundary; the hashes do not authenticate physical reviewers.

## Frameworks

Vitest runs the workspace source tests; standalone Node controls and Docker
integration have distinct commands. The following inventory counts tracked
`*.test.ts` paths at the audited source tree, not executed tests or coverage:

| Package                 | Tracked test paths |
| ----------------------- | -----------------: |
| apps/api                |                 37 |
| apps/curator            |                 45 |
| apps/edge-daemon        |                 14 |
| apps/git-exporter       |                 13 |
| apps/mcp-server         |                 14 |
| apps/reporting          |                  7 |
| packages/claude-runtime |                 17 |
| packages/common         |                 12 |
| packages/eval-surface   |                  5 |
| packages/policy-engine  |                 17 |
| packages/qmd-adapter    |                 49 |
| packages/qmd-runtime    |                  0 |
| packages/repo-resolver  |                  5 |
| packages/schema         |                 10 |
| packages/store          |                 29 |
| packages/test-fixtures  |                  1 |

A zero in this filename inventory does not establish absence of runtime tests
elsewhere. Root scripts and dedicated integration files are outside this table.

## Last audit

- **Date:** 2026-10-27; diagnostic refresh for `compile-then-govern-6ps.19`.
- **Source:** `24347cd86c4fd7f2ebe98cade03d60b89b7f7926`; same whole tree as reviewed `115bb54`.
- **Executed ordinary suite:** 4,230 passed, five optional live assertions skipped;
  281 test files passed and two skipped. Separate Docker integration passed in CI.
- **Coverage:** 88.73% statements, 84.19% branches, 91.17% functions, 89.83% lines.
- **Public evidence:** [validate job](https://github.com/jeremylongshore/bobs-big-brain-registrar/actions/runs/40450724539/job/122012544648)
  at unchanged executable source `7eb3aac`; subsequent settlement follow-up was doc-only.
- **Grade:** not assigned. The April 24 numeric grades and 1,312-test snapshot are historical.
- **Unmeasured:** current mutation score, true production/test/average CRAP,
  complete requirements/persona/journey linkage and live acceptance.
- **Report:** [TEST_AUDIT.md](../TEST_AUDIT.md).

## Traceability

`tests/RTM.md`, `tests/PERSONAS.md` and `tests/JOURNEYS.md` retain their declared
requirements, tiers, personas and journeys. This audit did not regenerate them
or adopt new MoSCoW values. Their historical counts and inferred links do not
establish a current measured coverage percentage.

Some historical persona/journey text still describes the hash-chain verifier as
unbuilt. Current implementation and regression/property tests exist in
`packages/store/src/audit-verify.ts` and its tests. The historical gap label is
not a current implementation verdict, and implementation alone does not prove
every declared journey complete. Test-to-requirement, persona and journey
linkage needs its own explicit verification before reporting percentages.

## Explicit live retrieval acceptance

The ordinary `pnpm test` / `pnpm test:coverage` lane creates a private per-file
worker brain, empty brainignore and XDG directories before test modules load.
A run-owned parent directory is removed by global teardown even when a fully
skipped file never runs its suite cleanup hooks.
HOME and toolchain paths stay unchanged. Documented operator routing/auth
variables are isolated; individual fixtures still set and restore their own
settings. The three live suites never infer authorization from an available
port, executable or existing index. Their dataset integrity checks remain in the
ordinary lane; live assertions require an exact `1` opt-in and the separate
configuration below. Values such as `false` do not opt in.

Run a live lane deliberately, with explicit settings. These commands execute
real services or corpus queries and are separate acceptance obligations; normal
unit runs do not execute them:

```bash
TEAMKB_TEST_LIVE_DENSE=1 \
  TEAMKB_TEST_LIVE_DENSE_URL=http://127.0.0.1:8098 \
  pnpm exec vitest run --config vitest.live.config.ts dense-live-integration

TEAMKB_TEST_LIVE_RERANK=1 \
  TEAMKB_TEST_LIVE_RERANK_URL=http://127.0.0.1:8097 \
  pnpm exec vitest run --config vitest.live.config.ts rerank-live-integration

TEAMKB_TEST_LIVE_RETRIEVAL=1 \
  TEAMKB_TEST_LIVE_BASE_PATH=/absolute/approved/source \
  TEAMKB_TEST_LIVE_TENANT_ID=approved-tenant \
  TEAMKB_TEST_LIVE_QMD_BIN=/absolute/approved/qmd \
  pnpm exec vitest run --config vitest.live.config.ts eval-retrieval-live
```

The embedder/reranker URLs must match the existing pinned loopback endpoints.
Missing requested service configuration fails the requested lane rather than
turning it into a successful skip. Explicit retrieval requires a source export
tree and trusted executable, then copies regular exports into owned scratch and
rebuilds derived qmd/native indexes there. Source indexes, registry and state DBs
are excluded from copying and worker routing. Its worker has private HOME/XDG/cwd and explicit tenant
`INDEX_PATH` / `QMD_CONFIG_DIR` before any probe. It reports a copied corpus rather
than reproducing the source's existing live index; it is not a pure BM25 promise.
The query set, model configurations, assertions and coverage thresholds remain
unchanged. See [copy bounds, cleanup and proof scope](../000-docs/059-AT-TEST-disposable-retrieval-copy.md),
including retained scratch when writer ownership is uncertain. Dense/rerank
service lanes retain their separate explicit service configuration.

Fixture-only real-qmd integrations use the workspace-pinned executable through
shared test helpers, explicit tenant-owned `INDEX_PATH` / `QMD_CONFIG_DIR` and
`--index index`. The selector stays after command options and before a query's
`--` terminator, preserving maintenance timeouts and literal query text. These
helpers create the private DB parent directories that qmd's explicit index-path
override does not create. Operator `TEAMKB_QMD_BIN` / `BBB_QMD_BIN` overrides
are removed from the ordinary fixture baseline. This test binding does not
change the production resolver or patch a global/deployed qmd installation.
