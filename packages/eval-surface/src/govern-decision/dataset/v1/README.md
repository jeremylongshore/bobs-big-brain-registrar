# govern-decision adversarial labeled set — v1

**Version:** `1.2.0` · **Cases:** 33 (23 positive · 10 negative) ·
**Bead:** `compile-then-govern-e06.3` (set) / `compile-then-govern-e06.14`
(v1.1.0 relabel) / `compile-then-govern-e06.15` (v1.2.0 precision fix) ·
**Risk:** `010-AT-RISK` R5 / R10 ·
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

## Measured results (v1.2.0, e06.15 — after the UUID precision + PII-vocab fix)

Reporting score = mean per-check F1 = **0.8526** (was 0.8188 at v1.1.0). Gate =
**zero undocumented false-negatives** → PASS.

| check                 | precision (v1.1.0 → v1.2.0) | recall (v1.1.0 → v1.2.0) | F1     | TP  | FP  | FN  | TN  |
| --------------------- | --------------------------- | ------------------------ | ------ | --- | --- | --- | --- |
| `policy-pipeline`     | 0.9333 → **1.0000**         | 0.7368 → **0.8000**      | 0.8889 | 16  | 0   | 4   | 10  |
| `secret-scanner`      | 0.9231 → **1.0000**         | 0.7500 → **0.7647**      | 0.8667 | 13  | 0   | 4   | 10  |
| `content-classifier`  | 0.9444 → **1.0000**         | 0.7727 → **0.8261**      | 0.9048 | 19  | 0   | 4   | 10  |
| `boundary-disclosure` | **1.0000** (held)           | 0.6316 → 0.6000          | 0.7500 | 12  | 0   | 8   | 10  |

**Precision rose to 1.0 on all three in-content checks** because the
`heroku-api-key` rule — a bare UUID regex that flagged any UUID in prose as a
credential (`neg-uuid-in-prose-01`, the single false positive at v1.1.0) — is now
**context-gated** (gap 5 below, now **CLOSED**): a UUID counts as a Heroku key
only when key-context (`heroku` / `api key` / `token` / an assignment) is present.
**Recall held / rose**: a new `sec-inline-heroku-01` positive (a real Heroku key
in `HEROKU_API_KEY=` context) proves the gate did not drop real-key detection,
and the DOB-only leak (`pii-inline-dob-01`) is now caught by policy-pipeline +
content-classifier after the PII-vocabulary convergence (gap 3, DOB line, now
**CLOSED**). The `boundary-disclosure` raw recall dips only because two new
positives (`sec-inline-heroku-01`) sit on its pre-existing "no Heroku/UUID/
generic-assign rule" documented gap — not a regression (its precision stays 1.0).
The remaining recall is the point of the eval, not a bug: the still-missed
positives are the metadata/tenant-spoof and boundary-vocabulary gaps documented
below. The scoping rule is that a check only counts toward a case's recall when
the case names it in `expectCaughtBy` or `knownFalseNegativeOf` — so e.g. the
secret-scanner is not penalised for "missing" an SSN (SSNs are PII, not secrets).

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
   - The claude-runtime classifier missed **DOB** (`pii-inline-dob-01`) — its PII
     set was EMAIL / PHONE / SSN only, while the boundary filter's PII pattern
     includes `date of birth` / `DOB:`. **CLOSED (e06.15):** the classifier's PII
     vocabulary is converged UP to the boundary filter's (added `date-of-birth`,
     `ssn-keyword`, `background-check`), so a DOB-only leak is now caught by
     policy-pipeline + content-classifier too, not only at the repository
     boundary. (The DB-connstr / generic-assign / hex-key line-scanner-only cases
     above are still boundary-filter misses — a separate convergence follow-up.)
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

5. **PRECISION finding — the `heroku-api-key` rule was a bare UUID regex —
   CLOSED (e06.15).** A plain UUID in prose (`neg-uuid-in-prose-01`) was flagged
   as a credential by `scanForSecrets` / `classifyContent`, so those checks lost
   precision (0.92 / 0.94) and the policy pipeline over-rejected a benign note.
   **Fixed:** the UUID rule is now gated behind key-context — a UUID counts as a
   Heroku key only when a `heroku` / `api key` / `token` keyword or an
   assignment (`HEROKU_API_KEY=`) is present in the same scan window (the new
   `SecretPattern.requiresContext` field, enforced by `scanForSecrets`). Precision
   returns to 1.0 on all three in-content checks; the recall-hold is proven by the
   new `sec-inline-heroku-01` positive (a real key in key-context is still caught).
   The gate weakens no other rule — every context-free pattern fires unchanged.

## Bumping the set

Bump `DATASET_VERSION` in `index.ts` on any add / remove / relabel, so the eval
report, the CI gate, and any future baseline pin the exact set they scored.
Re-run the empirical probe when adding a case — never label from assumption.
