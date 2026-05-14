# Testing Strategy — qmd-team-intent-kb

## Classification

- **Repo type**: Monorepo-package (pnpm workspace)
- **Stack**: TypeScript 5.7, Node 20, ESM
- **Compliance overlay**: None

## Thresholds

| Metric          | Floor |
| --------------- | ----- |
| coverage.line   | 80    |
| coverage.branch | 70    |
| mutation.kill   | 70    |
| crap.prod       | 30    |
| crap.test       | 15    |
| crap.average    | 10    |

## Waived layers

- L6 (E2E/BDD) — CLI-first backend with no UI; API tested via Fastify inject
- L7 (Acceptance/UAT) — no user-facing frontend; governance validated by policy-engine unit tests

## Installed gates

| Gate         | Tool                                 | Status                                 |
| ------------ | ------------------------------------ | -------------------------------------- |
| Harness      | @intentsolutions/audit-harness 0.1.0 | Installed                              |
| Format       | Prettier 3.8.3                       | Enforced in CI + pre-commit            |
| Lint         | ESLint 10.2.0 + typescript-eslint    | Enforced in CI + pre-commit            |
| Typecheck    | tsc -b (composite, strict)           | Enforced in CI                         |
| Unit test    | Vitest 4.1.4                         | Enforced in CI                         |
| Dead code    | Knip 6.4.1                           | Available, not in CI gate              |
| Coverage     | @vitest/coverage-v8 4.1.5            | Installed, 80% line / 70% branch floor |
| Mutation     | Stryker (vitest runner)              | Installed, 70% break threshold         |
| Pre-commit   | husky 9.1.7 + lint-staged 16.4.0     | Installed                              |
| Architecture | —                                    | Not installed                          |
| SAST         | Semgrep (security.yml)               | Installed                              |

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

No RTM, personas, or journeys documentation established yet.
