# What Each Chain Proves: the ICO Trace Chain Proves COMPILE, the INTKB Audit Chain Proves GOVERN Admission

**Document:** 046-AT-ARCH
**Date:** 2026-07-19
**Status:** Active
**Related:** 036-AT-THRT (spool boundary threat model) · 034-AT-NTRP (Compile, Then Govern thesis) · umbrella 013-OD-STND · the `provenance-walk` curator-cli subcommand

---

## 1. Why this document exists

Bob's Big Brain carries **two independent hash chains**, one on each side of the
compile/govern boundary. They are frequently described together ("the audit
trail"), and that shorthand invites a specific, dangerous conflation: treating a
verified chain on one side as evidence for a claim that only the _other_ side's
chain can back. This document pins down exactly what each chain evidences, what
neither evidences, and what bridges them — so that every future claim (README
copy, PR body, runbook, sales sentence) can be checked against it.

The one-line rule:

> **The ICO trace chain proves that a COMPILE happened. The INTKB audit chain
> proves that a GOVERN admission decision happened. Neither proves the other's
> claims, and neither proves the content is true.**

## 2. The compile-side chain (ICO / `bobs-big-brain-compiler`)

**Artifacts** (all under the brain root, canonically `~/.teamkb/brain/`):

| Artifact                                      | What it is                                                                                                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brain/.ico/state.db`                         | The compiler's deterministic kernel state (SQLite): sources, tasks, outputs.                                                                                                                                               |
| `brain/audit/traces/YYYY-MM-DD.jsonl`         | Daily trace files. Each event carries `event_type`, `event_id`, `timestamp`, `payload`, and a `prev_hash` linking it to the previous event — hash-chained within the day and now cross-day-chained across file boundaries. |
| `brain/audit/provenance/<sourceId>.jsonl`     | Per-source provenance records: which compile operation (`compile.summarize`, …) emitted which `outputPath` from which source.                                                                                              |
| `brain/spool/…jsonl` + `<file>.manifest.json` | The emitted spool candidates and the manifest sidecar pinning the file's SHA-256 and listing every emitted `candidateId` (ICO kernel `packages/kernel/src/spool.ts`).                                                      |

**What this chain evidences:** that a compile pass ran over given inputs at a
recorded time and emitted given artifacts — e.g. "on 2026-07-16 a
`compile.summarize` pass over source `7efdf9cd…` emitted
`wiki/sources/x.md`, and a spool file containing candidate `4a35532d…` was
written whose bytes hash to the manifest's pinned SHA-256." The `prev_hash`
chain makes after-the-fact edits and reordering of those trace events
_detectable_ (tamper-evident, not tamper-proof).

**What this chain does NOT evidence:**

- that the compiled summary is _accurate_ or _true_ — the model proposed it;
- that the candidate was ever ingested, evaluated, or admitted by INTKB;
- anything at all about what sits in `curated_memories` today.

## 3. The govern-side chain (INTKB / `bobs-big-brain-registrar`)

**Artifacts** (in `teamkb.db`, schema in `packages/store/src/schema.ts`):

| Artifact           | What it is                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_events`     | The receipt log — append-only by protocol, not by storage. Migration-added `entry_hash` / `prev_entry_hash` columns hash-chain each row (`packages/store/src/audit-chain.ts`, verified by `packages/store/src/audit-verify.ts` / `curator-cli verify-audit-chain`).                         |
| `candidates`       | Every ingested candidate, with source metadata (`metadata_json.filePaths[0]` = the compile-side relPath for spool candidates).                                                                                                                                                              |
| `curated_memories` | The governed corpus. Each row carries `candidate_id` — its claimed descent — and is minted exclusively by `promote()` (`apps/curator/src/promotion/promoter.ts`), which writes the row and its `'promoted'` receipt in one transaction (checked by `curator-cli verify-corpus-accounting`). |

**What this chain evidences:** that a specific candidate was admitted (or
rejected, superseded, demoted, …) by the **deterministic policy pipeline**
(`packages/policy-engine`) at a recorded time, by a recorded actor, with a
recorded reason — and that the sequence of those decisions has not been
silently edited or reordered (again: detectable, not impossible — see the
trust-model box in the umbrella README).

**What this chain does NOT evidence:**

- that the candidate's content was compiled correctly, or compiled at all —
  an `mcp`-captured candidate never touched the compiler;
- that the content is _true_ — policy admission is a governance decision
  (dedupe, secret-scan, trust rules), not a fact-check;
- anything about the state of the brain directory or the compiler's traces.

## 4. The bridge between them

Two deterministic mechanisms — and only these two — connect the chains:

1. **The spool manifest SHA-256.** ICO emits each spool file with a
   `<file>.manifest.json` sidecar pinning `spoolFileSha256` and listing
   `candidateIds`. INTKB verifies that pin fail-closed at ingest
   (`verifySpoolManifest`, enforced in `apps/curator/src/intake/spool-intake.ts`;
   mismatches are refused and quarantined). The manifest is the compile side's
   signed-off statement of _what crossed the boundary_.

2. **The UUID-v5 content-addressed id lineage.** A spool candidate's id is
   `uuidv5(workspaceId, relPath, bodySha256)` — a pure function of its content
   and origin, derived identically on both sides
   (`packages/common/src/uuid-v5.ts`, namespace vendored byte-identical from
   the ICO kernel). Promotion then derives
   `memoryId = uuidv5("memory", candidateId, contentHash)`. So a
   `curated_memories` row names, verifiably, exactly which compile-side
   artifact it descends from.

The `provenance-walk` curator-cli subcommand walks this whole path for one
memory (store row → id derivations → `'promoted'` receipt → candidate row →
manifest entry → ICO trace event) and reports PASS / FAIL / UNVERIFIABLE per
link — UNVERIFIABLE, not PASS, when a backing artifact is absent (e.g. no
brain directory on CI).

## 5. The conflation failure mode

The failure mode this document exists to prevent is any sentence shaped like
these — each one **wrong**, quoted here only to be forbidden:

- ❌ "the audit chain proves the content is true / was compiled correctly"
- ❌ "the trace chain proves the memory was admitted"

More concrete wrong examples, with the reason each fails:

- ❌ "The audit chain proves this summary is accurate." — No chain proves
  accuracy; the audit chain proves only _admission by policy, and when_.
- ❌ "The audit chain proves the content was compiled from that source." — That
  is the trace chain's + manifest's claim; the audit chain only records what
  the curator was _told_ via the candidate's id and metadata.
- ❌ "The trace chain proves this page is in the governed corpus." — Compile
  says nothing about admission; the candidate may have been rejected,
  deduplicated, or never ingested.

The honest composite claim is a **conjunction with the bridge stated**: "the
trace chain evidences the compile, the manifest + UUID-v5 lineage evidence that
this exact content crossed the boundary, and the audit chain evidences its
admission." Drop any leg and the claim must shrink accordingly. The umbrella
repo's `scripts/lint-forbidden-words.sh` now carries a CONFLATION check that
flags the wrong forms on brand surfaces.

## 6. Operator quick reference

| Question                                             | Tool                                                                        | Chain consulted         |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------- |
| "Was this memory admitted, when, by whom?"           | `curator-cli verify-audit-chain` + the `'promoted'` receipt                 | govern (`audit_events`) |
| "Did every corpus row come through the promoter?"    | `curator-cli verify-corpus-accounting`                                      | govern                  |
| "Did a compile pass emit this page?"                 | trace/provenance files under `brain/audit/`                                 | compile                 |
| "Does this memory's whole lineage hold, end to end?" | `curator-cli provenance-walk --memory-id <id> --db <path> [--brain <path>]` | both, via the bridge    |
