# Registrar test audit

Diagnostic refresh dated 2026-10-27 for `compile-then-govern-6ps.19`.
Audited source: `24347cd86c4fd7f2ebe98cade03d60b89b7f7926`.
No new grade is assigned. This replaces the April snapshot as the current report;
[the previous report](https://github.com/jeremylongshore/bobs-big-brain-registrar/blob/24347cd86c4fd7f2ebe98cade03d60b89b7f7926/TEST_AUDIT.md)
remains a dated historical record. This is a diagnostic assessment, not live
acceptance, security certification or permission to operate on a production Brain.

## Measured evidence

The ordinary suite passed 4,230 tests, with five optional live assertions skipped;
281 files passed and two were skipped. Coverage was 88.73% statements, 84.19%
branches, 91.17% functions and 89.83% lines, above unchanged configured floors.
The [hosted validate log](https://github.com/jeremylongshore/bobs-big-brain-registrar/actions/runs/40450724539/job/122012544648)
records these results at `7eb3aac`. The later settlement follow-up changed only
doc066; the executable source and tests stayed unchanged. Local serial coverage
also returned these counts. This report does not imply every named test layer
was part of that ordinary configuration.

All fourteen required checks passed at the [reviewed source head](https://github.com/jeremylongshore/bobs-big-brain-registrar/commit/115bb5418a2edbf0439ae56e3b56f84d99adaa1e/checks),
including separate Docker integration, retrieval and governance evals, source
independence, security and documentation jobs. The reviewed head and merged
source have the same whole Git tree. Green checks establish the scope they
execute; they do not establish full corpus quality or production readiness.

## Layers: presence, configuration and measurement

| Layer                | Current source/wiring                                                                                    | Evidence limit                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| L1 hooks and CI      | Husky/lint-staged, policy-pin hook, required validate and separate eval/integration jobs                 | Hook configuration is not proof that all local actors execute hooks; this audit did not change branch protection |
| L2 static            | Format, ESLint, TypeScript, dependency-cruiser, hash verification, doc gates and security workflows      | Architecture reports zero errors and six warnings; Semgrep is advisory                                           |
| L3 unit and function | Vitest coverage gates, generated audit properties, Stryker configuration                                 | Fresh ordinary test/coverage evidence above; no fresh mutation score or executable mutation CI invocation found  |
| L4 integration       | Real SQLite, Fastify inject, OpenAPI snapshots, real-qmd fixtures and dedicated Postgres container tests | OpenAPI structure does not prove an external consumer contract; dedicated integration runs on every PR/push      |
| L5 system quality    | Synthetic retrieval ratchet, provenance/govern-decision controls and security jobs                       | Synthetic/disposable success is separate from live service/corpus performance and security coverage              |
| L6 E2E               | Policy waiver retained; process/CLI/MCP integrations also exist                                          | A waiver does not mean no end-to-end-shaped tests exist; no live team acceptance inferred                        |
| L7 acceptance        | Policy waiver retained; explicit live-lane configuration exists                                          | No current human sign-off, complete journey linkage or live corpus acceptance measured here                      |

The current tool/version and tracked test-path inventory is in
[tests/TESTING.md](tests/TESTING.md). The preserved classification text still
mentions Node 20; the current manifest/CI use Node 22. Dated waiver rationale also
contains historical consumer/integration observations. The refreshed observational
inventory identifies the current wiring without changing policy or waiver terms.

## Classification and traceability

The installed 1.5.1 root classifier detected agent, CLI, hook, library, MCP,
monorepo, plugin and skill signals, with no root residue. A separate pass over
all sixteen app/package manifests found eight unresolved package classifications:
edge-daemon, reporting, claude-runtime, eval-surface, policy-engine, qmd-runtime,
store and test-fixtures. Root success does not resolve these automatically.
Source inspection suggests internal library/service/runtime roles; these are
proposed refinements, not adopted policy or changes to classifier output.

RTM, persona and journey documents remain declared scaffolds with historical
inferred links. No current coverage percentage was calculated. Their old claim
that the hash-chain verifier is unbuilt is contradicted by current store source
and regression/property tests. That implementation correction does not certify
all declared requirements or journeys.

## Measurement gaps and handoff

- Generic `audit-harness audit --deep` reported CRAP PASS with zero production
  and zero test methods scored. That result is excluded. The owning TypeScript
  script measures cyclomatic complexity, excludes tests and does not establish
  coverage-weighted production/test/average CRAP floors.
- Current mutation effectiveness, test/average CRAP and complete requirements,
  persona and journey linkage remain unmeasured. No full-audit clean verdict is
  issued and no missing score is replaced by a grade.
- Local generic scanning found gitleaks/README/link checks available, while OSV,
  standalone markdownlint and j-rig measurements were unavailable. Source CI has
  its own doc/security tools. A generic scanner exit of zero is not complete
  security assurance; inspect each gate-result and owning check independently.
- Generic deep audit unexpectedly wrote report files despite its read-only
  description. The known generated files were preserved outside the checkout;
  tracked source was unchanged. Remediation request `compile-then-govern-8pg.1`
  covers zero-measurement verdicts and output isolation.
- No new test infrastructure, policy threshold, requirement tier, live capture,
  governance settlement, deployment, provider call or account change is included.

The diagnostic handoff is the explicit gap list above. It does not authorize an
automatic implementation/scaffolding pass. Any later implementation must use
its owning tracked work, policy and review boundaries.
