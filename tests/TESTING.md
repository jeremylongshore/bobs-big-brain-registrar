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

| Gate           | Tool                                 | Status                                                                                                                                                                   |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Harness        | @intentsolutions/audit-harness 0.1.0 | Installed                                                                                                                                                                |
| Format         | Prettier 3.8.3                       | Enforced in CI + pre-commit                                                                                                                                              |
| Lint           | ESLint 10.2.0 + typescript-eslint    | Enforced in CI + pre-commit                                                                                                                                              |
| Typecheck      | tsc -b (composite, strict)           | Enforced in CI                                                                                                                                                           |
| Unit test      | Vitest 4.1.4                         | Enforced in CI                                                                                                                                                           |
| Dead code      | Knip 6.4.1                           | Available, not in CI gate                                                                                                                                                |
| Coverage       | @vitest/coverage-v8 4.1.5            | Installed, 80% line / 70% branch floor                                                                                                                                   |
| Mutation       | Stryker (vitest runner)              | Installed, 70% break threshold                                                                                                                                           |
| Pre-commit     | husky 9.1.7 + lint-staged 16.4.0     | Installed                                                                                                                                                                |
| Architecture   | dependency-cruiser 17.x              | Enforced in CI (`.dependency-cruiser.cjs` — monorepo invariants)                                                                                                         |
| Complexity     | scripts/crap-score.ts (TS AST)       | Enforced in CI at threshold 30 (Wall 5 ideal; tightened from 40 after `runCycle` refactor — `qmd-team-intent-kb-igs`)                                                    |
| Secrets        | gitleaks-action v2                   | Enforced in CI on every PR                                                                                                                                               |
| SAST           | Semgrep (security.yml)               | Advisory (artifact upload)                                                                                                                                               |
| L4 Integration | testcontainers 11.x + pg client      | Enforced in CI `integration` job on push to main / `integration`-labeled PRs (see §Waived layers — partial waiver)                                                       |
| Contract       | OpenAPI snapshot (vitest)            | Enforced in CI (apps/api openapi-contract.test.ts). Replaces Pact for this repo — see §Contract testing                                                                  |
| Policy pin     | scripts/harness-pin.sh               | Enforced in CI (Wall 7) — SHA-256 hash of every engineer-owned policy artifact; AI can't silently change policy without an engineer-initiated re-pin. See §Hash manifest |

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

| Package                 | Framework               | Test files |
| ----------------------- | ----------------------- | ---------- |
| packages/schema         | Vitest                  | 8          |
| packages/common         | Vitest                  | 6          |
| packages/store          | Vitest                  | 11         |
| packages/claude-runtime | Vitest                  | 15         |
| packages/policy-engine  | Vitest                  | 8          |
| packages/qmd-adapter    | Vitest                  | 10         |
| packages/repo-resolver  | Vitest                  | 6          |
| apps/api                | Vitest + Fastify inject | 13         |
| apps/curator            | Vitest                  | 12         |
| apps/edge-daemon        | Vitest                  | 9          |
| apps/git-exporter       | Vitest                  | 7          |
| apps/reporting          | Vitest                  | 5          |
| apps/mcp-server         | Vitest                  | 6          |

## Last audit

- **Date**: 2026-04-24
- **Grade**: B+ (88/100) — post-remediation
- **Tests**: 1,312 passing across 119 files
- **P0 gaps**: 0
- **P1 gaps**: 0 (all remediated by implement-tests)
- **Remediated**: audit harness, pre-commit hooks, coverage gate, mutation testing, SAST

## Traceability

| Artifact            | Status                    | Notes                                                                                                                              |
| ------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `tests/RTM.md`      | Seeded (Batch 1, PR #126) | 7 architecture-invariant requirements (MUST) + 6 v0.5.0 capability requirements (SHOULD) + 2 WON'T entries. Linking pass deferred. |
| `tests/PERSONAS.md` | Seeded (Batch 3, this PR) | 6 personas declared (developer, curator, org-admin, auditor, operator, bot-agent). 23 declared flows. Linking pass deferred.       |
| `tests/JOURNEYS.md` | Seeded (Batch 3, this PR) | 6 journeys declared. 43 in-scope steps. 2 real coverage gaps (hash-chain verifier); 1 blocked by Epic 16 (ICOS→qmd bridge).        |

**Linking infrastructure not yet wired.** The three artifacts above declare the _intent_ — what the system serves and what flows matter — but tests don't yet carry persona/flow/REQ-id annotations, so coverage % can't be computed automatically. Next pass: decide annotation convention (JSDoc on `describe` blocks recommended), then `rtm-builder-agent` / `persona-coverage-agent` / `journey-mapper-agent` walk tests and populate the linked columns.

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
