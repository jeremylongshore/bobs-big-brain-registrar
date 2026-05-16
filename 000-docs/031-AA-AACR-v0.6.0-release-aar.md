# Release Report: qmd-team-intent-kb v0.6.0

## Executive Summary

- **Version**: v0.5.0 → v0.6.0 (MINOR)
- **Release Date**: 2026-05-15
- **Release Type**: Minor — testing-SOP milestone + security maintenance
- **Approved By**: jeremylongshore
- **Release Commit**: `9a7fb53`
- **Tag**: `v0.6.0` (annotated)
- **Retroactive Tag**: `v0.5.0` at `836628d` (filling git-history gap; CHANGELOG and package.json had referenced 0.5.0 since 2026-04-16 but no tag was ever pushed)

## Why MINOR

- 7 `feat(test)` commits introducing the full Intent Solutions Testing SOP — every contributor PR now hits 10 enforcement gates
- 6 high-severity dev-tooling CVEs cleared (per skill rubric, `security:` → MINOR expedited)
- No breaking API changes
- +5,305 / −137 LoC across 27 files
- Pre-1.0 convention: MINOR for milestones that change the contributor experience materially

## Pre-Release State

### Pull Requests

- Merged before release: **7** (#126 #127 #128 #129 #130 #131 #132)
- Open at release time: **5** dependabot PRs (#121-#125, routine dep bumps; deferred to v0.6.1)
- Blocked: 0

### Branch State

- All feature branches deleted post-merge via `gh pr merge --delete-branch`
- Working tree clean at release time
- 5 stale dependabot branches remain on origin (each tied to an open PR)

### Security

- Vulnerabilities addressed: **6 HIGH** (was: 6 HIGH / 13 moderate / 1 low; now: 0 HIGH / 10 moderate / 1 low)
- Secrets scan: PASS (gitleaks-action@v2 on every PR; structural `.gitleaks.toml` allowlist for `.beads/` and GHSA-\* IDs)
- Dependency audit: clean at HIGH threshold; 11 moderate/low advisories remain (acceptable for dev-tooling)

## Changes Included

### Added (the testing-SOP push)

- **Batch 1 (PR #126)** — `tests/TESTING.md` policy file with classification + thresholds + waivers; `tests/RTM.md` with 7 architecture-invariant requirements (MUST) + 6 v0.5.0 capabilities (SHOULD) + 2 WON'T; husky + lint-staged pre-commit hooks; vitest coverage thresholds (line 80, branch 70, function 75, statements 80); Stryker mutation testing config; Semgrep SAST job; CLAUDE.md §Testing SOP. Plus two pre-existing tech-debt fixes folded in: missing `../curator` tsconfig project refs in `apps/api` + `apps/mcp-server` (root cause of main CI being red since 2026-04-16) and `pnpm.onlyBuiltDependencies` for `better-sqlite3` (silently breaking 451 of 1,312 tests on every clean install).
- **Batch 2 (PR #127)** — `.dependency-cruiser.cjs` encoding 6 monorepo architecture invariants as machine-verifiable import-graph rules (packages must not depend on apps; no cross-app imports except apps/curator; no circular deps; test-fixtures only importable by tests; no dist/ imports; all imports resolve); real `gitleaks-action@v2` replacing the homegrown 4-pattern regex scanner.
- **Batch 3 (PR #128)** — `tests/PERSONAS.md` declaring 6 personas (developer, curator, org-admin, auditor, operator, bot-agent) with 23 key flows and critical-tier marking; `tests/JOURNEYS.md` declaring 6 end-to-end flows (memory-capture, memory-retrieval, vault-import, policy-update, audit-verification, wiki-link-resolution) with 43 in-scope steps.
- **Batch 4 (PR #129)** — `scripts/crap-score.ts` TS-AST-aware cyclomatic-complexity scanner; walks `packages/*/src` + `apps/*/src`; reports per-package summary; CI-enforced at threshold 40 (4-point headroom over current ceiling of 36).
- **Batch 5 (PR #130)** — `testcontainers` + `@testcontainers/postgresql` + `pg` infrastructure; `tests/integration/postgres-forward-compat.test.ts` spins up `postgres:16-alpine` and validates store DDL portability with SQLite→postgres translation; separate `integration` CI job gated on main pushes + `integration`-labeled PRs.
- **Batch 6 (PR #131)** — `apps/api/src/__tests__/openapi-contract.test.ts` snapshots paths × methods, schema names, security schemes, tags; reframes Pact (wrong tool for this monorepo's shape — no service-to-service HTTP boundary) into OpenAPI snapshot contract test that gives equivalent protection without the broker weight.
- **Batch 7 (PR #132)** — `scripts/harness-pin.sh` + committed `.harness-hash`; SHA-256 manifest of 8 engineer-owned policy artifacts (TESTING, RTM, PERSONAS, JOURNEYS, `.dependency-cruiser.cjs`, `stryker.config.mjs`, `vitest.config.ts`, `scripts/crap-score.ts`); new CI step `Policy-artifact hash pin (harness-pin --verify)` fails on any silent policy-byte change.

### Changed

- `.github/workflows/ci.yml` — new steps for depcruise, CRAP, and harness-pin verify between typecheck and test
- `.github/workflows/security.yml` — broadened: gitleaks runs on every PR; `audit` + `lockfile-integrity` jobs scope to dep-touching PRs only; new Semgrep job (advisory)
- `.gitignore` — adds `.beads/export-state.json`, `.stryker-tmp/`, `reports/mutation/`
- `README.md` §Status — refreshed for v0.6.0 plug-and-play state
- `CLAUDE.md` — adds §Testing SOP section pointing to the harness + skills

### Breaking Changes

- **None.**

### Security

Six HIGH-severity dev-tooling CVEs cleared via `pnpm.overrides` + explicit `vite ^7.3.2` devDep:

| Advisory                       | Package   | Path                                            | Fix                             |
| ------------------------------ | --------- | ----------------------------------------------- | ------------------------------- |
| Picomatch ReDoS via extglob    | picomatch | knip → fast-glob → micromatch → picomatch@2.3.1 | overrides `picomatch@2: ^2.3.2` |
| Picomatch ReDoS via extglob    | picomatch | vite → fdir → picomatch@4.0.3                   | overrides `picomatch@4: ^4.0.4` |
| Vite `server.fs.deny` bypass   | vite      | vitest peer                                     | explicit `vite ^7.3.2` devDep   |
| Vite arbitrary file read (dev) | vite      | vitest peer                                     | explicit `vite ^7.3.2` devDep   |
| fast-uri path traversal        | fast-uri  | @stryker-mutator/core → ajv → fast-uri          | overrides `fast-uri ^3.1.2`     |
| fast-uri host confusion        | fast-uri  | @stryker-mutator/core → ajv → fast-uri          | overrides `fast-uri ^3.1.2`     |

All cleared deps are dev-tooling, not production runtime, but advisories at HIGH severity are blockers per the release-skill rubric.

## Documentation Updates

### README.md

- Line 82: `**v0.4.0 — Production-ready platform with supply-chain signing.**` → `**v0.6.0 — Production-ready platform with full Intent Solutions Testing SOP enforced in CI.**` plus a paragraph describing the 10 CI gates and the harness-pin policy lock

### CHANGELOG.md

- New `## [0.6.0] - 2026-05-15` section with `### Security` (CVE clearance) and `### Added` / `### Changed` / `### Fixed` covering Batches 1-7
- New empty `## [Unreleased]` for next cycle

### Gist

- Refreshed `839874771b0ac8259b0c45da9ed5dab9` (the canonical repo gist): version refs 0.4.0 → 0.6.0; added `### [0.6.0]` and `### [0.5.0]` changelog sections (v0.5.0 was missing from the gist's changelog despite having been released)
- Updated `.gist-id` to point at the canonical gist (was previously pointing at a deleted gist ID `1157a39c34b3171e039426ab792c93e3`)

## Metrics

| Metric                                        |                                   Value |
| --------------------------------------------- | --------------------------------------: |
| Commits since v0.5.0 release commit (836628d) |                                      15 |
| Files changed                                 |                                      27 |
| Lines added                                   |                                  +5,305 |
| Lines removed                                 |                                    −137 |
| Contributors                                  |                     1 (jeremylongshore) |
| Days since v0.5.0                             |                                      29 |
| Unit tests                                    |                   1,313 / 1,313 passing |
| Integration tests                             | 4 / 4 passing (real postgres container) |
| Line coverage                                 |                                  87.57% |
| Branch coverage                               |                                  78.79% |
| Function coverage                             |                                  85.62% |
| Cyclomatic complexity max                     |                       36 (threshold 40) |
| Policy artifacts hash-pinned                  |                                       8 |

## External Artifacts

| Artifact         | Status               | Details                                                                   |
| ---------------- | -------------------- | ------------------------------------------------------------------------- |
| GitHub Release   | CREATED              | https://github.com/jeremylongshore/qmd-team-intent-kb/releases/tag/v0.6.0 |
| Git Tag (v0.6.0) | PUSHED               | annotated, on commit `9a7fb53`                                            |
| Git Tag (v0.5.0) | PUSHED RETROACTIVELY | annotated, on commit `836628d` (filling history gap)                      |
| Public Gist      | REFRESHED            | https://gist.github.com/jeremylongshore/839874771b0ac8259b0c45da9ed5dab9  |
| `.gist-id`       | FIXED                | now points at the canonical gist                                          |
| AAR              | This file            | `000-docs/031-AA-AACR-v0.6.0-release-aar.md`                              |

## Quality Gates

| Gate                                     | Status                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm typecheck`                         | ✓                                                                                |
| `pnpm lint`                              | ✓                                                                                |
| `pnpm format:check`                      | ✓                                                                                |
| `pnpm depcruise` (architecture)          | ✓ (0 errors, 1 advisory warn — pre-existing orphan in `qmd-adapter/executor.ts`) |
| `pnpm crap` (complexity)                 | ✓ (max=36, 0 over threshold 40)                                                  |
| `pnpm harness-pin` (policy lock)         | ✓                                                                                |
| `pnpm test` (unit)                       | ✓ 1,313/1,313                                                                    |
| `pnpm test:integration` (testcontainers) | ✓ 4/4                                                                            |
| `pnpm audit --audit-level=high`          | ✓ 0 HIGH                                                                         |
| Documentation current                    | ✓                                                                                |
| Gist current                             | ✓ refreshed                                                                      |

## Plug-and-Play Scorecard

This release closes out the plug-and-play push that began with the 2026-04-24 audit:

| Criterion                             | Before this push           | After v0.6.0                                    |
| ------------------------------------- | -------------------------- | ----------------------------------------------- |
| At least one stable agentic interface | ✅ MCP + REST + CLI        | ✅                                              |
| Documented contract                   | partial                    | ✅ RTM + PERSONAS + JOURNEYS + OpenAPI snapshot |
| Versioned + released                  | ✅ v0.5.0                  | ✅ v0.6.0                                       |
| Reproducible from fresh clone         | ❌ broken since 2026-04-16 | ✅                                              |
| Tested under the SOP                  | ❌ 0/14                    | ✅ **14/14**                                    |
| No leaky abstractions                 | ✅                         | ✅ enforced by depcruise + harness-pin          |

**6 of 6 criteria met. qmd-team-intent-kb is plug-and-play complete.**

## Forward-Looking Beads Filed During the Push

| Bead                     | Priority | What                                              | Named Trigger                                                              |
| ------------------------ | -------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| `qmd-team-intent-kb-kmr` | P2       | Hash-chain audit-verifier primitive               | Audit-log integrity becomes a compliance requirement                       |
| `qmd-team-intent-kb-igs` | P2       | Refactor `runCycle` (36 → ≤30), tighten CRAP gate | Capacity for the refactor without breaking edge-daemon tests               |
| `qmd-team-intent-kb-2r6` | P3       | Expand L4 testcontainer coverage                  | store grows non-SQLite / app needs git-push / qmd Docker image             |
| `qmd-team-intent-kb-4zw` | P3       | Install actual Pact                               | External consumer in sibling repo with independent release cadence         |
| `qmd-team-intent-kb-tpp` | P3       | Upstream audit-harness PATTERNS PR                | OSS contribution; deletes repo-local `scripts/harness-pin.sh` when shipped |

Each carries explicit re-evaluation conditions; none block plug-and-play.

## Rollback Procedure

If issues discovered:

```bash
# Remove the GitHub release + tag
gh release delete v0.6.0 --yes
git push origin --delete v0.6.0
git tag -d v0.6.0

# Revert the release commit
git revert 9a7fb53
git push origin main

# (Optional) Remove the retroactive v0.5.0 tag if it caused issues
# git push origin --delete v0.5.0
# git tag -d v0.5.0
```

The retroactive `v0.5.0` tag is recoverable from history — if you delete it locally, recreate via `git tag -a v0.5.0 836628d -m "..."`.

## Post-Release Checklist

- [x] Tag pushed: `v0.6.0`
- [x] Retroactive tag pushed: `v0.5.0` at `836628d`
- [x] GitHub release created with full notes
- [x] Public gist refreshed
- [x] `.gist-id` updated to canonical gist
- [x] CHANGELOG section dated 2026-05-15
- [x] README §Status updated
- [x] All 14 audit-tests GH issues closed (auto-close via PR refs)
- [x] All 7 batch-umbrella beads closed with evidence
- [x] AAR written (this file)
- [ ] Monitor `pnpm audit` for new HIGH advisories on the freshly-bumped vite + override transitives
- [ ] Plan v0.6.1 fast-follow for the 5 open dependabot PRs (knip, vitest, eslint, codeql-action, etc.) — none are blockers; routine maintenance

## Notes for v0.6.1

The 5 dependabot PRs that didn't make this release window (#121-#125) are routine dev-dep bumps:

- `better-sqlite3` 12.9.0 → 12.10.0
- `vitest` 4.1.4 → 4.1.6
- `knip` 6.4.1 → 6.14.0
- `typescript-eslint` 8.58.2 → 8.59.3
- `@types/node` 25.6.0 → 25.8.0

Worth a v0.6.1 patch cycle within a week — `pnpm install` them, verify CI, ship.

The 10 moderate-severity advisories that remain after v0.6.0 are also worth eyeballing — most are transitive in test tooling.
