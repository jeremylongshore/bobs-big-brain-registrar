# REVIEW.md

Repository-specific guidance for the MiniMax-M3 automated pull-request reviewer.

Catch defects, unsafe claims, and governance drift that CI cannot judge. Report only findings
introduced by the pull request and verify each against surrounding source. The reviewer is
**advisory** — it never blocks a merge. The deterministic gate is always the blocking CI jobs.

## Review objective

qmd-team-intent-kb (INTKB) is the **deterministic govern engine** of Bob's Big Brain. It consumes
ICO's spool of `MemoryCandidate`s and runs dedupe → policy → promotion, writing every operation to a
SHA-256 hash-chained append-only audit log; `qmd` (BM25 + native FTS5) serves retrieval. Review for:
the propose-vs-own determinism boundary, disclosure safety, spool-contract integrity, honest
lifecycle/status claims, tamper-evidence honesty, ontology enforcement at write time, and retrieval
determinism. INTKB is **not** a qmd fork, not git-as-database, not prompt-only memory governance.

## Authority and truth hierarchy

Read `CLAUDE.md` and `AGENTS.md`. For architectural questions inspect `000-docs/` — the repo
blueprint, the ecosystem thesis (`034-AT-NTRP`), the post-thesis build direction (`035-AT-DECR`), the
spool-boundary threat model (`036-AT-THRT`), the source/index-separation design (`037-AT-DSGN`), and
the retrieval-backend decision (`038-AT-DECR`) — plus the relevant Zod schemas and policy rules.

1. Explicit owner decisions and ratified decision records (`000-docs/*-AT-DECR`) govern intended
   architecture; the ecosystem thesis is load-bearing and is not contradicted without a new ADR.
2. Running reality and executable repository state decide implementation status.
3. Current canonical schemas, policy rules, and status guards outrank summaries, handoffs, closed
   issues, PR descriptions, chat assertions, and historical Beads memories.
4. Historical records (AARs, dated decision records) describe what was known then. Require a dated
   correction or successor instead of rewriting them to fit today's narrative.
5. Green CI proves only the checks that ran, not architecture, operational readiness, live
   integration, owner approval, or production conformance.

Flag silent boundary changes, second sources of truth, or proposals presented as authority.

## Disclosure and secret safety

Treat disclosure as this repository's highest-risk boundary.

- Never permit personal compensation, comp-split, pay, credentials, tokens, API keys, or plaintext
  secrets in the diff or in Git. Client and revenue amounts are allowed.
- The secret-detection policy rule and the capture-time scanner are **regex-deterministic** and can
  miss a split, concatenated, or encoded key — read new persistence, export, and log paths for a
  secret the deterministic filter would slip through.
- Audit events and receipts carry identifiers, decisions, rule/tier, timestamps, and one-way hashes —
  never rejected source content.

Flag any new persistence, export, or notification path that bypasses the canonical policy pipeline or
secret scanner. Never reproduce a suspected secret in a review comment; identify only its location and
the required remediation.

## Tamper-evidence honesty invariant

The audit chain is tamper-**evident**, not tamper-**proof**: a local writer with write access can edit
an event _and_ re-hash the chain forward, and verification will pass again. Keep every audit/receipt
claim honest to that trust model.

- **Forbidden claim words** anywhere in code comments, docs, or the PR body: **tamper-proof**,
  **immutable**, **non-repudiation** (for local mode), **blockchain**. Flag any that a change
  introduces.
- Flag a bare **"append-only"** claim that is not qualified — say _append-only by protocol_,
  _hash-chained_, or _tamper-evident_, or negate it. The chain gives local integrity + ordering;
  cross-actor non-repudiation needs the external chain-head anchor, not the local chain alone.

## Deterministic-governance invariant

The core constraint: **the model proposes; the deterministic system owns durable state, policy,
promotion, and ALL audit writes.**

- Flag any change that lets a model call write durable governed state, or that inserts an LLM/agent
  into the critical govern-or-serve path.
- Dedupe, supersession, policy evaluation, promotion, and audit-append stay deterministic and
  reproducible from clean state; determinism claims require reproducible normalized events + receipts.
- **Ontology enforcement:** `category`, `trust_level`, and `sensitivity` enums must be enforced at
  **write** time, not just read time. A registered policy rule must actually gate the write. A silent
  enum default that launders an unknown value into a trusted collection is a finding.
- Policy rules are registered in `RULE_REGISTRY` and short-circuit on first failure — a new rule that
  is registered but never reached, or a pipeline reorder that lets a write skip a gate, is a finding.

## Spool trust boundary

The spool is the ICO → INTKB hand-off and the trust boundary.

- Candidate ids are content-stable **UUID-v5** over `namespace + workspaceId\x00relPath\x00
bodySha256`. A one-byte drift in the derivation inputs produces a new id, which breaks dedupe and
  severs the audit link. Flag any change to id derivation, the field separator, or the hashed body
  without a `schemaVersion` bump and a migration/alias story.
- The spool contract (candidate shape, field semantics, ordering) changes only through an explicit,
  versioned migration that preserves audit continuity. Unknown `schemaVersion` and malformed input
  fail closed.

## Retrieval-eval discipline

Retrieval serving is **LLM-free**: BM25-on-qmd + native FTS5 fusion with deterministic RRF/rerank
(per `038-AT-DECR`). A semantic backend is deferred until the eval gate says otherwise.

- Any ranking, fusion, tokenization, or scoring change must move the retrieval-eval CI baseline **in
  the same PR** — the stratified Recall@10 ratchet (`eval:retrieval:ci`) is the gate, not a promise.
- Do not introduce an ML model, network call, or non-determinism into the serving path.
- The qmd binary + GGUF weights are SHA-256-pinned and fail-closed; flag any change that unpins,
  softens, or bypasses that verification.

## Verification expectations

New governance rules need tests of the observable result (what gets promoted/rejected and what the
audit event records), not internal calls or exit codes. Every claimed control needs a planted-defect
or failure-path test proving it has teeth (e.g. a fabricated-secret candidate must be rejected; a
tampered chain must fail verification). Prefer deterministic fixtures and `createTestDatabase()` over
mocks.

Do not repeat CI output inline; the blocking gate already runs `pnpm validate` (format, lint,
typecheck, test), `depcruise` (architecture), `crap` (complexity), `harness-pin`, coverage/Codecov,
the provenance + govern-decision evals, the retrieval ratchet, and `security.yml` (gitleaks, semgrep,
npm audit). Review _why_ green checks might still mask unsafe design or a false claim. Durable-state
or schema changes require migration coverage, fixture/validator/consumer updates, and rollback-aware
review proportional to the claim.

## Severity calibration

- **Critical:** a secret can persist; a model can write durable governed state; a govern gate can be
  bypassed or fail open; an id-derivation/spool change silently breaks dedupe or the audit link;
  determinism is broken in the serving/policy path; a forbidden tamper-proof/immutable claim ships; or
  a false production/phase claim that can authorize unsafe action.
- **Warning:** missing validation or independent verification; write-time enum enforcement absent;
  ranking change without the eval baseline moved; schema/consumer drift; weak idempotency; unqualified
  "append-only"; misleading status; missing migration or rollback evidence.
- **Info:** a concrete maintainability or documentation improvement with real future cost. Use
  sparingly, never for personal preference.

Do not flag formatting-only differences or failures already enforced and reported by tooling. Severity
follows credible impact, not file importance.

## Comments and summary

Comment on an exact changed line only when actionable. Inspect enough context to prove the issue; do
not post speculative or duplicate findings, and do not restate what CI enforces. Explain the impact
and the smallest safe correction. On a re-review the bar does not rise — drop findings the update
resolved. If no actionable finding remains, respond with `lgtm` and nothing else.
