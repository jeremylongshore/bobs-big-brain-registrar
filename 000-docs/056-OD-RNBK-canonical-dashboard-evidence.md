# Canonical Dashboard Evidence

Date: 2026-10-12. Tracking: `bd_000-projects-0s2a`.

## Artifact contract

The `qmd` dashboard channel runs the three existing CI evaluation commands in
`ci/emit-evidence/emit-evidence.ts`. Each outcome becomes one kernel-validated
in-toto statement inside an `EvidenceBundlePayload` array. The standalone CI
package pins `@intentsolutions/core@0.10.0`; workspace runtime dependencies are
unchanged.

`EvidenceBundle.storage_key` is the SHA-256 of the complete canonical statement
array: recursively sorted object keys, array order preserved, UTF-8 JSON without
whitespace. Predicate types, row count and subject set derive from that payload.
The manifest carries `evidencePayload` and the compatible `gateResults` projection.
Assembly rejects any disagreement with signed metadata or predicates. Missing or
invalid canonical payloads cannot fall back to the older body-digest format.

## Local verification

```bash
pnpm --dir ci/emit-evidence install --frozen-lockfile --ignore-workspace
pnpm test:evidence
node --experimental-strip-types ci/emit-evidence/emit-evidence.ts --self-check
pnpm validate
```

The contract suite checks pass/fail/unavailable outcomes, a shared unsigned
marketplace/dashboard interoperability vector, and payload, subject, metadata,
projection and missing-signature mutations. Fixtures do not constitute live
measurements or cryptographic verification. The PR workflow runs these contracts
in the `Canonical evidence payload contracts` job; the emitter repeats them before
running real gates and signing artifacts.

The repository's `pnpm harness-pin` checks the eight policy artifacts listed in
`scripts/harness-pin.sh`; it is not a digest inventory of every source file.
That list and its manifest are unchanged. CI-emitter behavior is checked by the
contract job, while its dependency payloads are pinned by the standalone frozen
lockfile. For a staged diff scan, pair the repository hash verifier with the
generic scanner's diff-only mode; its default hash verifier uses a different file
set and cannot validate this repository's custom manifest.

## Publication and transition

The existing main-only `emit-evidence.yml` workflow signs canonical bundle metadata
with keyless Cosign, verifies each signature, then publishes the manifest on the
rolling `evidence-latest` prerelease. The repository identity, workflow reference
and main-only guard remain unchanged. The assembler checks binding consistency;
CI and dashboard ingest verify signatures.

After merge, verify the live manifest's source SHA, canonical payload hashes and
metadata, then the dashboard's cryptographic ingest and rendered rows. Record
those receipts in the migration bead. Source tests alone do not establish a live
transition. Dashboard compatibility remains necessary for older cached evidence
and other channels until their tracked transitions are verified.
