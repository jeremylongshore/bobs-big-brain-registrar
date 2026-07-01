# govern-decision adversarial labeled set — v1

**Version:** `1.1.0` · **Cases:** 32 (22 positive · 10 negative) ·
**Bead:** `compile-then-govern-e06.3` (set) / `compile-then-govern-e06.14`
(v1.1.0 relabel) · **Risk:** `010-AT-RISK` R5 / R10 ·
**Umbrella:** `intent-solutions-io/governed-second-brain#27`

This is the versioned, labeled adversarial set that measures the **efficacy** of
the Governed Second Brain's deterministic govern decision — not merely its
determinism. The 8 policy rules are verified-_deterministic_ (same input →
same verdict), but a line-based regex secret-scan is perfectly deterministic
**and** misses a key split across two lines or a base64-wrapped token. This set
plus the `evaluateGovernDecision` evaluator (`../../../govern-decision.ts`) turn
that unmeasured moat into **per-check precision / recall** numbers, with a
false-negative list that is surfaced, never hidden.

> The CISO's top fear: a leaked key promoted with a clean receipt. This set
> exists to prove — or disprove — that we catch it.

## What each case is

Every entry in `index.ts` (`GOVERN_CASES`) is a `GovernCase`:

| field                  | meaning                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | stable, unique, human-readable (e.g. `sec-split-openai-01`)                                                                                                     |
| `sensitiveClass`       | `secret` · `pii` · `internal-path` · `none` (negative)                                                                                                          |
| `surface`              | the smuggling technique: `inline`, `split-multiline`, `base64-encoded`, `hex-encoded`, `metadata-filepath`, `metadata-projectcontext`, `tenant-spoof`, `benign` |
| `candidate`            | a partial `MemoryCandidate` (merged over a benign default, Zod-parsed)                                                                                          |
| `expectCaughtBy`       | the checks a **healthy** moat fires on this positive                                                                                                            |
| `knownFalseNegativeOf` | checks **empirically confirmed** to miss it today (documented gaps)                                                                                             |

The four scored **checks** are the independent detection surfaces of the govern
decision:

- **`policy-pipeline`** — the full `PolicyPipeline.evaluate` verdict (rejected?),
  using the security subset of the 8 rules (`secret_detection` +
  `sensitivity_gate`, both `reject`).
- **`secret-scanner`** — `scanForSecrets` (claude-runtime), the signal behind
  the `secret_detection` rule.
- **`content-classifier`** — `classifyContent` (claude-runtime), the signal
  behind the `sensitivity_gate` rule.
- **`boundary-disclosure`** — `scanForDisclosure` over the derived free-text
  surface the repository choke point walks (content + title + tags + **all
  metadata free-text incl. `filePaths` / `projectContext`** + `tenantId` +
  `author`). This is the surface the R10 intake fix makes the API early-check
  consistent with.

## How the labels were set (honesty guarantee)

Every `expectCaughtBy` / `knownFalseNegativeOf` was set from an **empirical
probe** of the real scanners on the exact case material — not from assumption.
The evaluator re-derives those outcomes at run time and **fails closed** if a
label drifts (an undocumented false-negative). So the dataset and the code
cannot silently disagree: a relabel that hides a real miss is caught by the CI
gate, and a code regression that breaks a real catch is caught the same way.

## Measured results (v1.1.0, e06.14 — after the split/base64 fix)

Reporting score = mean per-check F1 = **0.8188** (was 0.7333 at v1.0.0). Gate =
**zero undocumented false-negatives** → PASS.

| check                 | precision  | recall (v1.0.0 → v1.1.0) | F1     | TP  | FP  | FN  | TN  |
| --------------------- | ---------- | ------------------------ | ------ | --- | --- | --- | --- |
| `policy-pipeline`     | 0.9333     | 0.5789 → **0.7368**      | 0.8235 | 14  | 1   | 5   | 9   |
| `secret-scanner`      | 0.9231     | 0.5625 → **0.7500**      | 0.8276 | 12  | 1   | 4   | 9   |
| `content-classifier`  | 0.9444     | 0.6364 → **0.7727**      | 0.8500 | 17  | 1   | 5   | 9   |
| `boundary-disclosure` | **1.0000** | 0.6316 (unchanged)       | 0.7742 | 12  | 0   | 7   | 10  |

The **secret-scanner recall rose 0.56 → 0.75** because the two evasions that
defeated the line-by-line scan — a key split across a newline, and a
base64/hex-wrapped token — are now closed by a newline-collapsed pre-pass and a
bounded decode-and-rescan in `scanForSecrets` (see gaps 1 & 2 below, now
**CLOSED**). The cascade lifts the policy-pipeline and content-classifier too
(both consume `scanForSecrets` / `classifyContent`). Precision held (no new
false positives — a benign base64 data-URI image is NOT flagged, guarded by a
printable-decode check). The remaining ~0.63–0.77 recall is the point of the
eval, not a bug: the still-missed positives are the metadata/tenant-spoof and
boundary-vocabulary gaps documented below. The scoping rule is that a check only
counts toward a case's recall when the case names it in `expectCaughtBy` or
`knownFalseNegativeOf` — so e.g. the secret-scanner is not penalised for
"missing" an SSN (SSNs are PII, not secrets).

## Documented gaps this set proves (real findings — follow-up bead candidates)

These are the honest output of the eval. They are **documented**, so they do not
fail CI, but each is a genuine hole in the moat worth a follow-up bead. **None
was fixed by weakening a rule.**

1. **Split-across-newline keys — CLOSED for the in-content checks (e06.14).**
   `scanForSecrets` previously split on `\n` and matched each line, so a key
   broken across two lines (`sec-split-openai-01`, `sec-split-aws-01`) was
   invisible. _This was the CISO's exact fear._ **Fixed:** a newline-collapsed
   pre-pass (single-space + no-whitespace views) now rejoins the split key, so
   the secret-scanner / classifier / policy-pipeline catch both cases. The
   `common` boundary filter has no collapse pass and STILL misses `sec-split-aws-01`
   — that convergence is a separate follow-up (gap 3).

2. **Base64/hex-wrapped tokens — CLOSED for the in-content checks (e06.14).** No
   detector decoded base64 before matching (`sec-b64-openai-01`,
   `sec-b64-github-01`). **Fixed:** a bounded base64/hex decode-and-rescan pass
   (capped candidate count + total decoded bytes, printable-decode gate to avoid
   flagging benign binary blobs like a data-URI image) now decodes encoded
   substrings and re-runs the secret patterns, reporting a hit as
   `base64-wrapped:<id>` / `hex-wrapped:<id>`. The boundary filter has no decode
   pass and STILL misses these — a separate follow-up (gap 3).

3. **The line-scanner and the boundary filter have DIVERGENT rule sets.**
   - Boundary filter misses: DB connection strings (`sec-inline-connstr-01`),
     generic `KEY=value` env assignments (`sec-inline-envassign-01`), and
     hex-encoded keys (`sec-hex-aws-01`) — all caught by the line scanner.
   - The claude-runtime classifier misses **DOB** (`pii-inline-dob-01`): its PII
     set is EMAIL / PHONE / SSN only, while the boundary filter's PII pattern
     includes `date of birth` / `DOB:`. So a DOB-only leak passes the policy
     pipeline but is caught at the repository boundary.
   - The boundary filter misses **email** (`pii-inline-email-01`) by design
     (email is often legitimate); the classifier flags it.
     Fix candidate: converge the two vocabularies (or document the split as
     intentional per field).

4. **Odd-field leaks (`metadata.filePaths` / `projectContext`) and
   `tenantId` spoofing are invisible to the content-only checks.** The policy
   pipeline scans `candidate.content` only, so a secret/PII in `filePaths`
   (`pii-filepath-ssn-01`, `sec-filepath-aws-01`), `projectContext`
   (`pii-projectcontext-ssn-01`), or a spoofed `tenantId`
   (`spoof-tenant-secret-01`) is caught **only** by the boundary filter. The
   **R10 fix** in this PR extends the API intake early-check to that surface so
   it is caught at the boundary too (not just the deeper repository backstop).

5. **PRECISION finding — the `heroku-api-key` rule is a bare UUID regex.** A
   plain UUID in prose (`neg-uuid-in-prose-01`) is flagged as a credential by
   `scanForSecrets` / `classifyContent`, so those checks lose precision
   (0.90 / 0.93) and the policy pipeline over-rejects a benign note. The
   boundary filter (no UUID rule) stays at precision 1.0. Fix candidate: gate
   the UUID rule behind a key-context keyword, or drop it.

## Bumping the set

Bump `DATASET_VERSION` in `index.ts` on any add / remove / relabel, so the eval
report, the CI gate, and any future baseline pin the exact set they scored.
Re-run the empirical probe when adding a case — never label from assumption.
