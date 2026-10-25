# Promoted receipt citation integrity

Given a stable caller-supplied store and export view, this check applies
deterministic identity and export rules for a declared tenant. It enumerates every
`promoted` audit receipt, resolves its memory and reports unresolved or excluded
entries. For resolved export-eligible memories, it derives the canonical `qmd://`
citation and checks the corresponding export file. It does not create or certify
an atomic snapshot. It does not run a model or qmd process, write store records
or export content, repair state, or refresh an index.

The composition belongs in the API application, which already consumes the
store, git exporter and qmd adapter. The check adds no endpoint, read permission,
schema migration or change to promotion. This fixture advances
`compile-then-govern-6ps.9`; closure requires its recorded acceptance and review.

## Mapping and denominator

Promotion receipts record `memoryId` and `tenantId`; they do not contain a
literal citation field. The check establishes a derived mapping rather than
claiming to validate a citation already stored in the receipt:

1. Read every promotion receipt for the requested tenant.
2. Resolve its memory and require the same tenant identity.
3. Apply the exporter's existing sensitivity and audience restrictions.
4. Derive the export path with `getRelativePath`, select its collection with
   `getExportableCollections`, and resolve the citation with `resolveCitationPath`.
5. Require the exact expected regular file within the export tree and compare
   its header with the canonical rendered memory frontmatter.

The exporter intentionally omits confidential or restricted memories and
memories intended for a narrower audience than the tenant. These promotions
remain visible in the reported excluded denominator. They are not missing-export
failures and must never be exported just to make the check pass. An empty or
entirely excluded snapshot cannot establish passing acceptance. In that case,
`passed: false` with zero eligible promotions means insufficient evidence; the
separate failed count and entry codes identify actual violations.

Active category routing, bulk imports and retired memories use the existing
export policy. Retired memories resolve through `kb-archive`; a previous promotion
does not imply that its memory should still appear in default search.

## Hermetic proof

The ordinary root Vitest suite collects
[`citation-integrity.test.ts`](../apps/api/src/__tests__/citation-integrity.test.ts).
Its fixture promotes candidates through the real API with `app.inject` and uses
the real exporter through an export-only refresher. It needs neither a listening
server nor an available qmd binary. Positive fixtures cover the canonical export
collections. Missing files, foreign tenant identities, substituted frontmatter
and escaped or nonregular files provide negative controls. The fixture must
check every promotion receipt in its snapshot and a nonzero eligible denominator.

A related existing re-hash-forward control lives in
[`eval-surface.test.ts`](../packages/eval-surface/src/__tests__/eval-surface.test.ts):
the re-hash-forward test edits a middle audit row and recomputes its successor.
Internal chain verification stays clean, while the earlier anchor exposes the
rewrite. Reuse this positive control rather than copying its hash algorithm.

Run the focused proof from the repository root using the shared private fixture
configuration in [`vitest.config.ts`](../vitest.config.ts),
[`fixture-global-setup.ts`](../tests/support/fixture-global-setup.ts) and
[`fixture-environment.ts`](../tests/support/fixture-environment.ts):

```bash
pnpm exec vitest run apps/api/src/__tests__/citation-integrity.test.ts packages/eval-surface/src/__tests__/eval-surface.test.ts
```

The root [CI workflow](../.github/workflows/ci.yml) runs the collected suite.
The owning repository's ordinary build, types, lint, coverage and architecture
gates remain applicable. Test sources and a command are not execution evidence;
the PR distinguishes executed commits from evidence carried forward over
unchanged source. Execution reports identify the commit or source hashes that
actually ran.

## What the check establishes

This is citation identity and export presence within a supplied current snapshot.
Canonical frontmatter comparison also detects a file with the wrong memory or
tenant metadata. Body replacement that preserves the canonical header is outside this check.
It does not establish body entailment, factual truth, retrieval
ranking, complete historical coverage, or full ALCE evaluation. It neither runs
the live corpus nor certifies a deployed index.

The caller supplies consistent store and export inputs. Its export-root alias is
resolved once; symlinks below that canonical root are refused. The no-follow open
flag is POSIX-specific; regular-file and descriptor identity checks also apply. Report entries retain
repository result order; the checker does not normalize it. Path checks do not
freeze files against a concurrent same-user writer, and they are not a new
authorization boundary. The existing synthetic control demonstrates that
comparison with an earlier retained anchor detects a re-hash-forward rewrite.
This check does not establish independent anchor storage, remote durability or
production audit authenticity. Local integrity and ordering checks do not prevent
a local writer from editing and re-hashing history.

The fixture compares the serialized database image and selected exported files'
bytes, mtime and inode. It does not establish unchanged physical database, WAL or
shared-memory bytes, or unchanged access metadata from reads.

Rollback is a normal source revert. The checker has no store-record writes,
export-content writes, automatic remediation or export-policy change to undo.
