# @qmd-team-intent-kb/schema

Zod domain model and lifecycle state machine for the qmd-team-intent-kb memory platform. Defines core types (`MemoryCandidate`, `CuratedMemory`, `GovernancePolicy`, `AuditEvent`, `SearchQuery`, `SearchResult`), domain enums (`MemoryLifecycleState`, `Sensitivity`, `MemoryCategory`, `TrustLevel`, `CandidateStatus`, `SearchScope`), and the lifecycle transition rules used by every other package.

Part of the qmd-team-intent-kb monorepo; see the repository root for license and contribution details.

## Source-classification protocol

The `@qmd-team-intent-kb/schema/source-classification` subpath exposes the existing
strict v1 schemas, canonical serialization, profile digest and Ed25519 signing
primitive for Node.js producers. It depends only on this package, Zod and Node
built-ins; importing the main schema entry does not load the signing subpath.

This is a wire-format primitive, not permission to classify a source. A trusted
adapter must establish source identity, choose current enrolled profiles and keys,
and bind the final candidate identity, content, title and capture timestamp. The
receiver still verifies signatures, enrollment, freshness and replay state. Mixed
inputs must not be relabeled as a single repository or assigned the least
restrictive input profile. Spool v1 is unchanged.

Source availability of this export does not establish an npm release, consumer
adoption, live key provisioning or enrollment. Curator's old internal paths
re-export this implementation for compatibility.
