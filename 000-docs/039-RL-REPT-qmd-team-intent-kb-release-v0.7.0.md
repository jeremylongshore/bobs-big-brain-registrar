# Release Report: qmd-team-intent-kb v0.7.0

## Executive Summary

- **Version**: 0.7.0 (from 0.6.0)
- **Release Date**: 2026-06-19
- **Release Type**: MINOR (21 feat, 5 fix, 0 breaking)
- **Tag**: `v0.7.0` → release commit `30c286c`
- **Distribution**: tag-only (root package is `private: true` — no npm publish)
- **Theme**: retrieval-backend foundations

The first release since v0.6.0 (2026-05-15) — a month of work, headlined by the
**`0t9` retrieval stack** and the governance/audit substrate around it.

## Changes Included

### Features (21)

- **Retrieval foundations (`0t9`)** — native FTS5 (BM25) backend dropping the external qmd
  binary (#192); backend-agnostic Recall@10 / nDCG@10 eval harness (#191); SHA-256-pinned,
  fail-closed model-weight verification (#190). ADR: `000-docs/038-AT-DECR`.
- **Audit substrate** — external anchor log detecting silent full-chain rewrites (#187);
  audit-events hash chain + `verify-audit-chain` CLI (#154); spool-manifest SHA-256 verify +
  quarantine (#156).
- **Governance pipeline** — `curator-cli` ingest → policy → promote (#153); `evalCallback` →
  eval-result events (#168); QMD functional eval surface (#167) + eval-result audit action (#166).
- **Surfaces** — `exporter-cli` + real-qmd demo stages 5-6 (#158); weekly cited-query report
  (#186); self-contained marketplace MCP client; `intent-brain` plugin (`/brain`,
  `/brain-promote`); `teamkb_search` MCP tool; qmd-cited search; quickstart.
- **Auth** — per-user tokens, admin-only write gate, per-read access audit.

### Fixes (5)

- Codecov upload soft-fails on Dependabot PRs (withheld-secrets blocker) (#193).
- qmd installed in CI for qmd-gated integration tests (#160); git-exporter→qmd layout bridge
  (#159); compile-then-govern URL corrected to the `intent-solutions-io` org.

### Security

- Tenant-scoped the audit read API — closed a cross-tenant audit-log leak (#169).

### Breaking Changes

- None.

## Metrics

| Metric                   | Value                            |
| ------------------------ | -------------------------------- |
| Commits (v0.6.0..v0.7.0) | 80                               |
| Files changed            | 164                              |
| Contributors             | jeremylongshore, dependabot[bot] |
| Days since last release  | 35                               |

## Quality Gates

| Gate                                                                | Status                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------ |
| CHANGELOG (Keep a Changelog, dated header, 4 sections / 19 bullets) | ✓                                                            |
| SemVer monotonic bump (0.6.0 → 0.7.0)                               | ✓                                                            |
| Version consistency (package.json ↔ CHANGELOG)                      | ✓                                                            |
| Secrets scan                                                        | ✓ (AKIA hits are AWS doc-example keys in detection fixtures) |
| Working tree clean at release                                       | ✓                                                            |

## External Artifacts

| Artifact                                             | Status             | Details                                                                                 |
| ---------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| Git tag `v0.7.0`                                     | ✓ created + pushed | annotated, on `30c286c`                                                                 |
| GitHub release                                       | ✓ created          | …/releases/tag/v0.7.0                                                                   |
| Public gist (one-pager + operator audit + changelog) | ⚠ STALE            | `839874771b0ac8259b0c45da9ed5dab9` — changelog section predates v0.7.0; refresh pending |

## Notes / Lessons

- **Stale-local-main recurred.** Dependabot grouped merges landed on `origin/main`
  server-side mid-release; the first `git push` of the release commit was rejected (local
  main behind). Recovered by rebasing the release commit onto `origin/main`, re-pointing the
  annotated tag to the rebased SHA, and force-updating the remote tag. Lesson: `git fetch` +
  compare against `origin/main` immediately before tagging.

## Rollback Procedure

```bash
git push origin --delete v0.7.0
git tag -d v0.7.0
gh release delete v0.7.0 --yes
git revert 30c286c && git push origin main
```
