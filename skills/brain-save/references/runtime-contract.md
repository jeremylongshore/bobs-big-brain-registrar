# Registrar Brain Save runtime contract

## Contents

- [Required runtime](#required-runtime)
- [Tool contracts](#tool-contracts)
- [Mixed-mode boundary](#mixed-mode-boundary)
- [Security and known limitation](#security-and-known-limitation)

## Required runtime

The repository's `intent-brain` marketplace configuration selects a runtime exposing only `teamkb_search`. Brain Save
requires the source-built `apps/mcp-server` with `TEAMKB_ROLE=admin`. `TEAMKB_TENANT_ID` is required;
`TEAMKB_BASE_PATH` selects the local spool, SQLite database, feedback, and export directories.

## Tool contracts

- `teamkb_search`: required `query`; optional `scope` and `limit`.
- `teamkb_propose`: required `title` and `content`; optional `category` and `filePaths`. Success returns
  a candidate UUID after a local spool write.
- `teamkb_status`: no input. Returns local database counts, recent feedback, and `dbPath`.
- `teamkb_transition`: required UUID `memoryId`, lifecycle `to`, non-empty `reason`, and non-empty
  `actor`; optional UUID `supersededBy`, required when `to` is `superseded`. Success returns old/new
  states and an audit-event UUID.

`teamkb_status` reads curated database state and feedback. It does not inspect the spool, so it cannot
confirm a proposal is governed or even visible to the curator yet.

## Mixed-mode boundary

With `TEAMKB_API_URL` set, `teamkb_search` queries the remote API, but propose, status, and transition
still use local paths. This can create a split-brain operator workflow. Leave the API URL unset unless
that split is intentional and clearly disclosed.

`TEAMKB_ROLE=admin` controls which local tools register. It is a client-side capability gate, not an
authentication credential. Protect the local base directory through operating-system permissions.

## Security and known limitation

`teamkb_propose` writes a proposal, not a promoted memory. A separate curator applies secret checks,
deduplication and structural gates. The source-built tool fixes `source: mcp` and
`author: { type: ai, id: mcp-server }`; callers cannot override this envelope or
its medium trust label. Direct governance returns
`pipelineResult.flaggedBy: ['registrar_mcp_review_required']`; batch governance
reports a flagged count. Both leave these proposals in the inbox, even with no
enabled policy. The flag is a returned result, not a persisted candidate marker.
Finite selected governance uses its existing receipted quarantine path, after
which the row awaits explicit review.
Neither path admits them. Lowering a trust threshold does not bypass this gate.

An authorized reviewer lists pending rows with
`GET /api/candidates?tenantId=<tenant>&status=inbox` (or `status=quarantined` after
finite selected governance) and explicitly reviews a
selected row through admin-only `POST /api/candidates/<id>/promote?tenantId=<tenant>`.
That API reruns disclosure, provenance, import, deduplication, policy and hold
checks and records the token-authenticated reviewer ID on a successful promotion
receipt. The receipt's actor type is request-declared; the candidate route does
not independently authenticate human identity.
Those unchanged gates are implemented in
[`PromotionService.promoteCandidate`](../../../apps/api/src/services/promotion-service.ts);
the [candidate route](../../../apps/api/src/routes/candidates.ts) passes the
server-authenticated actor ID. The repository
[marketplace configuration](../../../.mcp.json) selects the
[search-only runtime](../../../plugin-runtime/teamkb-remote.cjs).
It does not override policy failures or release a K6 hold. If explicit API review
encounters a K6 hold, a person with standing must use the existing hold-resolution
route. The hold route refuses known agent tokens and requests declaring AI or
system actor type; otherwise actor type defaults to human. This is an admin-token
authority boundary, not independent proof of a physical person. The hold resolver
passes a human release context that Curator treats as review while rechecking
the remaining gates. Programmatic callers can construct that context; Curator
does not authenticate it. See the [hold route](../../../apps/api/src/routes/holds.ts)
and [resolver](../../../apps/curator/src/hold/resolve-hold.ts). This is an API review
operation, not an additional MCP tool; the repository search-only proxy cannot
perform it. Marketplace publication state is not asserted here. The operator must
verify that the Curator deployment processing these proposals contains the gate;
evidence of the MCP producer build alone is insufficient. A compatible API is
also required; these source instructions do not attest an installed version.

Other capture surfaces retain their existing behavior. The fixed AI envelope is
capture-surface classification metadata, not authenticated origin or scout identity,
and provides no protection against
an owner rewriting the local spool. Existing filesystem and API authority
boundaries still apply.

For `active` to `superseded`, `supersededBy` must identify a distinct active curated memory in the
same tenant. The lifecycle, `SupersessionLink` (replacement UUID, reason and time) and superseded audit
event commit together, or all roll back. The replacement stays active. This does not create graph
edges or rebuild a search index. The batch-transition CLI still refuses supersession because it has
no per-memory replacement mapping. These contracts address `qmd-team-intent-kb-ehi`; deployments need
the corresponding Registrar source build, not an older bundled runtime.
