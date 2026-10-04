# Human-Escalation Hold Runbook

**Document:** 055-OD-RNBK-human-escalation-hold
**Date:** 2026-10-04
**Status:** Active
**Scope:** the bounded human-escalation hold for ambiguous audience and secret decisions: the
`curator-cli holds` subcommands, `GET /api/holds`, `POST /api/holds/:candidateId/recommend` and
`POST /api/holds/:candidateId/resolve` (Epic K bead K6).
**Decision record:** [`053-AT-DECR`](053-AT-DECR-claim-level-audience-governance-k1.md). The
recommend / pipeline-owns split it reuses is umbrella `014-AT-DECR` (agent-reviewed capture inbox).

---

## 1. What a hold is for

Some audience and secret questions the deterministic pipeline can detect and cannot decide. The
content classifies as PII or credentials, or a member declares an audience members cannot read. A
rule that only flags cannot say whether the claim belongs in durable memory, or for whom.

Before K6 such a candidate was left in the inbox with no exit: the promote endpoint answered 422
"flagged for manual review" every time, and nothing offered the review. A hold is that exit, and
it is bounded. The candidate is neither promoted tenant-wide nor dropped. It waits for a person,
for a fixed time, and if nobody decides it is closed without being promoted.

## 2. Who changes state

| Step              | Who                                          | What is written                                           |
| ----------------- | -------------------------------------------- | --------------------------------------------------------- |
| Enter the hold    | a deterministic rule outcome                 | status `quarantined` + a `held` receipt                   |
| Recommend         | anyone with an admin token, a model included | a `hold_recommended` receipt, and nothing else            |
| Release (promote) | a person with admin or owner standing        | the memory + `promoted` receipt + `hold_resolved` receipt |
| Reject            | a person with admin or owner standing        | status `rejected` + a `hold_resolved` receipt             |
| Expire            | the clock                                    | status `rejected` + a `hold_resolved` receipt (`expired`) |

A model may recommend. Nothing a model emits changes a candidate's status, its audience or durable
memory. This is the same split `014-AT-DECR` set for the capture inbox, applied to the one question
that split left open: a person, not the pipeline, has to choose the audience.

Every state change and its hash-chained receipt commit in one transaction.

## 3. State model (no new status, no migration)

A candidate is on hold when both are true:

1. its status is `quarantined`, the existing "awaiting a human" status the capture inbox uses; and
2. the audit chain carries a `held` receipt for it and no `hold_resolved` receipt.

The `held` receipt is what bounds the hold. It records the triggers, the declared and recommended
audience, the pattern ids that fired (never the matched text) and `expiresAt`. Its actor is the
hold gate, because the rule outcome places the hold. When an approval request ran into the hold
(`POST /api/candidates/:id/promote`), `details.triggeredBy` names that caller. A member-quarantined
candidate with no `held` receipt is not a K6 hold and has no expiry; that queue is unchanged.

The three new `AuditAction` values (`held`, `hold_recommended`, `hold_resolved`) live in the
`audit_events.action` column, which has no CHECK constraint. Nothing in the store schema changed.

## 4. What triggers a hold

`evaluateHoldTriggers` (`packages/policy-engine/src/hold/hold-triggers.ts`) is pure and takes no
model output. A hard reject is never softened into a hold.

| Trigger                             | Fires when                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `audience_narrowing_flag`           | the `audience_narrowing` rule flags: declared audience wider than the content calls for     |
| `sensitivity_gate_flag`             | the `sensitivity_gate` rule fires under a non-reject action (credentials or PII classified) |
| `secret_scan_flag`                  | a `secret_detection` rule fires under a non-reject action                                   |
| `audience_above_proposer_clearance` | a `member` proposal declares `admins` or `owner`                                            |

The first three depend on the tenant's policy. The last is structural and fires with no policy.

The intake stamp records `admin` or `member`, not owner standing, so an `admin` proposal declaring
`owner` is not held: the stamp cannot show the proposer is not the owner.

A flag from any other rule (`contradiction_check`, `content_sanitization`, `relevance_score`,
`source_trust`) is not a hold trigger. Such a candidate is left in the inbox exactly as before.

## 5. Bounds

| Bound                    | Default | Setting                  |
| ------------------------ | ------- | ------------------------ |
| Days a hold stays open   | 14      | `TEAMKB_HOLD_TTL_DAYS`   |
| Open holds per tenant    | 100     | `TEAMKB_HOLD_MAX_ACTIVE` |
| Recommendations per hold | 10      | fixed                    |

**Expiry resolves to the safe default.** Past `expiresAt` a hold can only be closed unpromoted:
the candidate is stamped `rejected` (the row and its content are kept) and a `hold_resolved`
receipt records `resolution: expired`. A release attempted after the bound is refused and closes
the hold the same way, so the safe default does not depend on a timer having run. A candidate is
held at most once: a resolved or expired hold is never reopened.

**Past the cap the gate fails closed.** A candidate that would be held is left in the inbox,
unpromoted, and the run reports it (`holdCapBlocked` in the batch result, `hold_cap_reached` from
the API). Resolve open holds and the next run holds it.

Within one curator run the cap is read once after it is first reached. A slot that a person
frees while that run is still going is picked up by the next run, not the current one. This errs
toward not holding, never toward promoting.

An unset or unparseable environment value falls back to the default; it never widens a bound. A
cap of `0` holds nothing and promotes nothing that would have been held.

## 6. CLI

```bash
# What is waiting (read-only)
curator-cli holds list --db ~/.teamkb/teamkb.db --tenant intent-solutions
curator-cli holds list --db ~/.teamkb/teamkb.db --tenant intent-solutions --json

# Preview a release: opens the store READ-ONLY and runs the whole gate
curator-cli holds resolve --db ~/.teamkb/teamkb.db --tenant intent-solutions \
  --candidate-id <uuid> --resolution release --audience admins \
  --actor jeremy --reason "customer contact, admins only" --dry-run

# Release for real
curator-cli holds resolve --db ~/.teamkb/teamkb.db --tenant intent-solutions \
  --candidate-id <uuid> --resolution release --audience admins \
  --actor jeremy --reason "customer contact, admins only"

# Reject
curator-cli holds resolve --db ~/.teamkb/teamkb.db --tenant intent-solutions \
  --candidate-id <uuid> --resolution reject --actor jeremy --reason "not worth keeping"

# Close everything past its expiry (never promotes)
curator-cli holds expire --db ~/.teamkb/teamkb.db --tenant intent-solutions --dry-run
curator-cli holds expire --db ~/.teamkb/teamkb.db --tenant intent-solutions
```

`--role <admin|owner>` sets the resolver's standing and defaults to `owner`: the operator at the
store file has owner standing, as loopback dev mode does. `--role member` is refused.

Exit codes: `0` done, `3` the resolution was refused, `2` usage error, `1` I/O failure.

After a release, run the exporter in reconcile mode and reindex so the new memory is searchable. A
memory released to `admins` or `owner` stays out of the shared export tree (K2).

## 7. API

All three routes are admin-only. A member token gets 403.

| Route                                    | Purpose                                                      |
| ---------------------------------------- | ------------------------------------------------------------ |
| `GET /api/holds?tenantId=`               | list open holds                                              |
| `POST /api/holds/:candidateId/recommend` | attach a recommendation: `{ verdict, audience?, reasoning }` |
| `POST /api/holds/:candidateId/resolve`   | `{ resolution, audience?, reason, acknowledgeWider? }`       |

`resolve` takes a person. It answers 403 `human_required` to a token whose record carries
`"agent": true` in `tokens.json`, to the `teamkb-review-agent` actor, and to a body that declares
`actorType` `ai` or `system`. Mark every automation's token with `"agent": true`.

A hold that declares an audience above the caller's standing is left out of the listing (counted
in `hiddenAboveStanding`) and answers 404 to `recommend` and `resolve`.

`POST /api/candidates/:id/promote` on a candidate with a hold trigger now puts it on hold and
answers 422 `held_for_review`. `POST /api/candidates/:id/reject` on a held candidate answers 422
`on_hold`. Neither path can release or retire a held candidate, whoever calls it.

## 8. What a release does

A release is not a bypass. The released candidate goes back through the whole deterministic gate:
the disclosure floor, exact-hash dedup, the redaction check, origin attestation, import exclusion
and the tenant's policy.

- The person chooses the audience. The memory is promoted with it; the candidate row keeps what
  was proposed, and the `hold_resolved` receipt records both.
- The release resolves the flags the hold covers (`audience_narrowing`, `sensitivity_gate`,
  `secret_detection` under a flag action) and no others. A flag from any other rule refuses the
  release with `still_flagged`, and the hold stays open.
- A hard reject, a duplicate, redacted content, or content the disclosure floor refuses, refuses
  the release with `gate_refused`. Nothing is promoted and the hold stays open.
- An audience **wider** than the recommended tier is refused (`wider_than_recommended`) unless the
  request acknowledges it: `--acknowledge-wider`, or `"acknowledgeWider": true`. The receipt then
  records `overridesRecommendation: true`.
- The `promoted` receipt says "flags resolved by a human releasing a hold" and lists them. It does
  not say the candidate passed every rule.

## 9. Reading the receipts

```sql
-- Open holds
SELECT h.memory_id, json_extract(h.details_json, '$.expiresAt') AS expires_at,
       json_extract(h.details_json, '$.triggers') AS triggers
FROM audit_events h
WHERE h.action = 'held'
  AND NOT EXISTS (SELECT 1 FROM audit_events r
                  WHERE r.memory_id = h.memory_id AND r.action = 'hold_resolved');

-- How holds ended
SELECT json_extract(details_json, '$.resolution') AS resolution, COUNT(*)
FROM audit_events WHERE action = 'hold_resolved' GROUP BY 1;
```

`memory_id` on all three hold receipts is the candidate's id. `curator-cli verify-audit-chain`
covers them like any other receipt.

## 10. Measured escalation rate

Measured through the recommended policy, on its own, and not blended into any precision or recall
figure. Both are pinned in tests, so a change shows up as a diff.

| Fixture                                      | Cases | Held | Rate  | Rejected | Other flag | Approved |
| -------------------------------------------- | ----- | ---- | ----- | -------- | ---------- | -------- |
| K3 hand-labeled audience fixture             | 29    | 9    | 0.310 | 11       | 1          | 8        |
| govern-decision adversarial set (dataset v1) | 33    | 3    | 0.091 | 14       | 4          | 12       |

The K3 fixture is built to exercise the audience rule, so its rate is an upper bound, not a
forecast of real capture traffic. Three of its nine held cases (SSN, date of birth, background
check) are refused by the store's disclosure choke point at insert, so six can reach a hold in
practice. All nine carry `sensitivity_gate_flag`; six also carry `audience_narrowing_flag`.

Reproduce:

```bash
pnpm vitest run packages/policy-engine/src/__tests__/hold-triggers.test.ts
pnpm vitest run packages/eval-surface/src/__tests__/hold-escalation.test.ts
```

## 11. Limits

- **Owner standing is not stamped at intake.** An `admin` proposal declaring `owner` is not held.
- **A release cannot clear other flags.** A held candidate that also carries, say, a
  `content_sanitization` flag can be rejected or left to expire; it cannot be released.
- **Agent detection is by token.** An automation running under a person's unflagged admin token is
  indistinguishable from that person. Flag automation tokens with `"agent": true`.
- **Expiry needs a caller.** Holds are closed by `curator-cli holds expire`, by the plugin's govern
  sweep, or by the next resolve attempt. An overdue hold that nothing touches stays listed as
  `expired`; it cannot be released in the meantime.
- **`merge-govern` is unchanged.** The merge gate quarantines flagged rows as before and does not
  place holds.
- **Rollback.** Reverting this change leaves held candidates as ordinary `quarantined` rows. Code
  older than this change cannot parse the three new audit actions, so revert before any hold is
  placed, or keep the enum members when reverting.
