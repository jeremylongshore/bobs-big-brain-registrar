# Decision Record — Write-time provenance origin tokens (GSB Wave-2, tracks H1–H5)

**Date:** 2026-07-19
**Status:** Ratified (shipped with the H1–H5 change set)
**Scope:** Registrar (`packages/schema`, `packages/common`, `packages/store`, `apps/curator`, `apps/api`, `apps/edge-daemon`) + the plugin (`bobs-big-brain-plugin`) capture paths + the compiler's vendored contract snapshot.

## Decision

Every capture may carry a verifiable **origin**: an HMAC-SHA256 token minted at
capture time over the candidate identity tuple `(id, tenantId, capturedAt)`,
keyed by a **per-installation secret**. The govern/promotion path (curator batch
sweep AND the API single-candidate promote) verifies the token **before**
promotion. An invalid claim is a **receipted, policy-pipeline-shaped reject**
(`origin_token_invalid`), never a crash.

### Verdict table (v1 — the load-bearing choices)

| Candidate state                                                        | Outcome                                                                        | Why                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `origin` at all                                                     | **Accepted**, promotion receipt records channel `unattested`                   | Backward compatibility. Every pre-H1 spool line, ICO emission, and legacy capture carries no origin; a hard-reject flag-day would orphan **all** of them. The gap stays _visible_ on every receipt instead of silently passing as attested. |
| `origin` present, HMAC verifies                                        | Accepted, receipt records channel + truncated token hash (H2)                  | The attestation held.                                                                                                                                                                                                                       |
| `origin` present, HMAC mismatch                                        | **Reject** `origin_token_invalid` (receipted; 422 with stable code on the API) | Forged / replayed across identities / minted under a different secret.                                                                                                                                                                      |
| `origin` present, govern path has no secret                            | **Reject** `origin_token_unverifiable` (fail-closed)                           | A claimed attestation we cannot check must not promote as if it verified.                                                                                                                                                                   |
| `origin.channel` not on the deployment allowlist (team API intake, H3) | **422** with stable code `unrecognized_channel`                                | Only an _explicit claim_ of an unknown channel is refused; origin-less captures skip the check.                                                                                                                                             |

**Honest framing of the accept-with-`unattested` choice:** this is a
compatibility posture, not a security claim. Until a deployment's clients all
mint origins, an attacker who can write to the spool/API can simply omit
`origin` and be governed as an unattested candidate — exactly like every write
before H1. What H1 adds is (a) a _positive_ attestation channel whose forgery is
detectable and receipted, and (b) receipt-level visibility (`unattested`) of
which promotions lack it, so a future flag-day (reject-unattested) can be
data-driven per deployment.

## Identity-tuple binding and id stability

The spool contract is **UUID-v5 content-stable**: candidate `id` =
`uuidV5(SPOOL_UUID_NAMESPACE, "{workspaceId}\0{relPath}\0{bodySha256}")`
(`packages/common/src/uuid-v5.ts`; vendored byte-identical from ICO). The id
derivation reads **only** those three content fields — never the whole
candidate object — so adding the optional `origin` field **cannot** change any
id. The origin token conversely binds `(id, tenantId, capturedAt)` and is
therefore _downstream_ of id derivation; the two derivations share no coupling.
The compiler's contract snapshot + test were resynced in lock-step.

## Secret storage

- **Location:** `~/.teamkb/origin-secret` (one line, 64 lowercase hex = 32
  random bytes), mode **0600**, auto-generated on first use by the brain's own
  processes (local govern, API boot, curator CLI, edge daemon).
- **Override:** env `TEAMKB_ORIGIN_SECRET` wins over the file and is never
  written to disk. This mirrors the existing `~/.teamkb/tokens.json` posture
  (per-installation credential material lives under the brain base dir, never
  in the repo; the API tokens are scrypt-hashed at rest — the origin secret is
  a symmetric MAC key, so it is stored raw but 0600).
- **Team mode clients** mint **only** when `TEAMKB_ORIGIN_SECRET` is explicitly
  set (deliberate admin distribution). A client must never auto-generate: a
  freshly-invented client secret would mint tokens the server's secret rejects
  at promotion, silently poisoning the member's own proposals. No secret ⇒ the
  client sends no `origin` ⇒ unattested path (works exactly as pre-H1).
- Receipts persist only `sha256(tokenHmac)` truncated to 16 hex chars — never
  the token — so no audit surface leaks replay-mint material, and there is no
  verify-arbitrary-token oracle anywhere.

## H4 — local-mode channel attestation is OUT OF SCOPE (v1)

In **local mode** the plugin, the brain, and the secret all live on the user's
own box under one trust domain. The origin token still binds each capture to the
installation (a spool line minted elsewhere fails verification), but the
`channel` value (`local-mcp`) is **self-asserted**: any local process that can
read `~/.teamkb/origin-secret` can claim any channel. Enforcing channel
authenticity locally would require an OS-level identity boundary that does not
exist on a single-user box — so v1 explicitly does not pretend to. Channel
_authorization_ is enforced only where a real trust boundary exists: the team
API's allowlist (H3). Mirrored in the plugin repo's AGENTS.md.

## H5 — the residual, named honestly

An **authenticated insider** — any holder of a valid bearer token and/or the
origin secret — can still poison L2/L3 content with validly-attested captures.
Origin tokens prove **where a capture came from, not that it is true**. The
mitigations for content poisoning remain the deterministic govern policy
(secret/disclosure/dedup/contradiction rules), human review of the
inbox/quarantine queues, and supersession — not the token. This wording also
lands in the plugin repo's AGENTS.md and brain skill docs.

## Alternatives considered

- **Policy-rule implementation** (a new `PolicyRuleType` `origin_attestation`):
  rejected — rule sets are per-tenant _configuration_, so the gate would be
  dormant on every pre-H1 policy (and silently absent when no policy is
  enabled). Provenance verification is an integrity property of the write path;
  it now runs **structurally** (like the dedup check) on every promotion path,
  while still emitting a policy-pipeline-shaped result so receipts/422s look
  exactly like a policy reject (`ruleType: origin_attestation`).
- **HMAC over content:** redundant on the spool path (id already binds content)
  and would break the outbox replay path in team mode (content is frozen with
  the token; identity binding survives replay by design).
- **Asymmetric signatures (per-user keys):** the right long-term shape for
  cross-actor non-repudiation, but heavier (key distribution/rotation UX) and
  explicitly out of scope for v1 — consistent with the umbrella's trust-model
  framing that local mode never claims non-repudiation.

## Verification

- `packages/common/src/__tests__/origin-token.test.ts` — mint/verify round-trip,
  forgery + replay negatives, malformed-token tolerance, secret file 0600 +
  idempotence + env override.
- `apps/curator/src/__tests__/origin-gate.test.ts` — verdict table, forged-token
  receipted reject, unattested legacy candidate still governs, receipt carries
  channel + truncated hash, store round-trip.
- `apps/api/src/__tests__/origin-provenance.test.ts` — H3 `unrecognized_channel`
  422 (+ allowlist override), forged-token promote 422 `origin_token_invalid`,
  fail-closed no-secret promote, H2 receipt assertions.
- Store migration 11 (`add_candidates_origin`) — additive nullable
  `origin_json`; every pre-H1 row reads back `origin: undefined`.
