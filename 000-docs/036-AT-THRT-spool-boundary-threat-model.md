---
title: 'Spool Boundary Threat Model'
filing_code: 036-AT-THRT
date: 2026-05-24
authors:
  - Jeremy Longshore (Intent Solutions)
status: v1 — covers single-operator local-first deployment; multi-tenant shared-host out of scope until separately scoped
parent_bead: qmd-team-intent-kb-oaa.5
spawned_by: 035-AT-DECR §2.5 (CISO seat) + §4.1 (Build Item A gate (c))
related: 034-AT-NTRP-ecosystem-thesis.md §2.2 + §4
license: MIT
---

# Spool Boundary Threat Model

## 0. Scope

This document covers the threat surface introduced by the **ICO → INTKB spool
boundary** as shipped in Build Item A of the post-thesis Decision Record
(`000-docs/035-AT-DECR-post-thesis-build-direction-2026-05-23.md`). The
boundary is implemented by:

- ICO writer side: `intentional-cognition-os/packages/kernel/src/spool.ts`
  (CLI: `ico spool emit`). Bead `intentional-cognition-os-ziz.3` (closed).
- INTKB reader side: `qmd-team-intent-kb/apps/curator/src/intake/spool-intake.ts`
  - `qmd-team-intent-kb/packages/claude-runtime/src/spool/spool-reader.ts`.
    Bead `qmd-team-intent-kb-oaa.3` (closed).
- Spool data contract: vendored at
  `intentional-cognition-os/packages/types/src/__contract__/intkb-memory-candidate-snapshot.ts`.

**In scope:** single-operator local-first deployment; one ICO instance writing
to one INTKB instance. Operator runs both processes under their own UNIX user.
Threat actors are presumed external (network attackers, supply chain) or
incidental (operator mistake), not insider.

**Out of scope (deferred to a future threat model):** multi-tenant shared
hosts, untrusted curators, hosted SaaS deployment, federated multi-INTKB,
cross-organisation spool sharing.

## 1. Trust boundaries

| #       | Boundary                            | Crosses what                       | Trust direction                                            |
| ------- | ----------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| TB1     | Raw corpus → ICO compiler           | Operator filesystem → ICO process  | Operator trusts their own corpus                           |
| TB2     | ICO compiler (Claude) → ICO kernel  | Probabilistic ↔ deterministic      | Kernel is the trust anchor; model proposes, kernel decides |
| TB3     | ICO kernel → spool directory        | Process → filesystem               | Spool dir is durable hand-off                              |
| **TB4** | **Spool directory → INTKB curator** | **Filesystem ↔ different process** | **This document focuses here**                             |
| TB5     | INTKB inbox → curator's `promote()` | Human review → governed memory     | Curator is trusted (operator)                              |
| TB6     | Curated memory → qmd index          | INTKB store → local search index   | Index is a derived view                                    |
| TB7     | qmd index → developer queries       | Search index → consumer process    | Read-only consumer surface                                 |

Boundary **TB4** is the focus. It is the only boundary where two independently-
released processes exchange durable, content-bearing artefacts.

## 2. Assets

| Asset                          | What it is                                 | Confidentiality | Integrity   | Availability |
| ------------------------------ | ------------------------------------------ | --------------- | ----------- | ------------ |
| A1 — Compiled wiki             | ICO's L2 markdown pages                    | Medium          | High        | Low          |
| A2 — Spool JSONL files         | ICO emission output                        | Medium          | High        | Medium       |
| A3 — Spool manifest sidecars   | Per-file SHA-256 + count                   | Low             | High        | Medium       |
| A4 — INTKB candidate inbox     | Pre-curation memory candidates             | Medium          | High        | High         |
| A5 — INTKB curated memory      | Active team memory                         | Medium          | High        | High         |
| A6 — Audit trail (ICO JSONL)   | `spool.emit.start` / `.complete` events    | Low             | **Maximum** | High         |
| A7 — Governance policy ruleset | INTKB `packages/policy-engine/src/rules/*` | Low             | **Maximum** | High         |
| A8 — `tenantId` field          | Per-emission tenant scoping                | Medium          | **Maximum** | High         |

## 3. Attacker capabilities (presumed)

| Actor                        | Capability                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **External (network)**       | Can read public GitHub repos, can submit issues / PRs, **cannot** run code on the operator's machine             |
| **Supply chain**             | Can publish malicious packages to npm, including dependencies of ICO or INTKB                                    |
| **Operator mistake**         | Misconfigures `tenantId`, runs ICO against wrong corpus, leaks credentials into compiled content                 |
| **Compromised model**        | Claude is induced to produce content designed to manipulate the corpus (PoisonedRAG analog)                      |
| **Local privileged process** | Runs as same UNIX user as ICO and INTKB; **can** write to spool dir, **can** modify policy rules and audit JSONL |

Insider / compromised-curator is **out of scope** for v1 because the curator
is the operator in this deployment model.

## 4. Threats by STRIDE category

### S — Spoofing

| ID  | Threat                                                                                        | Mitigation in v1                                                            | Residual risk                                                          |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| S1  | Attacker spoofs an ICO emission by dropping a hand-crafted `spool-*.jsonl` into the spool dir | Local-only deployment; spool dir is operator-owned + filesystem permissions | Local privileged process can spoof — accepted residual risk (v1 scope) |
| S2  | Attacker spoofs the `author` field to look like ICO                                           | `author` is not authenticated; INTKB cannot tell ICO from a hand-spoof      | Defer to v2: optional Sigstore / minisign signatures on spool files    |

### T — Tampering

| ID  | Threat                                                                                                                                       | Mitigation in v1                                                                                                        | Residual risk                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| T1  | Attacker modifies an ICO-written spool file before INTKB reads it                                                                            | ICO writes manifest sidecar with SHA-256 of spool file; auditor can verify                                              | INTKB does **not** verify manifest at ingest — operator-side audit only         |
| T2  | Attacker modifies INTKB's governance ruleset                                                                                                 | `scripts/verify-policy-hash.sh` pre-commit gate + `.policy-hash` manifest                                               | Local privileged process can modify both manifest + ruleset; out of scope       |
| T3  | Attacker modifies ICO's audit JSONL                                                                                                          | SHA-256 hash chain (each event carries `prev_hash`) + `ico audit verify` (bead `ziz.4`)                                 | Tampering detectable; recovery is operator-driven                               |
| T4  | PoisonedRAG-style: attacker injects content into the source corpus to steer INTKB outputs after curation (Zou et al., 2025, USENIX Security) | INTKB's curator-stage policy pipeline runs secret detection + dedup + tenant isolation; curator review is human-in-loop | Curator must catch the attack — same residual risk as any human-review pipeline |

### R — Repudiation

| ID  | Threat                                             | Mitigation in v1                                                                                               | Residual risk                                                 |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| R1  | Operator denies emitting a candidate               | `spool.emit.start` + `spool.emit.complete` trace events in ICO's audit JSONL with file SHA-256 + candidate IDs | Audit JSONL must be preserved; not yet remote-replicated      |
| R2  | Operator denies the policy ruleset state at time T | Policy hash manifest `.policy-hash` is committed to git history; `git blame` shows the policy edit history     | Adequate for single-operator dev; multi-operator out of scope |

### I — Information disclosure

| ID  | Threat                                                           | Mitigation in v1                                                                                                                    | Residual risk                                                                                |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| I1  | Secrets leak from ICO compiled content into INTKB curated memory | INTKB's `secret-detection-rule.ts` runs at policy evaluation; ICO defaults `prePolicyFlags.potentialSecret: false` and trusts INTKB | Secret detection is regex-based; sophisticated obfuscation may bypass — accepted v1 risk     |
| I2  | `--dry-run` streams candidate content to CI logs / terminal      | ICO `ico spool emit --dry-run` prints **structure only** (id/title/byteCount/sourcePath); never content body                        | Adequate                                                                                     |
| I3  | Spool files contain content that should be tenant-isolated       | `tenantId` is REQUIRED on every candidate; no default fallback; INTKB curator enforces tenant scoping                               | Operator misconfiguration risk — mitigated by ICO refusing to emit without explicit tenantId |

### D — Denial of service

| ID  | Threat                                                          | Mitigation in v1                                                                                               | Residual risk                                                          |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| D1  | ICO emits a 100 MB+ candidate that DoSes INTKB's parser         | Hard cap at 64 KB per candidate (`SPOOL_CONTENT_MAX_BYTES`); ICO rejects (does not truncate)                   | Adequate; attackers can still emit many small candidates               |
| D2  | Attacker fills spool dir with millions of `spool-*.jsonl` files | INTKB edge-daemon has `maxCandidatesPerCycle` cap (default 100, env-configurable); excess waits for next cycle | Adequate for legitimate-volume scenarios; sustained spam not addressed |
| D3  | Adversarial filename collision exhausts inode budget            | Filesystem-level concern outside scope of this boundary                                                        | Accepted residual risk                                                 |

### E — Elevation of privilege

| ID  | Threat                                                                                    | Mitigation in v1                                                                                                                                                      | Residual risk                                                  |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| E1  | Path-traversal via `--out` lets attacker write spool files into `/etc/cron.d/` or similar | ICO CLI `validateOutDir` resolves via `realpath`, prefix-checks against workspace + `$TEAMKB_HOME`, and `lstat`s each path component for symlinks owned by other uids | Adequate; rejects all known traversal patterns                 |
| E2  | Symlink swap (TOCTOU) between path-validation and write                                   | `lstat` ownership check at validation + `.tmp + rename` atomic write means the final write is single-syscall                                                          | Window between `lstat` and `rename` is small; accepted v1 risk |
| E3  | `$TEAMKB_HOME` environment variable controlled by attacker                                | Single-operator dev box; operator controls their own env                                                                                                              | Accepted v1 scope; multi-user shared host is out of scope      |

## 5. Required controls (in force as of 2026-05-24)

| ID  | Control                                                                          | Implementation                                                         | Status                                                                         |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| C1  | tenantId REQUIRED on every emission                                              | `ico spool emit` refuses without `--tenant` or `spool.tenantId` config | **In place** (closed bead `ziz.3`)                                             |
| C2  | Content cap 64 KB                                                                | `SPOOL_CONTENT_MAX_BYTES` in `@ico/types`                              | **In place** (closed bead `ziz.3`)                                             |
| C3  | `--out` path-traversal validation                                                | `validateOutDir` in CLI                                                | **In place** (closed bead `ziz.3`)                                             |
| C4  | Dry-run prints structure only                                                    | CLI command emits id/title/byteCount, never body                       | **In place** (closed bead `ziz.3`)                                             |
| C5  | Manifest sidecar with SHA-256                                                    | `<spool>.manifest.json` co-written atomically                          | **In place** (closed bead `ziz.3`)                                             |
| C6  | Two trace events with file SHA in `.complete`                                    | `spool.emit.start` + `spool.emit.complete`                             | **In place** (closed bead `ziz.3`)                                             |
| C7  | Deterministic UUID v5 for idempotent re-emit                                     | `SPOOL_UUID_NAMESPACE` in `@ico/types`                                 | **In place** (closed bead `ziz.3`)                                             |
| C8  | Governance ruleset hash-pinning                                                  | `scripts/verify-policy-hash.sh` + `.policy-hash`                       | **In place** (closed bead `oaa.4`)                                             |
| C9  | Audit JSONL hash-chain verifier                                                  | ICO `ico audit verify` (bead `ziz.4`)                                  | **Open** — required before remote-host deployment                              |
| C10 | Pre-commit hook calls `verify-policy-hash.sh --verify`                           | Husky / lefthook config                                                | **Open** — recommend follow-up bead                                            |
| C11 | INTKB ingest verifies the manifest SHA-256 matches the spool file before parsing | Currently INTKB does not verify; operator-side check only              | **Open** — recommend follow-up bead if ICO ↔ INTKB ever sit on different hosts |

## 6. Outstanding gaps and follow-ups

The following are explicit residual risks that we are accepting in v1 and
documenting for future deciders:

1. **No cryptographic signing of spool files.** A local privileged process
   can spoof an ICO emission. Accepted because v1 deployment is single-operator
   local. If the architecture moves to remote-host or multi-org deployment,
   add Sigstore / minisign signatures on spool files (see threat S2).

2. **INTKB does not verify the manifest sidecar at ingest time.** Operator
   must run `sha256sum` against the manifest as an out-of-band check. If
   ICO and INTKB ever run on different hosts, INTKB should verify the
   manifest before accepting any candidates from a spool file (see C11).

3. **Pre-commit hook for `verify-policy-hash.sh` is not yet wired.** Adding
   it is the operational mirror of the audit-harness pre-commit pattern.
   Recommend a follow-up bead `qmd-team-intent-kb-oaa.4.1` (or extend
   `oaa.4` with a sub-task) once the contributor workflow stabilises.

4. **The CISO minority position from 035-AT-DECR §3.3** (defer the spool
   wire-up entirely until this threat model exists) was rejected in favour
   of parallel-track work. With this document in place, the §3.3 minority
   condition for retroactive correctness is satisfied. No retro-action
   triggered.

## 7. Verification plan

This threat model is reviewed when:

1. The boundary architecture changes (e.g., ICO ↔ INTKB move to different hosts).
2. A new policy rule is added or removed (re-run `verify-policy-hash.sh --init`).
3. A CVE is filed against ICO, INTKB, or any dependency listed in either
   project's `package.json` that touches the spool path.
4. INTKB's `MemoryCandidate` schema changes (per the `ziz.6` shared-package
   tripwire).

## 8. References

- `034-AT-NTRP-ecosystem-thesis.md` §2.2 (RAG attacks), §4 (spool boundary
  as load-bearing construct), §6.2 (honest gap acknowledgement)
- `035-AT-DECR-post-thesis-build-direction-2026-05-23.md` §2.5 (CISO seat),
  §3.3 (minority position), §4.1 (Build Item A hard gates)
- Zou, W., Geng, R., Wang, B., & Jia, J. (2025). PoisonedRAG. USENIX
  Security 2025. arXiv:2402.07867
- Bead chain: `intentional-cognition-os-ziz.3` (writer), `qmd-team-intent-
kb-oaa.3` (reader), `oaa.4` (hash-pin), `oaa.5` (this document), `ziz.4`
  (audit verifier)

---

_This threat model lives in qmd-team-intent-kb. Counterpart references in
the ICO repo cite this document by path._
