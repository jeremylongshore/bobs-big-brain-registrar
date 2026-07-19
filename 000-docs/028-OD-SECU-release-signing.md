# Release Supply-Chain Signing

## Scope

This document describes the supply-chain signing and provenance pipeline
applied to artifacts produced by the `Release` workflow
(`.github/workflows/release.yml`). It covers:

- Cosign keyless signing of the edge-daemon container image
- SLSA Level 3 build provenance generation
- Consumer-side verification procedures

It does **not** cover npm package publishing (not yet in scope), git tag
GPG signing (covered informally by the release owner), or signing of the
systemd/launchd deploy artifacts shipped alongside the container.

## What Gets Signed

| Artifact                                                        | Signing Mechanism        | Transparency Log |
| --------------------------------------------------------------- | ------------------------ | ---------------- |
| `ghcr.io/jeremylongshore/qmd-team-intent-kb-edge-daemon:${TAG}` | cosign keyless (OIDC)    | Rekor            |
| Same image — SLSA Level 3 provenance attestation                | slsa-github-generator v2 | Rekor            |

The image is tagged with both `${TAG}` (e.g. `v0.4.0`) and `latest` on
every tag push. Both tags reference the same digest, and the signature
is applied against the digest (not the floating tag) so floating-tag
retargeting cannot invalidate the signature chain.

## Trigger Semantics

The signing job `build-and-push-image` and its downstream `provenance`
job run **only** on tag pushes matching `refs/tags/v*`. They are gated
with:

```yaml
if: startsWith(github.ref, 'refs/tags/v')
```

This means:

- `workflow_dispatch` (the manual dry-run path) never publishes to GHCR
  and never mints signatures. Dry-runs remain non-destructive.
- Only tags that start with `v` (matching Semantic Versioning) produce
  signed images.

## Permissions Model

Permissions are scoped per-job, not at the workflow level. The default
workflow-level grant remains `contents: read`.

The `build-and-push-image` job requests:

- `contents: read` — to check out the repo
- `packages: write` — to push to GHCR under the actor namespace
- `id-token: write` — OIDC token for cosign keyless and SLSA
- `attestations: write` — so build-push-action can record an attestation

The `provenance` reusable workflow requests `actions: read`,
`id-token: write`, `packages: write` per the slsa-github-generator spec.

## Signing Identity

Cosign keyless signing binds the signature to the GitHub Actions OIDC
identity. The certificate SANs identify:

- **Workflow identity**: `https://github.com/jeremylongshore/bobs-big-brain-registrar/.github/workflows/release.yml@refs/tags/vX.Y.Z`
  (repo renamed from `qmd-team-intent-kb` on 2026-07-19 — the identity regexp must use the new
  slug for post-rename releases; pre-rename releases were signed under the old slug. The GHCR
  image name intentionally keeps the historical slug: it is a published artifact identifier.)
- **OIDC issuer**: `https://token.actions.githubusercontent.com`

There is no long-lived signing key to manage, rotate, or leak. All
signatures are recorded in the public Rekor transparency log.

## Verification

### Verify the image signature

```sh
cosign verify \
  --certificate-identity-regexp 'https://github\.com/jeremylongshore/bobs-big-brain-registrar/\.github/workflows/release\.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/jeremylongshore/qmd-team-intent-kb-edge-daemon:<tag>
```

Substitute `<tag>` with the release tag being verified (e.g. `v0.4.0`).
A successful verification returns JSON describing the matched entries
and exits 0. A failure exits non-zero and must block deployment.

### Verify SLSA provenance

```sh
# Install slsa-verifier:
#   go install github.com/slsa-framework/slsa-verifier/v2/cli/slsa-verifier@latest
slsa-verifier verify-image \
  ghcr.io/jeremylongshore/qmd-team-intent-kb-edge-daemon:<tag> \
  --source-uri github.com/jeremylongshore/bobs-big-brain-registrar \
  --source-tag <tag>
```

This re-derives the builder identity from the attestation, confirms the
source commit matches the tag, and verifies the Rekor entry is intact.

## Failure Modes

- **GHCR push fails (permissions / token)** — the job fails and no
  signature is ever minted. Rolling back is a no-op because no image
  was published.
- **cosign sign fails** — image is published but unsigned. The release
  is considered incomplete. Re-run the workflow on the same tag to
  retry; the image is overwritten by digest-equivalent rebuild, and a
  fresh signature is appended.
- **SLSA provenance job fails** — image and cosign signature remain
  valid; provenance attestation is missing. Re-run the tag; the
  generator is idempotent against the same image digest.

## Related Documents

- `008-OD-RELS-release-versioning-policy.md` — semantic versioning policy
- `020-OD-RELS-v1-release-checklist.md` — per-release checklist (includes signature verification step)
- `006-TQ-SECU-security-governance.md` — project-wide security posture
