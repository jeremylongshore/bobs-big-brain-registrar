# Phase 6 After Action Review — Git Export Mirror

## Date

2026-03-18

## Scope

Phase 6 implemented the git export mirror: formatting curated memories as Markdown with YAML frontmatter, mapping to directory structure, detecting incremental changes, and writing files idempotently.

## What Was Delivered

### Git Exporter (`apps/git-exporter`)

- **Frontmatter Formatter**: String-templated YAML (no yaml library). Deterministic key order, quoted strings, handles escaping for colons/quotes in titles.
- **Markdown Formatter**: Full document: `---frontmatter---\n\n# Title\n\nContent\n`. Filename: `{id}.md`.
- **Directory Mapper**: Category-based routing: decision→`decisions/`, pattern/convention/architecture→`curated/`, troubleshooting/reference/onboarding→`guides/`. Deprecated/archived/superseded→`archive/` regardless of category.
- **Change Detector**: Queries memories updated since last export. First run = all lifecycle states. Uses `ExportStateRepository` for incremental tracking.
- **File Writer**: Sync filesystem operations. Creates directories as needed. Archive removes old location, writes new.
- **Exporter Orchestrator**: Detect changes → write/archive → update export state. Idempotent — re-running with no changes produces no writes.
- 76 tests

## Export Directory Structure

```
kb-export/
  curated/     <- pattern, convention, architecture
  decisions/   <- decision
  guides/      <- troubleshooting, reference, onboarding
  archive/     <- any lifecycle=deprecated, archived or superseded
```

## What Phase 6 Does NOT Do

- No `git commit` / `git push` — just generates files on disk
- No sync daemon — that's Phase 8
- No git conflict resolution — future concern

## Key Design Decisions

- **`nowFn` injection**: `runExport` accepts optional `nowFn: () => string` parameter (defaults to `() => new Date().toISOString()`). Makes temporal assertions in tests deterministic without mocking `Date`.
- **String-templated YAML**: No yaml library dependency. All strings quoted. Deterministic key order. Escapes backslashes and double quotes. Trade-off: cannot handle deeply nested YAML, but frontmatter is flat by design.
- **Idempotency via content comparison**: Before writing, reads existing file and compares content. If identical, skips write. This means re-export is safe to run repeatedly.

## Test Count

76 new tests. Cumulative: 678.

## Lessons Learned

- String-templated YAML is sufficient for flat frontmatter and avoids a dependency, but the escape logic needs careful handling for edge cases (colons in titles, quotes in content).
- Idempotency check via `readFileSync` comparison is simple and effective for file-level change detection.
- `mkdtempSync` + `rmSync` in test fixtures provides clean isolation for filesystem tests.

## Deprecated content and existing exports

Deprecated memories export to `archive/`, retaining `lifecycle: "deprecated"`
in frontmatter and in the database. The `kb-archive` collection is excluded
from default curated search and remains available through the explicit
`archived` or `all` scope. Ranking demotion remains a fallback for old indexes;
it does not replace collection routing.

After upgrading an existing export, run the exporter with `--reconcile` to
relocate files whose timestamps predate the export watermark, then rebuild or
refresh the retrieval indexes before relying on the new search boundary.
Reactivating a memory and reconciling restores its active category (or bulk)
folder and removes its stale archive copy. A code rollback likewise needs
reconciliation and index refresh to restore the previous routing policy.
