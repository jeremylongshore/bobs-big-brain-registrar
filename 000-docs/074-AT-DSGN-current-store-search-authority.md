# Current store authority for cited search

**Status:** Implemented in source; rollout and live verification remain separate.
**Date:** 2026-11-22
**Bead:** `compile-then-govern-39z.11.3`

## Contract

API qmd search and local MCP search treat an index hit as a locator and ranking
signal. Its cached text, collection label and filename are not access authority.
The shared store reader resolves a canonical `qmd://kb-*/<uuid>.md` locator to a
schema-validated current memory in one SQLite read transaction. It checks the
requested tenant, reader audience, sensitivity and current search scope before
returning a result. Unscoped API identities retain the existing middleware
contract; local MCP always supplies its configured tenant and member/admin role.

Missing rows, non-row legacy filenames, malformed locators and non-finite scores
are withheld. A store or row-validation failure returns no hits, including any
partially collected hits. Local MCP never falls back to cached text when opening
or reading its store fails. Graph-reference failure can still mark references
unavailable without discarding an otherwise authorized primary result.

Displayed title, category and snippet come from the current row. The snippet is
the first 200 characters, matching the SQLite fallback's content window rather
than qmd's match-centered excerpt. Collection and citation are reconstructed from
the current lifecycle, source and category. Duplicate locators for one memory
produce one result. The existing freshness/category ranking operates on visible
rows; hidden or unresolved hits cannot affect its normalization or pagination.

## Scope and lifecycle

- `curated`: active, non-bulk memories only.
- `archived`: deprecated, superseded and archived memories, including bulk sources.
- `bulk`: active bulk-imported memories only.
- `all`: all governed lifecycle/source groups, subject to tenant, audience and
  sensitivity checks.
- `inbox`: no curated-memory results; proposals remain outside this search path.

An old `kb-curated` locator cannot restore an archived row to default search.
A current category or lifecycle can produce a citation whose exported file has
not yet moved. The citation identifies a current governed memory and collection;
it does not attest that the export or index has refreshed. Read authorization and
content describe the SQLite snapshot, not a guarantee against changes after the
read finishes.

## Compatibility and migration

This intentionally removes the earlier behavior of returning unresolved index
text as public, tenant-wide content. There is no permissive legacy switch.
Legacy documents must correspond to governed rows and use the exporter UUID
filename contract before this API/MCP path will return them. Do not manufacture
row mappings, bypass intake policy or widen audience to recover an old result.

Deployments must pair the search consumer with the correct governed store.
Operator-authorized export reconciliation and index refresh may be needed for
missing or moved locators. This source change performs neither operation and
does not migrate an installed consumer automatically.

The index still controls discovery and initial ranking. This does not find new
memories absent from the index, prove absence when an empty response is returned,
remove stale bytes from index/export files, or govern someone with direct access
to those files. Remote MCP trusts the configured authenticated brain API; it
does not independently inspect that server's store. No cross-process revocation
instant or complete estate-wide privacy claim is made.

## Evidence required

Synthetic tests exercise stale redacted text, malformed/missing authority,
whole-response refusal on row errors, narrowing without reindex, tenant/audience/
sensitivity checks, lifecycle and bulk scopes, canonical output, duplicate and
malformed locators, and bounded snippets. API and MCP integration tests must show
these controls in their returned responses. Existing ranking, pagination,
authentication, graph-reference and exporter contracts remain regression gates.

This supersedes the unresolved/store-error compatibility behavior described in
the 2026-11-22 resolved-standing addendum to [037](037-AT-DSGN-qmd-adapter-source-index-separation.md).
Broader provenance-derived classification and production adoption remain outside
this source milestone.
