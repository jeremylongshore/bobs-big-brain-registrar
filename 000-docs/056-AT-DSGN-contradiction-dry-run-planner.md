# Contradiction proposals from verified snapshots

Status: bounded dry-run implementation for `compile-then-govern-39z.1.1`.
Parent `compile-then-govern-39z.1` still owns governed application and search
surfacing. This module introduces no application command or automatic consumer.

## Boundary and decision

`planContradictions` is exported by the curator package. It accepts in-memory
snapshots and returns proposals with `status: needs-review`, or indexed refusal
codes. It accepts no repository, clock, filesystem path reader, network client or
mutation callback. It does not insert graph edges, change lifecycle, supersede
memories, update search or decide whether natural-language claims conflict.

Use explicit endpoint mappings instead of joining raw compiler source IDs or
relative paths directly to curated UUIDs. Compiler `source_ids` are advisory.
The caller must first verify the compiler's deterministic accepted attribution
(`compilation_sources`), compilation/page identity and page bytes against the
relevant workspace snapshot. Legacy `batch` attribution without real accepted
source IDs cannot supply this evidence.

The caller also verifies the spool manifest/emission and govern admission chain,
then supplies explicit workspace/source-to-emission-to-promotion mappings. A raw
source can contribute to several compiled pages. Choosing an endpoint is an
explicit reviewed input; multiple mappings for the same workspace/source refuse
rather than choosing one arbitrarily. Relative path collisions in another
workspace never act as fallback. Workspace IDs must themselves be unambiguous in
the caller's verified snapshot; this function cannot discover two physical
workspaces that falsely share one declared ID.

This reuses the actual `CuratedMemory` and `AuditEvent` schemas and shared
`deriveCandidateId`/`computeContentHash` utilities. It does not define another
receipt authority. `CompilationLineage` is an input projection, and `evidenceRef`
is a nonempty evidence locator, not proof that a chain was verified. Shape, ID
and hash checks inside the planner do **not** authenticate those inputs or
establish freshness. Verification and consistent snapshot acquisition remain
caller responsibilities. See [the compile/govern boundary](046-AT-ARCH-what-each-chain-proves-compile-vs-govern-boundary.md).

## Input and output

`ContradictionPlannerInput` carries:

- One tenant ID and caller-verified compilation lineage rows: workspace ID,
  compilation ID, relative page path, page SHA-256, accepted source IDs and
  evidence locator.
- Explicit advisories identifying workspace, compilation and page SHA-256, with
  exactly two selected raw source IDs. An N-source page without a selected pair
  is refused; it never expands into an all-pairs clique.
- Endpoint mappings with workspace/source, emitted relative path/body SHA-256/
  candidate ID, current curated memory and its canonical promoted audit event.
- Existing contradiction pairs from the same verified tenant snapshot, used
  solely to suppress duplicate proposals in either direction.

The planner checks that the advisory matches exactly one lineage row and both
selected sources were accepted. Each endpoint must have exactly one mapping in
that workspace. Candidate identity is re-derived from workspace/path/body hash;
`memory.candidateId` and the promoted event's action, memory, tenant and candidate
must agree. Current curated content must hash to `memory.contentHash`. Curated
content may differ from the original emitted body after governed edits; these
are separate hashes. Both memories must currently be active and in the requested
tenant. Self-links, repeated sources, exact text restatements (ignoring surrounding
whitespace), existing pairs and reversed duplicates within the batch are refused.
This is not a semantic restatement or contradiction classifier.

A proposal retains the compilation identity, page hash/evidence locator, source
pair, emission identities, current memory IDs/versions/content hashes and
promotion event IDs. Evidence is copied into the output. No timestamp or durable
edge ID is minted. Refusals refer to the zero-based advisory index; malformed
batch input returns one `malformed-input` refusal with a null index and no
proposals. Other eligible advisories can survive an individual refusal.

## Verification and limits

Hermetic fixtures use synthetic retention claims and canonical promotion events.
They exercise successful explicit pairing; malformed, missing and ambiguous
lineage/mappings; workspace collisions; identity and content mismatch;
tenant/lifecycle boundaries; self-links; exact restatements; reversed duplicates;
and multi-source ambiguity. Frozen-input and detached-output controls verify
repeatability without mutating the supplied snapshot. No live corpus is read.

This planner deliberately has no apply capability. A later reviewed unit must
revalidate eligibility against current state, authorize and receipt any durable
edge, and decide how search surfaces unresolved conflicts. Neither this unit nor
the compiler's advisory output establishes that a proposed pair is true. No
migration, index rebuild or operator action is required. Rollback removes the
unused planner/export; existing graph/search behavior is unchanged.

The separate internal [finite settlement core](067-AT-DSGN-reviewed-contradiction-settlement.md)
now implements reviewed transactional edge writes. It does not alter this
planner's pure interface or supply live activation, semantic review or search
surfacing for the parent task.
