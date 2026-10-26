# Registrar source contract reconciliation

Source baseline: `3dede3c`; checked 2026-10-26. Bead: `compile-then-govern-eqw.6.3`.
This is the Registrar slice of intent-os audit 244. The authority registry
`intent-os/sot-map.yaml` is absent: bootstrap mode, all fact classes unowned.
This report records paired evidence and source-backed documentation corrections;
it does not adopt registry rows or ratify a model/license change.

## Deterministic findings

These are grouped findings, not a recount of audit 244’s 18 warnings and 6 info rows.

| ID  | Severity / fact class               | Baseline observations and correction                                                                                                                                                                                                                                            | Auto-fixable |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| W1  | Warning / version and runtime       | README identifies v0.7.0 and Node20; root manifest identifies0.8.0 and Node>=22. README now distinguishes the root release label, source changes and independently versioned workspaces; historical blueprint001 gets a dated note.                                             | Yes          |
| W2  | Warning / workspace inventory       | README and CLAUDE trees omit implemented packages/app. Actual manifests enumerate six apps and ten libraries, including store, eval-surface, qmd-runtime, test-fixtures and mcp-server.                                                                                         | Yes          |
| W3  | Warning / API inventory             | CLAUDE lists `/health`, three middleware stages and incomplete routes. `apps/api/src/app.ts` registers six middleware stages; route modules expose `/api/health`, import batches, auth revocation, graph reads and receipt-tip. Guidance now follows these modules.             | Yes          |
| W4  | Warning / dev entrypoint            | CLAUDE names `src/index.ts`; apps/api package dev command runs `src/main.ts`. Command comment corrected.                                                                                                                                                                        | Yes          |
| W5  | Warning / CI commands               | Docs describe `pnpm validate` as the PR workflow and omit named eval/integration gates. `ci.yml` runs individual commands in validate plus moat-evals/retrieval-eval/integration. Local aggregate and actual hosted workflow are distinguished.                                 | Yes          |
| W6  | Warning / workflow inventory        | Docs name absent Gemini review and weekly security. Nine workflow files include advisory MiniMax, docs, seam-independence and evidence publication; security triggers main pushes/PR/dispatch, nightly runs04:00UTC/dispatch.                                                   | Yes          |
| W7  | Warning / policy/store inventory    | README/CLAUDE say eight evaluators and five/seven repositories. `RULE_REGISTRY` has ten evaluators; store has eight repository classes and eight domain tables plus schema_migrations bookkeeping.                                                                              | Yes          |
| W8  | Warning / MCP inventory             | README’s five/seven tool summaries differ from eleven registrations in `apps/mcp-server/src/server.ts`: three always-read and eight canWrite-gated (admin by default). Separate from plugin brain_* tools.                                                                      | Yes          |
| W9  | Warning / retrieval default         | README says semantic retrieval deferred/model-free serving. Production config enables dense by default, at loopback8098, while direct callers remain explicit. Unavailable dense fails open to lexical results; optional cross-encoder differs from freshness/category ranking. | Yes          |
| W10 | Warning / index and references      | INDEX misses041 and later category entries; short slugs and links in009–012/AGENTS point to absent paths. Complete real-file catalog and corrected targets replace stale references without changing historical results.                                                        | Yes          |
| W11 | Warning / trust and thesis identity | CLAUDE calls the trail immutable and copies byte-identical; source copies differ, local integrity is tamper-evident. Historical thesis has a dated provenance/trust note and precise terminology.                                                                               | Yes          |
| I1  | Info / enum and scanner counts      | Audit244 reported16 enums and16+7 patterns; current baseline actually has17 enum definitions,17 secret and6 PII patterns. Source-checked current counts replace older12/11 summaries.                                                                                           | Yes          |
| I2  | Info / independent package metadata | Root manifest0.8.0, workspaces0.1.0 except repo-resolver0.0.0; root repository field and workspace license metadata are absent. Document observed independence; no package-version or metadata policy is invented.                                                              | No           |
| I3  | Info / review enforcement           | CONTRIBUTING says one approval and Gemini, whereas current REVIEW/workflow makes MiniMax advisory; main protection snapshot2026-10-26 requires zero approving reviews. Document the observation without changing branch protections or treating provider errors as approval.    | Yes          |

## Advisory findings — judged, not deterministic blockers

- A1: CLAUDE’s119-file, grade-C/no-enforcement audit is dated2026-04-21.
  Replace its current-state framing with actual installed gates and retain its historical meaning.
- A2: Supersession is primarily subject-keyed, with same-category title-Jaccard fallback.
  Current README/Curator overview now follows the implementation already detailed in CLAUDE.
- A3: Shipped owned-runtime tooling, vault tools, dense retrieval and the optional reranker
  need distinct descriptions; source code is not evidence of a current running service or an installed plugin channel.
- A4: Governance receipts, query access logs, source citations, plugin git witnessing and
  per-actor signed merge anchors prove different things. The product overview now separates them.
- A5: 044’s binding model-selection decision excludes EmbeddingGemma; the current manifest/config
  and later operational runbook051 use it. The dated notes expose this conflict and preserve the original decision.
  Ratification or model replacement is separate work in `compile-then-govern-eqw.11`; this correction performs neither.
- A6: 038’s BM25-only/blocked semantic descriptions, blueprint001’s original inventory/license,
  and the thesis’s original publication/phase claims are historical. Dated notes separate them from current source.
- A7: Spool/demo planning text predates shipped implementations. Dated tracking is retained;
  its existence does not prove a fresh demo execution or current complete rollout.
- A8: Generic `bd sync` guidance conflicts with current Dolt authority. Use `bd dolt push` and
  treat JSONL as a passive export; keep the actual Husky/Beads hook chain intact.
- A9: Historical test counts and metrics are not present acceptance results. CI descriptions
  identify actual jobs, advisory Semgrep step semantics, and separately enforced checks rather than declaring all tests passed.

## Check scope and limits

The nine drift checks are scoped here: 3.1 index versus filesystem; 3.2 version strings;
3.3 README commands versus CI; 3.4 CLAUDE document inventory; 3.5 stale phase/status;
3.6 capabilities versus code; 3.7 cross-document facts; 3.8 local cross-references;
and 3.9 planning versus implementation. Runtime code, schemas, weights, lockfiles,
policy and configuration are inspected, not edited. No registry is created.

`/tmp/bbb-registrar-docs-static-v1-receipt.json` is the source-inventory/local-link receipt
produced during validation. Test/check/review/merge outcomes are recorded on the PR and Bead
with the exact head, not asserted by this report. Existing historical measurements and AAR
results retain their original scope. No model, live brain, service, release or website is changed.
