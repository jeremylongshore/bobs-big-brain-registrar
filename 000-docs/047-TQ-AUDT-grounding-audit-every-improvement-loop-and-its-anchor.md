# Grounding audit: every improvement loop and its anchor

**Doc:** 047-TQ-AUDT · **Date:** 2026-07-19 · **Scope:** qmd-team-intent-kb (the Bob's Big Brain Registrar)
**Companion work:** Wave-2 C2 (groundedness eval) + C3 (govern-decision decision cases), shipped in the same PR as this doc.

## Why this audit exists

Every self-improvement loop in this repo claims to make something better: retrieval, governance,
provenance, freshness, code quality. A loop is only trustworthy if it is **anchored** — pinned to a
frozen dataset, a committed floor, or a labeled fixture that cannot drift with the thing being
measured — and **gated** by a deterministic rule that fails closed. A loop without a real anchor is
a vibe with a dashboard.

This audit enumerates each loop and names, for every one: **what anchors it**, **what rule gates
it**, and **where the anchor lives**. Loops that cannot name a real anchor are listed as DEFECTS at
the end with a proposed bead title (beads not created here).

Honesty note carried throughout: audit-chain claims in this repo are tamper-**evident** (with the
external anchor cross-check), never tamper-proof; eval numbers are only as good as their fixtures,
and every fixture's provenance and blind spots are stated where it is defined.

## The loops

### 1. Synthetic retrieval ratchet (PR-time)

- **What it improves:** keyword/semantic/tokenization retrieval through the production
  `adapter.query()` path.
- **Anchor:** the committed synthetic corpus + query set
  `packages/qmd-adapter/src/eval/datasets/synthetic-v1.ts`, with the measured, committed baseline
  `SYNTHETIC_V1_BASELINE` (lexical Recall@10 = 1.0, semantic = 7/12, tokenization = 1.0 on the
  fused path) and `RATCHET_EPSILON = 0.001`.
- **Gate:** `ci-retrieval-ratchet.ts` exits non-zero if ANY stratum's Recall@10 drops below
  `baseline − ε`; per-stratum, never a blended mean. It is a **regression ratchet**, deliberately
  not an absolute-quality ship gate (the 0.85 sufficiency bar is a decision threshold, per
  038-AT-DECR).
- **Anchor lives:** in-repo (dataset + baseline are committed); run by the individually-named
  `retrieval-eval` job in `.github/workflows/ci.yml`.

### 2. Governed-brain-v1 anchor + floor (scheduled, real corpus)

- **What it improves:** retrieval quality on the REAL brain, not a toy corpus.
- **Anchor:** a FROZEN tar.zst snapshot of `~/.teamkb/kb-export`, pinned by SHA-256 in the
  committed lock file `eval-results/governed-brain-v1-snapshot.lock.json`; hand-labeled queries
  (`datasets/governed-brain-v1.ts`) whose gold ids are `qmd://` citations; the committed
  per-stratum floor file `eval-results/governed-brain-v1-floor.json`.
- **Gate:** `packages/qmd-adapter/src/eval/governed-eval-anchor.ts` — hash mismatch exits 2 (never
  eval an unpinned corpus), stratum below floor exits 1, missing floor exits 3 with a proposed
  floor (never an invented pass). Live-corpus runs are informational only, labeled unfrozen.
- **Anchor lives:** hash + floor + queries in-repo; the snapshot tarball under
  `~/.teamkb/eval-anchor/` on the brain host (private corpus never reaches a GitHub runner); runs
  via the `bbb-eval-governed.timer` systemd user timer.

### 3. Provenance-integrity eval (the receipts moat)

- **What it improves:** per-memory content-hash consistency + audit-chain intactness + the
  fork-classified external-anchor cross-check (Track F2).
- **Anchor:** the eval builds a REAL on-disk brain fixture inside the run
  (`packages/eval-surface/scripts/ci-provenance-integrity.ts`): a forked-but-untampered chain that
  MUST pass with forks disclosed, and a genuinely tampered chain that MUST fail. The
  anchored-truth reference is the hash-chain construction itself plus the external anchor log.
- **Gate:** exit non-zero on genuine tampering passing or a clean/forked brain failing — both
  directions asserted, so the metric can fail.
- **Anchor lives:** in-repo (script + eval `packages/eval-surface/src/provenance-integrity.ts`);
  required per-PR via the `moat-evals` job in `ci.yml`, re-run in `nightly.yml`. Divergence
  recovery runbook: 045-OD-RNBK.

### 4. Govern-decision eval (sensitive material + decision classes)

- **What it improves:** the actual EFFICACY (not just determinism) of the govern decision.
- **Anchor:** two versioned labeled sets, both in-repo and empirically labeled:
  - `govern-decision/dataset/v1` (v1.2.0) — 33 adversarial secret/PII/path cases with
    per-check `expectCaughtBy` / `knownFalseNegativeOf` ground truth;
  - `govern-decision/decision-dataset/v1` (v1.0.0, new in Wave-2 C3) — 14 dedup /
    contradiction / supersession / clean cases wired through the real store, the real
    `PolicyPipeline` (`dedup_check` + `contradiction_check`), and the real
    `detectSupersession`, reported per check AND per relationship class.
- **Gate:** `ci-govern-decision.ts` fails closed on ANY undocumented false-negative in either
  section. Documented gaps (split-key/boundary blind spots; re-cased dup, low-overlap and
  cross-category contradictions, reworded-title supersession) are reported, never hidden.
- **Anchor lives:** in-repo; required per-PR via `moat-evals` in `ci.yml`, re-run in `nightly.yml`.

### 5. Groundedness eval (new — Wave-2 C2)

- **What it improves:** whether an answer-like claim stays anchored to the memory it cites
  (support-by-admitted-facts — explicitly NOT truth, NOT entailment).
- **Anchor:** `groundedness/fixture/v1` — 60 labeled items (30 supported / 30 unsupported) built
  from 30 real promoted-memory excerpts (kb-export UUIDs recorded per item) with synthetic
  claims; semi-synthetic-from-real, stated in the fixture header. Committed floors measured on
  the first real run (supported-precision 0.8824 → floor 0.88; unsupported-catch-rate 0.8667 →
  floor 0.86); scorer blind spots (3 argument swaps, 1 distant negation) are fixture-documented.
- **Gate:** `ci-groundedness.ts` fails closed on any undocumented scorer error or a segment
  falling below its floor. The scorer is pure deterministic arithmetic — no LLM in the gate; the
  env-gated MiniMax judge is an offline comparison arm only, off in CI by construction (tested).
- **Anchor lives:** in-repo; run by the groundedness step in `nightly.yml`.
- **Known caveat (also listed as DEFECT G2 below):** scorer thresholds were tuned on this same
  fixture — the reported metrics are in-sample fit.

### 6. Corpus accounting (substrate ↔ receipts agreement)

- **What it improves:** the invariant that every `curated_memories` row carries its row-creating
  `promoted` receipt written in the same transaction (no substrate bypass).
- **Anchor:** the invariant itself is the anchor — `verify-corpus-accounting` re-derives it from
  the store + audit log; the nightly job proves the MECHANISM on a synthetic store built by the
  real curator CLI (≥1 accounted row required, so an empty store cannot pass trivially) and then
  proves a planted raw-SQL bypass row is detected (non-zero exit).
- **Gate:** the `Corpus-accounting guard` step in `nightly.yml` (jq assertion + bypass-detection
  assertion, both fail-closed).
- **Anchor lives:** verifier in `apps/curator` (`verify-corpus-accounting`); nightly step in-repo;
  the run against the LIVE `~/.teamkb` store is an ops concern on the brain host (runbook
  027-OD-OPSM).

### 7. Staleness canary (search freshness)

- **What it improves:** promoted memories becoming promptly searchable; a broken/misrouted index
  failing loudly instead of returning silent empty results.
- **Anchor:** known-positive control queries against a fixture brain built in the nightly run
  (seeded from a committed markdown seed), plus `--max-staleness-seconds 86400` (D2) asserting no
  promotion waits more than 24 h to become searchable.
- **Gate:** the `Search-health canary` step in `nightly.yml` exits non-zero on 0 hits for any
  known-positive control. On the ephemeral fixture the staleness leg reports "unmeasured" and
  passes — the staleness assertion bites on the live-brain canary (runbook 027-OD-OPSM), the only
  host with the real `~/.teamkb`.
- **Anchor lives:** canary CLI in `packages/qmd-adapter` (in-repo); live-brain leg on the brain
  host per the runbook.

### 8. Mutation / coverage gates (test-suite quality)

- **Coverage — anchored and gated:** Codecov required PR checks read `codecov.yml` — patch
  coverage target 80% (threshold 0%), project target auto with 1% threshold. Anchor = the
  committed `codecov.yml` targets; gate = the required Codecov checks in branch protection;
  uploaded from the `validate` job in `ci.yml`.
- **Mutation — configured but NOT anchored to any scheduled run:** `stryker.config.mjs` commits
  real thresholds (`break: 70`) and `pnpm test:mutation` runs the suite locally, but **no CI or
  nightly workflow executes Stryker** — the threshold is a rule with no loop attached. Listed as
  DEFECT G1 below.

## DEFECTS — loops that cannot name a real anchor

Each defect gets a proposed bead title (plain-English imperative, per the bead naming convention).
No beads are created by this doc.

- **G1 — Mutation gate has a committed threshold but no scheduled run.** `stryker.config.mjs`
  carries `break: 70`, yet no workflow (ci.yml, nightly.yml) runs Stryker, so mutation-score
  regressions are invisible until someone runs it by hand. Proposed bead:
  _"Run the Stryker mutation suite on a schedule and fail the run when the committed break
  threshold is not met."_
- **G2 — Groundedness metrics are in-sample.** Scorer v1's thresholds and window sizes were tuned
  on the same fixture the floors were measured on; there is no independently authored held-out
  set, so the reported precision/catch-rate overstate generalization by an unknown amount (the
  fixture and module docs disclose this). Proposed bead:
  _"Author a held-out groundedness validation set independently of scorer tuning and report both
  in-sample and held-out numbers."_
- **G3 — The live-host loops have no CI-visible dead-man's switch.** The governed-brain-v1 anchor
  (timer), the live staleness canary, and the live corpus-accounting run all execute on the brain
  host; if the host or a timer dies, CI stays green and nothing in THIS repo notices (the dev-box
  liveness sweep is estate tooling outside this repo's audit surface). Proposed bead:
  _"Publish a freshness heartbeat from the brain-host eval timers that a repo-side check can
  verify and alert on."_

## Reading rule for future loops

A new improvement loop lands with: (1) a versioned, committed (or hash-pinned) anchor; (2) a
deterministic fail-closed gate wired to a named CI job or timer; (3) an honest statement of what
the metric cannot see. If any of the three is missing, it goes in this doc's DEFECT list before it
ships, not after.
