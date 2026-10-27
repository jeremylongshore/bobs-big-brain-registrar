# Registrar test audit

Diagnostic refresh dated 2026-10-27 for `compile-then-govern-6ps.19`.
Audited source: `24347cd86c4fd7f2ebe98cade03d60b89b7f7926`.
No new grade is assigned. This replaces the April snapshot as the current report;
[the previous report](https://github.com/jeremylongshore/bobs-big-brain-registrar/blob/24347cd86c4fd7f2ebe98cade03d60b89b7f7926/TEST_AUDIT.md)
remains a dated historical record. This is a diagnostic assessment, not live
acceptance, security certification or permission to operate on a production Brain.
Except for linked hosted CI and source records, local harness, scanner and
classifier observations below are author-recorded diagnostics. The extracts are
not signed records or independent attestations.

## Measured evidence

The ordinary suite passed 4,230 tests, with five optional live assertions skipped;
281 files passed and two were skipped. Coverage was 88.73% statements, 84.19%
branches, 91.17% functions and 89.83% lines, above unchanged configured floors.
The [hosted validate log](https://github.com/jeremylongshore/bobs-big-brain-registrar/actions/runs/40450724539/job/122012544648)
records these results at `7eb3aac`. The [comparison to reviewed `115bb54`](https://github.com/jeremylongshore/bobs-big-brain-registrar/compare/7eb3aacb97af0fdcdfe25fc3cd1a59c7fe99b487...115bb5418a2edbf0439ae56e3b56f84d99adaa1e)
changes only doc066. The public Git commit records for
[reviewed `115bb54`](https://api.github.com/repos/jeremylongshore/bobs-big-brain-registrar/git/commits/115bb5418a2edbf0439ae56e3b56f84d99adaa1e)
and [merged `24347cd`](https://api.github.com/repos/jeremylongshore/bobs-big-brain-registrar/git/commits/24347cd86c4fd7f2ebe98cade03d60b89b7f7926)
both name tree `300049b2939ee9c9712c55392abd417be89b3042`. These are the
source-equivalence evidence; no separately linked hosted run measured `24347cd`
in this diagnostic session. This report does not imply every named test layer
was part of the ordinary configuration.

Fourteen listed checks passed at the [reviewed source head](https://github.com/jeremylongshore/bobs-big-brain-registrar/commit/115bb5418a2edbf0439ae56e3b56f84d99adaa1e/checks),
including separate Docker integration, retrieval and governance evals, source
independence, security and documentation jobs. The reviewed head and merged
source have the same whole Git tree. Green checks establish the scope they
execute; they do not establish full corpus quality or production readiness.

## Layers: presence, configuration and measurement

| Layer                | Current source/wiring                                                                                    | Evidence limit                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| L1 hooks and CI      | Husky/lint-staged, policy-pin hook, configured validate and separate eval/integration jobs               | Hook configuration is not proof that all local actors execute hooks; this audit did not change branch protection |
| L2 static            | Format, ESLint, TypeScript, dependency-cruiser, hash verification, doc gates and security workflows      | Architecture reports zero errors and six warnings; Semgrep is advisory                                           |
| L3 unit and function | Vitest coverage gates, generated audit properties, Stryker configuration                                 | Fresh ordinary test/coverage evidence above; no fresh mutation score or executable mutation CI invocation found  |
| L4 integration       | Real SQLite, Fastify inject, OpenAPI snapshots, real-qmd fixtures and dedicated Postgres container tests | OpenAPI structure does not prove an external consumer contract; integration event scope is specified below       |
| L5 system quality    | Synthetic retrieval ratchet, provenance/govern-decision controls and security jobs                       | Synthetic/disposable success is separate from live service/corpus performance and security coverage              |
| L6 E2E               | Policy waiver retained; process/CLI/MCP integrations also exist                                          | A waiver does not mean no end-to-end-shaped tests exist; no live team acceptance inferred                        |
| L7 acceptance        | Policy waiver retained; explicit live-lane configuration exists                                          | No current human sign-off, complete journey linkage or live corpus acceptance measured here                      |

[The pinned CI configuration](https://github.com/jeremylongshore/bobs-big-brain-registrar/blob/24347cd86c4fd7f2ebe98cade03d60b89b7f7926/.github/workflows/ci.yml)
configures pushes to `main`/`develop` and pull requests targeting `main`; its
integration job accepts those push and pull-request events. This describes the
configuration, not all possible future executions. Neither a successful check
page nor this report attests branch-protection required-check settings.

The current tool/version and tracked test-path inventory is in
[tests/TESTING.md](tests/TESTING.md). The preserved classification text still
mentions Node 20; the manifest requires at least Node 22 and CI selects Node 22. Dated waiver rationale also
contains historical consumer/integration observations. The refreshed observational
inventory identifies the current wiring without changing policy or waiver terms.

## Classification and traceability

The author-recorded 1.5.1 root classifier run detected agent, CLI, hook, library, MCP,
monorepo, plugin and skill signals, with no root residue. An author-recorded pass over
all sixteen app/package manifests found eight unresolved package classifications:
edge-daemon, reporting, claude-runtime, eval-surface, policy-engine, qmd-runtime,
store and test-fixtures. Root success does not resolve these automatically.
Source inspection suggests internal library/service/runtime roles; these are
proposed refinements; they do not override emitted classifier data or adopt policy.

RTM, persona and journey documents remain declared scaffolds with historical
inferred links. No current coverage percentage was calculated. Their old claim
that the hash-chain verifier is unbuilt is contradicted by current store source
and regression/property tests. That implementation correction does not certify
all declared requirements or journeys.

## Measurement gaps and handoff

- Generic `audit-harness audit --deep` reported CRAP PASS with zero production
  and zero test methods scored. That result is excluded. The owning [TypeScript script](https://github.com/jeremylongshore/bobs-big-brain-registrar/blob/24347cd86c4fd7f2ebe98cade03d60b89b7f7926/scripts/crap-score.ts)
  measures cyclomatic complexity, excludes tests and does not establish
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
  tracked source was unchanged in that author-recorded incident. Proposed
  remediation is to reject zero-measurement verdicts and isolate output. Local
  handoff reference `compile-then-govern-8pg.1` is not a public tracker-state
  or scope attestation.
- No new test infrastructure, policy threshold, requirement tier, live capture,
  governance settlement, deployment, provider call or account change is included.

The diagnostic handoff is the explicit gap list above. It does not authorize an
automatic implementation/scaffolding pass. Any later implementation must use
its owning tracked work, policy and review boundaries.

## Diagnostic extracts and command scope

The following normalized extracts were recorded by the author on 2026-10-27 UTC
at source `115bb54`, whose tree equivalence is linked above. Source paths and
observations are retained; absolute host paths are omitted. These are authored
execution records, not raw signed tool output.

```json
{
  "command": "pnpm exec audit-harness audit --deep",
  "runner": "audit-harness@1.5.1",
  "gate_id": "audit-harness:ci:crap-score",
  "result": "PASS",
  "input_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "child_summary": {
    "language": "js",
    "production_methods_scored": 0,
    "test_methods_scored": 0,
    "pass": true
  },
  "generated_paths": [
    "reports/crap/crap-src.csv",
    "reports/crap/crap-test.csv",
    "reports/crap/summary.json"
  ]
}
```

The bundled `audit.py` describes a read-only runner; its deep branch invokes
`crap-score.py` without an output override. The child's default output directory
is `reports/crap`. The author observed those untracked files and retained their
bytes outside the checkout. No independent custody verification is claimed.

Classification commands were `pnpm exec audit-harness classify` at the root and
`pnpm exec audit-harness classify <app-or-package-directory>` for each manifest.
The normalized root result was `agent, cli, hook, library, mcp, monorepo, plugin,
skill`, with `unresolved: []`. Eight of sixteen package results were `unknown`,
each with residue kind `repo-type` and reason that no deterministic signal
matched; their names are listed above. “Unresolved” denotes classifier residue,
not a failed test, missing implementation or human policy decision.

Local follow-up checks were author-observed exits of zero for owning/stock hash
verification, escape-scan, formatting and explicit Markdown lint. Their local
logs are not published. Separately, [this refresh's hosted validate job at `94a3b63`](https://github.com/jeremylongshore/bobs-big-brain-registrar/actions/runs/40454048449/job/122023114031)
records the owning hash verification and `node --test scripts/harness-pin.node-test.mjs`.
The latter is the 33-case hash-manifest change/rejection control suite, not a
Stryker mutation-effectiveness measurement. The corresponding wrapper source is
[scripts/harness-pin.sh](scripts/harness-pin.sh).
