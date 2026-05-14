# Test Audit Report — qmd-team-intent-kb

**Date**: 2026-04-24
**Classification**: Monorepo-package (pnpm workspace, 8 packages + 6 apps)
**Stack**: TypeScript 5.7, Node 20, Vitest 4.1.4, ESLint 10.2, Prettier 3.8
**Grade**: C+ (72/100)

## Freshness

- audit-harness: not installed (latest: 0.1.0)

## Metrics

| Metric                 | Value                   |
| ---------------------- | ----------------------- |
| Test files             | 119                     |
| Source files           | 159                     |
| Test-to-source ratio   | 0.75                    |
| Tests passing          | 1,312                   |
| Test files per package | all packages have tests |
| Coverage threshold     | **none configured**     |
| Mutation testing       | **not present**         |
| Pre-commit hooks       | **not enforced**        |
| Architecture rules     | **not present**         |

## Layer Assessment

| Layer                 | Status   | Detail                                              | Gap    |
| --------------------- | -------- | --------------------------------------------------- | ------ |
| L1 — Git hooks & CI   | Partial  | CI present (5 workflows), no pre-commit hooks       | P1     |
| L2 — Static analysis  | Enforced | ESLint + Prettier + tsc strict + Knip in CI         | OK     |
| L3 — Unit & function  | Present  | Vitest, 119 files, 1312 tests, no coverage gate     | P1     |
| L4 — Integration      | Present  | API inject tests, SQLite in-memory, policy pipeline | OK     |
| L5 — System quality   | Partial  | Custom secret regex, no SAST (Semgrep), no perf     | P1     |
| L6 — E2E / BDD        | Waived   | CLI-first backend, no UI — E2E not applicable       | Waived |
| L7 — Acceptance / UAT | Waived   | No user-facing frontend — Gherkin not applicable    | Waived |

## P0 Gaps (blocking)

None. All core functionality is tested. CI gate (`pnpm validate`) runs format + lint + typecheck + test on every PR.

## P1 Gaps (high priority)

| #   | Layer | Gap                                                                | Remediation                                                  |
| --- | ----- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1   | L1    | No pre-commit hooks — lint/format/typecheck can be skipped locally | Install husky + lint-staged                                  |
| 2   | L3    | No coverage threshold — coverage collected but not gated           | Add `@vitest/coverage-v8`, set 80% floor in vitest.config.ts |
| 3   | L3    | No mutation testing — false-negative tests not detected            | Install Stryker                                              |
| 4   | L5    | No SAST — custom regex patterns, no Semgrep/CodeQL                 | Add Semgrep to security.yml                                  |
| 5   | L1    | No `@intentsolutions/audit-harness` installed                      | `pnpm add -D @intentsolutions/audit-harness`                 |

## P2 Gaps (advisory)

| #   | Layer | Gap                                                                                      |
| --- | ----- | ---------------------------------------------------------------------------------------- |
| 1   | L4    | No Docker-based integration tests (testcontainers) — SQLite in-memory sufficient for now |
| 2   | L5    | No performance/load testing                                                              |
| 3   | L3    | No CRAP score threshold                                                                  |

## Architecture Verification

- `packages/schema` and `packages/common` are proper leaves (zero internal imports) — correct
- Dependency direction follows the documented graph (schema → common → store → api)
- No circular dependencies detected
- Knip configured for dead code detection across all workspaces

## CI Workflow Coverage

| Workflow          | Trigger                      | Gates                                               |
| ----------------- | ---------------------------- | --------------------------------------------------- |
| ci.yml            | push/PR to main/develop      | format + lint + typecheck + test                    |
| security.yml      | lockfile changes + manual    | npm audit + lockfile integrity + secret scan        |
| nightly.yml       | schedule (disabled) + manual | full validate + build + audit + outdated            |
| release.yml       | tag v\*                      | validate + CHANGELOG check + Docker + cosign + SLSA |
| gemini-review.yml | PR                           | AI code review                                      |

## RTM Summary

No `tests/RTM.md` exists. Requirements traceability not established. Advisory — not blocking for a pre-v1.0 project.

## Escape-Scan

No staged diff — clean working tree on main.

## Recommendation

This is a well-tested monorepo with 1,312 passing tests and comprehensive CI. The primary gaps are enforcement (no local gates to prevent pushing untested code) and measurement (no coverage or mutation thresholds). The test-to-source ratio of 0.75 is healthy for a backend system.

**Next action**: Install audit harness and coverage tooling. Handoff to `implement-tests` for P1 gap remediation.
