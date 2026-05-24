---
title: 'Post-Thesis Build Direction — Executive Council Decision Record'
filing_code: 035-AT-DECR
date: 2026-05-23
acting_head_of_board: Jeremy Longshore (Intent Solutions)
council_skill: /exec-decision-council (ISEDC pattern)
input_paper: 034-AT-NTRP-ecosystem-thesis.md
parent_bead_ico: intentional-cognition-os-ziz
parent_bead_intkb: qmd-team-intent-kb-oaa
cross_repo: byte-identical copy at qmd-team-intent-kb/000-docs/035-AT-DECR-post-thesis-build-direction-2026-05-23.md
seats_convened: [CTO, GC, CFO, CSO, CISO, 'VP DevRel', CMO]
seats_muted_in_synthesis: [CMO]
status: binding decision record — supersedes only by explicit later DECR
license: MIT
---

# Post-Thesis Build Direction — Executive Council Decision Record

## 0. Provenance and Convening Context

This Decision Record is the binding output of an executive council convened on
the peer-reviewed thesis paper `034-AT-NTRP-ecosystem-thesis.md` ("Compile,
Then Govern: A Two-Layer Local-First Architecture for Team Institutional
Memory", 2026-05-23). The council convened under the ISEDC (Intent Solutions
Executive Decision Council) pattern with seven seats present and arguing from
distinct value systems:

| Seat      | Value system anchor                                                                    |
| --------- | -------------------------------------------------------------------------------------- |
| CTO       | Technical risk, architecture coherence, build feasibility                              |
| GC        | Legal exposure, IP posture, licensing                                                  |
| CFO       | Capital allocation, runway, ROI on engineering hours                                   |
| CSO       | Strategic positioning, ecosystem leverage, multi-year moat                             |
| CISO      | Threat model, supply chain risk, secret hygiene                                        |
| VP DevRel | Open-source adoption mechanics, community signal                                       |
| CMO       | Marketing positioning, brand narrative — **muted in synthesis per operator direction** |

**CMO seat is convened**, so dissent on the marketing dimension is preserved
for the record, but its conclusions are explicitly excluded from the synthesis
that drives the build plan. The operator's direction (Jeremy Longshore, acting
head of board) is that this build round is engineering-led, not marketing-led;
the muted seat's position is retained verbatim for a future decision-maker who
may wish to overturn that direction.

**Acting head of board**: Jeremy Longshore. The council surfaces dissent; the
head of board makes the final call. This document is the binding record of
that call.

## 1. Question Put to the Council

> _Given what the ecosystem-thesis paper surfaced, what is the highest-leverage
> thing to build next in each of the two repos (ICO and INTKB), what does
> success of that build look like in measurable / time-boxed / observable
> terms, and what minority positions must be acknowledged even when rejected?_

## 2. Verbatim Seat Positions

### 2.1 CTO

> The thesis is honest about the largest open gap in the architecture: the
> spool boundary from ICO to INTKB is _not actually wired in production code_.
> §6.2 acknowledges this; the INTKB JOURNEYS document marks the relevant
> journey step (memory-capture step 2) as deferred under bead chain
> `qmd-team-intent-kb-pw9 → vj6`. Every other architectural claim in the
> paper is downstream of that wiring. Until the spool boundary is shipped
> end-to-end, the paper is _describing_ an architecture that the reference
> implementation _does not yet exhibit_. Highest-leverage build: wire the
> ICO → INTKB spool bridge. Lock target on a working end-to-end ingestion
> demo against a non-author corpus within 6 weeks. Everything else is
> secondary until this seam is real.

### 2.2 GC

> The thesis cites the EU AI Act (Articles 12 / 13 / 14), California SB 53 / 942,
> Colorado SB 189, and the Canadian AIDA collapse as the regulatory frame.
> The legal exposure for the project itself is presently minimal — Intent
> Solutions is not a regulated entity selling to EU enterprises today — but
> the _positioning_ in §5.1 implies the architecture _enables_ certification
> against the EU AI Act. That is a claim that downstream users will rely on.
> Build implication: before any external party claims compliance support, we
> need a documented mapping between the paper's audit-trail claims and the
> specific EU AI Act articles, with explicit non-claims (we enable, we do not
> certify). License posture is clean: MIT on both projects, no copyleft
> contamination from the cited prior art (all the academic citations are
> arXiv preprints; the only ELv2-licensed reference is Phoenix, and we don't
> depend on it). No GC objection to the build direction.

### 2.3 CFO

> The thesis is a marketing-quality asset that took zero customer dollars
> to produce; the engineering effort to make the architecture it describes
> _actually shipping_ is the open question. The CTO's proposed 6-week wire-
> up is feasible within current run-rate; the empirical-experiment proposal
> in §8 of the thesis (run the pipeline against a corpus the author did not
> produce, measure outcome quality vs. RAG baseline) is the highest-ROI
> follow-on because it converts the paper from _architectural argument_ to
> _evidenced claim_. Without that experiment the paper sits in the same
> credibility class as every other architectural manifesto. Recommend
> sequencing: spool wire-up first (CTO ask), then the empirical experiment
> second (which is also the highest-leverage thing the academic literature
> would _cite_), then everything else. Allocated engineering budget: 8 weeks
> of operator-developer time spread across both repos, no external hires.

### 2.4 CSO

> Strategically, the paper's contribution is the _separation_ — the
> compilation layer / governance layer split. That separation is what makes
> the architecture defensible against Karpathy-style LLM-KB releases (when
> they come, they will likely cover only the compilation side and leave
> governance unsolved). The build direction that maximises that strategic
> moat is to invest _disproportionately_ in INTKB — the governance layer is
> where the genuinely under-explored work lives, per the IDEA-CHANGELOG
> 2026-04-06 entry that ranks the moat as: deterministic control plane >
> provenance chain > multi-agent research > recall. ICO is the more
> developed of the two projects; INTKB is the more strategically valuable.
> Recommend: spool wire-up _binds_ the two projects (CTO ask), and then the
> next investment goes to INTKB's policy-engine surface area, _not_ to
> further ICO compiler passes.

### 2.5 CISO

> Threat model concerns: (1) The thesis claims the audit JSONL is tamper-
> evident via SHA-256 integrity chain, but the adversarial review (Longshore
> 2026c) confirmed there is no verification code anywhere — the chain is
> only as tamper-evident as the verification function that walks it. Before
> external compliance claims are made, that verification primitive must
> exist and be runnable from CI. (2) The spool boundary is the highest-risk
> seam in the architecture from a CISO perspective — any code that writes to
> the spool is effectively writing into the team's searchable memory after
> governance. The governance policy pipeline (secret detection, dedup,
> tenant isolation) is the trust anchor; its policy ruleset MUST be hash-
> pinned and gated against unauthorised modification, per the same harness
> pattern already in use for `tests/TESTING.md` (audit-harness `init` flow).
> (3) PoisonedRAG (Zou et al., 2025) is cited as the RAG attack motivation;
> the equivalent attack on compile-then-govern is _poisoning the spool input_
> — we should explicitly model this in a future security-test layer.
> Build implication: the spool wire-up (CTO ask) MUST land with (a) a
> hash-chain verifier, (b) a hash-pinned governance policy ruleset, (c) an
> initial threat model document covering spool-injection attacks.

### 2.6 VP DevRel

> The OSS-adoption mechanics of compile-then-govern depend on lowering the
> barrier to operator-developers trying the pipeline against their own
> corpus. The thesis is well-written but it asks the reader to run two
> separate projects, each with its own CLI surface and its own bead
> tracker, and to wire them together via a spool directory that the
> projects do not currently agree on. The single most adoption-relevant
> piece of work the council should fund is _a one-command "try the
> pipeline against this directory" experience_. That experience does not
> exist today. It also doesn't need fancy infrastructure — it needs a
> documented quickstart that produces a working compile → govern → search
> loop in under 15 minutes against a sample corpus. This is the artifact
> that turns the paper into something a platform-team lead can actually
> evaluate.

### 2.7 CMO (MUTED — verbatim retained for archive)

> The paper's "compile, then govern" framing is the cleanest narrative the
> project has ever shipped. Putting it on the marketing surface (blog,
> social, conference talk submissions) within 30 days while the narrative
> is fresh would multiply its reach. The competitive surface is currently
> uncluttered — Karpathy hasn't released, Notion AI hasn't framed
> governance, Glean is still all-retrieval. There is a window. Marketing
> push: dedicated blog series across `startaitools.com`, conference talk
> submissions to PyCon / StrangeLoop / KubeCon (KCD), curated outreach to
> the seven OSS projects cited as adjacent work.
>
> _— CMO position muted in synthesis per operator direction; preserved
> verbatim for future decision-maker. Operator's stated reason for muting:
> "this build round is engineering-led, not marketing-led; we are not
> deciding based on marketing signals."_

## 3. Steel-Manned Minority Positions

A council that surfaces only consensus is not doing its job. Three minority
positions emerged that the head of board explicitly rejected but that future
decision-makers should be aware of:

### 3.1 CSO minority position: invert the build sequence

> **Position:** Start with the empirical experiment (CFO's second-priority
> item) _before_ the spool wire-up. The wire-up costs 6 weeks of engineering
> against an architecture that may already be the right answer; the
> experiment costs 2 weeks and tells us _whether the architecture is right
> at all_. If the experiment shows compiled team memory does NOT meaningfully
> beat RAG-over-raw-documents on the target outcome metric, the spool wire-
> up becomes a sunk-cost investment in a thesis that didn't hold.
>
> **Why rejected:** the CTO's counter-argument is that the experiment cannot
> be cleanly run _without_ the spool wired up — the comparison needs the
> full pipeline functioning. Wiring the spool is on the critical path for
> the experiment, not parallel to it. Head of board accepted the CTO's
> sequencing argument.
>
> **Status if reopened:** if the spool wire-up proves harder than estimated
> (>8 weeks), this minority position becomes the dominant counter-argument
> and the build plan should pause for an explicit re-evaluation.

### 3.2 GC minority position: defer the regulatory framing entirely

> **Position:** The §5 (Regulatory Context and Compliance) section of the
> thesis creates downstream user expectations that the project is not yet
> positioned to honour. Better to remove the section, ship the architecture
> as a pure engineering claim, and only re-add the regulatory framing
> _after_ a real customer engagement that requires it. Otherwise we are
> writing checks the project cannot cash.
>
> **Why rejected:** the head of board judged that the §5 framing is
> _important to the audience_ (engineering managers and platform leads who
> are looking at the 2026 regulatory wave) and that the explicit non-claims
> ("we enable, we do not certify") provide adequate protection. The
> alternative — silence on the regulatory dimension — was judged to
> undersell the actual architectural advantage compile-then-govern provides
> for compliance-track teams.
>
> **Status if reopened:** if a downstream user _does_ misinterpret §5 as a
> certification claim, the next revision of the thesis should pull back the
> regulatory framing significantly.

### 3.3 CISO minority position: do not ship the spool wire-up at all until

### the threat model exists

> **Position:** §6.1 of the thesis names secret detection / dedup / tenant
> isolation as the governance pipeline's responsibilities, but no formal
> threat model document exists for the spool seam. Shipping the wire-up
> before the threat model creates a window where the operational system has
> attack surface that nobody has yet enumerated. Defer the wire-up by 2
> weeks; produce the threat model first.
>
> **Why rejected:** the head of board judged that the threat-model work can
> be parallel to the wire-up work (CISO's three build-implication items
> a/b/c are tractable as a parallel track) and that further blocking the
> wire-up sequencing would let the perfect become the enemy of the good.
>
> **Status if reopened:** if the spool wire-up ships and the threat-model
> work is _not_ complete within the same delivery wave, this minority
> position retroactively becomes correct.

## 4. Synthesis: The Build Plan (CMO Excluded)

The synthesis below excludes the CMO seat per operator direction and weighs
the six remaining seats against each other. Three build items are funded;
they are ranked by leverage; each carries an explicit re-tuned definition of
success.

### 4.1 Build Item A — Wire the ICO → INTKB spool boundary end-to-end

| Field                      | Value                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner                      | ICO + INTKB jointly (operator-developer)                                                                                                                                                                                                                                                                                                                           |
| Anchor seats               | CTO (primary), CFO (sequencing), CSO (strategic)                                                                                                                                                                                                                                                                                                                   |
| Dissent                    | CSO minority §3.1 (start with experiment instead); CISO minority §3.3 (defer until threat model exists) — both rejected by head of board                                                                                                                                                                                                                           |
| Repo                       | ICO (writer side); INTKB (reader side); spool directory under shared control                                                                                                                                                                                                                                                                                       |
| Bead                       | TBD on materialization (Phase 6) — ICO and INTKB child beads under their respective epics                                                                                                                                                                                                                                                                          |
| Success metric             | A non-author corpus of ≥50 markdown source files runs end-to-end through ICO compile → spool → INTKB ingestFromSpool → policy-engine evaluation → inbox; a curator promotion via API moves at least one candidate to Active lifecycle; the curated memory is queryable via qmd local search. Demonstrable as a single recorded screencast / a CI integration test. |
| Time-box                   | 6 weeks from bead claim (target completion: 2026-07-04)                                                                                                                                                                                                                                                                                                            |
| Hard gates (per CISO seat) | (a) hash-chain verifier function exists and is callable from CI; (b) governance policy ruleset is hash-pinned via audit-harness `init` flow; (c) initial threat model document for the spool boundary exists in `000-docs/036-AT-THRT-spool-threat-model.md`                                                                                                       |
| Observable on failure      | A 2026-07-04 status check confirms (yes/no) each of the four success bullets; missing items become explicit P0 carryover beads                                                                                                                                                                                                                                     |

### 4.2 Build Item B — Empirical experiment: compiled team memory vs RAG over raw documents

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                 | ICO (primary) — extends the existing `evals/` framework with a comparative-evaluation handler                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Anchor seats          | CFO (highest ROI), CSO (publishable result)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Dissent               | CSO minority §3.1 (do this first, not second) — rejected on CTO sequencing argument                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Repo                  | ICO primarily; INTKB participates as the curated-memory provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Bead                  | TBD on materialization (Phase 6) — ICO-only child bead under the cross-repo epic                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Success metric        | A controlled experiment using a non-author corpus (target: 100-question evaluation set, ≥50 source documents) compares: (1) RAG-over-raw-documents baseline, (2) ICO-compiled-wiki retrieval, (3) ICO-compiled-wiki + INTKB-governance retrieval. Measures answer correctness (human-graded or model-graded with disclosed rubric), source attribution accuracy, and latency. Publishable result: a table with the three conditions × three metrics, with statistical significance test. Goes into a follow-on thesis revision or a separate evaluation paper. |
| Time-box              | 4 weeks following Build Item A delivery (target: 2026-08-01)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Hard gates            | Must use a corpus the author did not produce. Must be reproducible from a single `ico eval run --spec compare-vs-rag.eval.yaml` command.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Observable on failure | A 2026-08-01 status check confirms (yes/no) experiment ran, results table exists, and conclusions are documented.                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 4.3 Build Item C — One-command try-the-pipeline quickstart

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                 | INTKB primarily (consumer side defines the integration UX); ICO contributes the compile-and-spool half                                                                                                                                                                                                                                                                                                                                        |
| Anchor seats          | VP DevRel (primary), CTO (consistency with architecture)                                                                                                                                                                                                                                                                                                                                                                                      |
| Dissent               | None registered — council unanimous (minus CMO)                                                                                                                                                                                                                                                                                                                                                                                               |
| Repo                  | INTKB primarily; ICO contributes the compile-and-spool half                                                                                                                                                                                                                                                                                                                                                                                   |
| Bead                  | TBD on materialization (Phase 6) — INTKB child bead with an ICO cross-repo dependency                                                                                                                                                                                                                                                                                                                                                         |
| Success metric        | A new operator-developer can, with both projects installed via `npm i -g`, run `npx @intentsolutions/compile-then-govern-quickstart ~/my-notes/` and within 15 minutes see (1) compiled wiki produced, (2) governance-promoted candidate memories visible via qmd search, (3) a sample query returning a curated answer with source attribution. Measured against a real outside operator-developer who has never seen either project before. |
| Time-box              | 3 weeks following Build Item A delivery (target: 2026-07-25)                                                                                                                                                                                                                                                                                                                                                                                  |
| Hard gates            | Must work on macOS and Linux. Must not require manual editing of any config file.                                                                                                                                                                                                                                                                                                                                                             |
| Observable on failure | A 2026-07-25 status check confirms a real outside operator-developer's recorded 15-minute attempt; success criterion is binary (they got to a curated-answer query or they did not).                                                                                                                                                                                                                                                          |

## 5. Re-Tuned Definition of Success (Build-Side, Distinct from Paper-Side)

The thesis paper's success criteria stood for Phase 1–4 (peer-reviewed,
Semantic-Scholar-grounded, byte-identical in both repos, 100% integrity
gate, MINOR-or-ACCEPT editorial decision). Those criteria are now closed.

The _build-side_ success criteria, governed by this Decision Record, are:

| #   | Build-side success criterion                                                                           | How verified                                                          |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 1   | Spool boundary end-to-end on non-author corpus by 2026-07-04                                           | Demonstrable screencast or CI integration test                        |
| 2   | Hash-chain verifier + hash-pinned governance ruleset + spool threat-model doc all landed by 2026-07-04 | Three explicit deliverables, each in its own bead                     |
| 3   | Empirical compile-then-govern vs RAG experiment by 2026-08-01                                          | Reproducible from one `ico eval run` command; results table published |
| 4   | One-command quickstart works for an outside operator-developer by 2026-07-25                           | Binary pass/fail on real outside-developer test                       |
| 5   | All three build items tracked as cross-repo beads with three-layer mirror clean                        | `bd-sync status` reports Linked GH + Linked Plane on every build bead |
| 6   | This Decision Record cited by every build bead spawned from it                                         | grep across `.beads/issues.jsonl` confirms                            |

All six are measurable, time-boxed, and observable — per the operator's
re-tuned-success requirement.

## 6. What This Decision Record Does NOT Do

- It does not approve any marketing surface push. CMO seat is muted; marketing
  artifacts are not in scope for this build round.
- It does not commit to a particular external customer engagement. The §5
  regulatory framing is enabling; it is not a sales narrative.
- It does not approve any external talks or conference submissions during this
  build round. Those decisions will be made separately if and when the
  empirical experiment (Build Item B) produces a publishable result.
- It does not modify the existing `intentional-cognition-os-nhj` upstream-
  contributions epic. Upstream qmd contribution remains its own scope.
- It does not commit to extending the architecture to a third repo
  (IEP / `intent-eval-platform`). IEP is cited as a source by the thesis;
  the council judged that bringing IEP into the build scope would dilute
  focus during this build round. IEP build participation can be revisited
  in a future Decision Record.

## 7. Spawned Beads (Filled in by Phase 6 of the Plan)

This section is updated by Phase 6 of the cross-repo plan as each Build Item
is materialised into a bead in the corresponding repo. Each entry lists:
(a) the build item, (b) the repo, (c) the bead system ID, (d) the GH issue,
(e) the Plane issue, (f) the dissent or minority position recorded in the
bead's description (verbatim from §3 above where applicable).

Per CLAUDE.md three-layer-mirror granularity guidance, task beads inside an
epic do not get their own GitHub or Plane issues; they ride on the parent
epic's records (ICO GH `#99` + Plane `ICOS-23`; INTKB GH `#140` + Plane
`INTKB-6`). The cross-repo correlation mechanism for the build items is the
parent epics + this Decision Record, not per-item issues.

| Build Item                            | Repo  | Bead                           | Parent epic GH                              | Parent epic Plane | Dissent recorded                                                             |
| ------------------------------------- | ----- | ------------------------------ | ------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| A (spool wire-up — ICO writer side)   | ICO   | intentional-cognition-os-ziz.3 | jeremylongshore/intentional-cognition-os#99 | ICOS-23           | yes — §3.1 (REJECTED) + §3.3 (REJECTED) cited in bead description            |
| A (spool wire-up — INTKB reader side) | INTKB | qmd-team-intent-kb-oaa.3       | jeremylongshore/qmd-team-intent-kb#140      | INTKB-6           | yes — §3.3 (REJECTED) cited in bead description                              |
| A-gate (hash-chain verifier)          | ICO   | intentional-cognition-os-ziz.4 | jeremylongshore/intentional-cognition-os#99 | ICOS-23           | CISO seat §2.5(1) verbatim in bead description                               |
| A-gate (hash-pin governance ruleset)  | INTKB | qmd-team-intent-kb-oaa.4       | jeremylongshore/qmd-team-intent-kb#140      | INTKB-6           | CISO seat §2.5(2) verbatim in bead description                               |
| A-gate (spool threat-model doc)       | INTKB | qmd-team-intent-kb-oaa.5       | jeremylongshore/qmd-team-intent-kb#140      | INTKB-6           | CISO seat §2.5(3) + retro-correctness condition for §3.3 in bead description |
| B (empirical experiment)              | ICO   | intentional-cognition-os-ziz.5 | jeremylongshore/intentional-cognition-os#99 | ICOS-23           | yes — §3.1 (REJECTED) cited in bead description                              |
| C (quickstart UX)                     | INTKB | qmd-team-intent-kb-oaa.6       | jeremylongshore/qmd-team-intent-kb#140      | INTKB-6           | none registered — council unanimous (minus muted CMO)                        |

All seven build beads cite this Decision Record (`035-AT-DECR-post-thesis-
build-direction-2026-05-23.md`) in their `--notes` field; `grep` across
`.beads/issues.jsonl` in both repos confirms the back-reference is planted.

## 8. Closing Note from the Head of Board

> The council did its job. The CMO seat was muted intentionally and the
> minority dissents from CSO and CISO are documented for the record. The
> build plan is sequenced, time-boxed, and the success criteria are
> observable rather than aspirational. Phase 6 of the cross-repo plan now
> materialises these items as trackable work across both repos.
>
> The single non-negotiable element of this Decision Record is the spool
> boundary wire-up. The thesis paper's central claim is that compile-then-
> govern is the right architecture for team institutional memory; until the
> reference implementation actually exhibits that architecture end-to-end,
> the paper is describing an aspiration. Six weeks. By 2026-07-04. Then we
> can decide what comes next.
>
> — Jeremy Longshore, 2026-05-23

---

_This Decision Record lands byte-identical in both
`intentional-cognition-os/000-docs/035-AT-DECR-post-thesis-build-direction-2026-05-23.md`
and
`qmd-team-intent-kb/000-docs/035-AT-DECR-post-thesis-build-direction-2026-05-23.md`.
SHA-256 of the canonical version is recorded in the git commit that lands it.
Any future revision must update both copies in the same revision wave._
