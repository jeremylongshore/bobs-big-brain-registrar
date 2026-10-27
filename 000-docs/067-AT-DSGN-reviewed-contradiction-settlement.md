# Reviewed finite contradiction settlement

Status: internal source implementation for `compile-then-govern-39z.1.2`.
The parent retains real conflict review, search surfacing and live acceptance.
This module is not exported from the package root or wired to a CLI/API.

## Review and evidence boundary

The pure [proposal planner](056-AT-DSGN-contradiction-dry-run-planner.md) remains
unchanged. The settlement accepts one strict versioned review manifest, an
independently supplied approved digest and installation-owned captured compiler
evidence. The manifest selects between one and 100 explicit pairs; no advisory
expands into an all-pairs graph. UUIDs must use canonical lowercase spelling.

Each pair binds a workspace/compilation/page lineage and exactly two explicit
source-to-emission-to-memory mappings. The current canonical memory, complete
stored memory row, canonical promotion receipt and complete stored promotion row
have separate digests. Captured compilation identity/source attribution must
match exactly, with exactly one captured result; page and emitted body bytes
must hash to the reviewed values. The existing planner rechecks candidate
identity, promotion binding, tenant, active lifecycle, distinct endpoints and
exact restatements. Declared admin/owner visibility is checked at both endpoints.

The caller must authenticate and authorize the human, establish actual semantic
conflict and accepted compiler attribution, verify original spool/admission
evidence, obtain independent approval, hold the physical brain write lock and
own subsequent anchoring/export/index actions. An evidence locator, actor/role
declaration or hash match supplies none of that authority. Captured evidence
callbacks are trusted local dependencies, not request-selected URL fetchers.
No new compiler receipt authority or model invocation is introduced.

## Transaction, receipts and replay

The manifest also binds a logical snapshot of the entire main SQLite store:
schema and every table, including unknown columns and FTS shadow tables.
Integer, REAL and blob types and accessible implicit rowids are preserved.
Tables shadowing all hidden-rowid aliases refuse; WITHOUT ROWID tables are supported.
Attached databases and temporary schema
objects refuse rather than escape preservation checks. This full-store scan
has cost proportional to the store, irrespective of the finite selection size;
performance and live-store adoption have not been established here.

An existing transaction refuses. One outer immediate transaction requires a
strictly verified global audit chain, revalidates all selections and snapshot
state before writing, then inserts only the selected `contradicts` edges.
Each unordered pair has sorted endpoint IDs, the existing deterministic link
ID, weight one, `curator` source and the declared reviewer's ID. Any existing
forward or reverse contradiction edge refuses unless it is this exact replay.

Each edge gets a canonical `governed` audit event, followed by a run event using
the same existing action. Versioned details bind the manifest digest, reviewed
timestamp, declared role, hashed reason, link row and evidence digest. The run
binds ordered edge receipts. Review prose, source text and private evidence
locators are not copied into these receipts. No schema migration is needed.

Final validation rereads exact domain and raw link/receipt rows, including audit
hashes, predecessor hashes, write sequences and timestamps. Captured evidence
is checked again. Removing only the expected appended rows must reproduce the
entire reviewed store snapshot; other row or schema changes cause rollback.
New unbound columns in the two target tables fail closed.

Exact replay reconstructs and verifies the same links and receipts and adds
nothing. It checks the original store snapshot after excluding only those
verified rows. Consequently even unrelated later store edits invalidate this
strict replay; this is not a promise of replay across arbitrary subsequent
governance activity. Missing/changed receipts are never repaired automatically.
Any refusal or thrown insert/readback rolls back the transaction. Strict chain
verification grants no historical fork exception and performs no rehashing.

## Verification and remaining work

Disposable SQLite fixtures cover successful two-pair settlement and no-write
replay; independent-digest mismatch; unknown/malformed/duplicate inputs;
tenant/audience/lifecycle boundaries; stale raw and canonical witnesses;
missing/ambiguous/changed captured evidence; reversed existing edges; ignored,
aborted and rewritten inserts; final-receipt mutations; callback drift;
non-target tables, large integers and blobs; broken replay; and unverified or
forked audit history. These are synthetic evidence and approval declarations.

The implementation does not change lifecycle, rank a winner, classify semantic
truth, discover the live corpus, activate team access or modify search results.
No real contradiction sample, live edge count or production acceptance is
claimed. Removing the unused source module requires no data rollback. Any
future live writer needs a separate authority and recovery plan; there is no
automatic destructive edge-removal operation in this unit.
