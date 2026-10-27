# Visible contradiction references in search

Status: source implementation for `compile-then-govern-39z.1.3`.
This adds read-only graph metadata to Registrar search. It does not settle the
parent's real conflict review, standalone Plugin distribution or live acceptance.

## Response contract

`SearchHit.contradictions` is optional. New API wiring supplies it after normal
retrieval, ranking and pagination:

```json
{
  "status": "available",
  "references": [{ "memoryId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "title": "Counterpart" }]
}
```

An available empty array means no eligible references were visible in that
store snapshot. Its length counts visible references only; there is no global
or withheld count. It says nothing about natural-language conflict truth or
whether uncaptured knowledge exists. References are stored `contradicts`
relationships, not new governance receipts, accepted compiler proposals or
automatically chosen winners.

`{"status":"unavailable"}` means current graph evidence could not be established.
It carries no references or diagnostic source details. An older server or
consumer may omit the field; omission also does not establish zero conflicts.
Malformed metadata, including duplicate references, is not forwarded as verified
evidence. No qmd URI is invented for a graph counterpart whose export was not read.

## Read boundary

`readContradictionReferences` reads current canonical memories and scoped graph
neighbors in one deferred SQLite transaction. It writes nothing. Both edge
directions are considered; self-links, reverse duplicates and other relation
types do not inflate the references. Results are sorted by memory ID.

The primary and every returned counterpart must be active, within the trusted
tenant scope/allowlist and current audience standing, and pass the existing
search-sensitivity policy. Even an unscoped owner receives no cross-tenant edge.
Missing or ineligible counterparts are omitted without exposing their IDs,
titles or counts. A missing/ineligible primary, unavailable graph or canonical
read failure produces unavailable evidence rather than a measured zero.

The caller establishes actual authentication and trusted read scope. API role
comes from the token identity, with existing server-side tenant binding; body
fields cannot grant owner standing. Local MCP uses its existing installation
role and configured tenant. This introduces no new owner override or sensitivity
policy. It does not verify the audit chain or establish semantic truth.

## Consumers and limits

API cited and SQLite paths annotate returned hits without changing scores,
membership, pagination, snippets or existing citations. Missing reader capability
on a legacy `SearchService` construction leaves the optional field absent.
The normal application factory wires the reader; read errors preserve retrieval
with explicit unavailable metadata.

Registrar's local MCP reader opens its existing store read-only. Remote tool and
self-contained remote-client mappings validate and retain server metadata.
Older API responses remain supported. The existing local raw-hit sensitivity
fallback and unknown-citation behavior remain separate from this graph evidence
boundary; this change is not a claim to replace every legacy retrieval guard.
Standalone Bob's Big Brain Plugin consumers are a separate owning repository.
The Registrar-owned remote-client bundle is refreshed. No separately frozen
standalone Plugin consumer payload, live index, service or installation is changed.

The remote artifact imports the canonical metadata validator through a narrow
schema export. `pnpm build:plugin-runtime` first builds that schema package,
then bundles the remote client. This prevents stale generated schema output from
silently omitting a validator update. The checked-in generated artifact is tested
over actual MCP stdio against a disposable loopback API fixture. The root build
script's existing integrity pin changes with that reviewed prerequisite; gate
floors and dependency versions do not change.

The reader enumerates the selected memories' neighbors; this work does not claim
a live-scale graph latency qualification. Current references can change as the
store changes. Search does not modify lifecycle or generate audit events, perform
semantic classification or automatically resolve a contradiction.

## Verification

Disposable-store controls cover both directions, duplicates, unrelated/self
edges, tenant and allowlist boundaries, member/admin/owner visibility, sensitivity,
inactive/missing/corrupt rows, unavailable graphs and no-write behavior. API
controls exercise cited and SQLite responses with actual token binding, including
forged role fields, and compare ranking/pagination/citations under a fixed clock.
MCP tests cover local metadata, older responses, malformed evidence and actual
generated-client stdio transport. A duplicate-metadata case failed against the
stale generated artifact before the schema-build prerequisite was added.

These are synthetic relationships, not a human-reviewed sample from the live
brain. The parent remains open for that review and final consumer acceptance.
