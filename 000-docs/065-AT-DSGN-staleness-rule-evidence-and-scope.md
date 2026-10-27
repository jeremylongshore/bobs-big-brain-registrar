# Staleness rule evidence and scope

Source contract for `compile-then-govern-39z.2.2`. This is dry-run triage in
`apps/curator/src/staleness/`; it adds no network probe, database write,
lifecycle transition or package-index export. The repository call-site observation and default-call migration are
documented below; external consumers have not been audited.

## Evidence is distinct from a proposed remedy

Each built-in rule declares its estate scope, historical effective date, evidence
basis, pinned source revision and SHA-256, source selector and visibility. All
records are explicitly unsigned and their currentness is not revalidated by the
detector. A hash identifies bytes; it does not authenticate a decision, establish
its meaning or prove that a service is absent today. Custom rules can explicitly
supply `authority: null`; they cannot produce retirement candidates without
syntactically well-formed pinned references. This gate checks shape only; it
does not establish byte correspondence or authenticity.

The executable definitions in [staleness-rules.ts](../apps/curator/src/staleness/staleness-rules.ts)
are the sole rule inventory. This document does not maintain a second rule table.
For the plugin rule, structured `authority.effectiveDate` means the remote rename
date (2026-07-13); the local-directory date (2026-07-14) is carried only in the
`because` prose and retained historical rule ID, not a second structured field.

The public source is [umbrella topology section 2 at f3ad985](https://github.com/intent-solutions-io/bobs-big-brain-umbrella/blob/f3ad9856d3f150360e6f437a2c724f7ee5b70d37/000-docs/007-AT-SMAP-repo-topology-and-working-surface.md).
Private sources require independent authorized access to the referenced revision.
Private decision documents are not reproduced or excerpted. The public rule
contract does disclose their source identifiers, dates and byte hashes, plus the
narrow historical estate conclusions already represented by the earlier rules.
No broader private strategy or decision text is included.

The author computed the source hashes at authoring time. The detector checks
reference shape only; neither it nor another in-repository check recomputes hashes
against those source bytes. Public source bytes can be independently checked;
private bytes require authorized access. These source records supply historical
context, not a verified-authority gate.
No signed teardown or owner approval receipt is manufactured by this contract.

## Current observations have narrower meaning

The author-recorded [observation artifact](065-staleness-rename-observations.json)
contains `observed_at`, old URLs, HTTP status values, Location destinations and
API-derived `full_name` values. It records results rather than how requests were
made: no collection script, request transcript, credential-use attestation or
CI-executed probe is supplied. Those fields are author observations, not signed
evidence or proof of the collection method. Consult the artifact for the three
recorded old/canonical URL pairs rather than a duplicated table here.

This is a point-in-time observation, not a promise about future redirects. It
contradicts treating an old name as proof of URL failure or memory-wide
obsolescence. Every rename match remains `manual-review` with remedy
`metadata-review`, including historical references and provenance-only matches.
The detector itself never performs HTTP requests. A rename alone does not prove
content obsolescence even if an old URL later stops redirecting.

The historical GCP decision does not prove a current zero-project billing count
or invalidate an external GCP tutorial. The historical ntfy decision does not
establish today's notification replacement. Neither rule recommends Slack-only
routing or declares third-party ntfy deployments invalid.

## Applicability is assessed per memory and rule

The optional third `detectStaleness` argument accepts current-invocation scope
assessments. Each carries a `memoryId`, `ruleId`, scope and nonblank `evidenceRef`.
Only one matching assessment of `intent-solutions-estate` scope permits the
existing prose heuristic to consider a retirement candidate. Missing, blank,
external, unresolved, duplicate or conflicting assessments leave prescriptions
in manual review. An assessment for one rule cannot authorize another rule's
classification.

Scope is never inferred from tags, file paths, import/reference labels, repository
identity or token presence. An imported note may genuinely describe this estate;
an external tutorial may mention the same tools. Explicit assessment distinguishes
them. The caller must assess the actual inspected prose and provenance anew after
any edit. These are invocation-local assertions, not saved approvals, verified
provenance or proof of current authority. The detector does not fetch the evidence
locator or authenticate its author.

The result exposes the proposed remedy, structured authority record and accepted
scope evidence locator as separate fields. The historical declaration remains
prose within `evidence`, alongside the disposition and limitations. Both dispositions remain proposals. An
assessment and pinned historical record still cannot bypass prose triage:
narratives, quotations, code, uncertain or mixed advice remain manual review;
clear teardown records retain their exemption. An empty result is not a health
verdict. The syntax heuristic is not a general language/Markdown parser or a
measured corpus-accuracy claim.

## Repository call sites and migration

At source revision `56a76cd6fc6c9f1a08657da64a92e7ff8b0fdb87`, the following
repository search returned only the detector module and its unit test:

```sh
git grep -l -E 'detectStaleness|staleness-detector' 56a76cd6fc6c9f1a08657da64a92e7ff8b0fdb87 -- apps packages scripts
```

That observation supports no production wiring found in these repository paths;
it does not establish absence of callers in other repositories or external tools.

This changes default-call semantics: without scope assessments, all non-exempt
built-in matches now return manual review. Renames remain metadata review even
with an estate assessment. A caller seeking platform candidate proposals must
supply the new third argument; the returned shape now includes `remedy`,
`authority` and `scopeEvidenceRef`. Custom rules must declare a remedy and either
supply authority references or explicitly use `authority: null`. None of these
changes creates an apply permission.

The owning [package manifest](../apps/curator/package.json) marks Curator
`private: true` and exports only its package-root index; the [index](../apps/curator/src/index.ts)
does not export this staleness module. These are internal source-interface
changes, recorded under Changed in the changelog. Uncontrolled filesystem/deep
imports outside this repository have not been audited. No package publication,
version bump or future release-classification decision is made here.

## Verification and remaining parent acceptance

The focused fixtures cover scoped affirmative instructions, identical unscoped
external material, wrong and conflicting bindings, missing or incomplete rule
references, redirect-compatible rename handling and date distinctions. Existing
history/quotation/uncertainty cases run with explicit estate fixture assessments
so those safeguards cannot pass merely because scope is absent. Deterministic
outputs and input nonmutation remain tested.

Parent `compile-then-govern-39z.2` remains open: an eventual apply path must verify
applicable, current decision authority and memory revision, govern and receipt
reversible transitions, and demonstrate FAMA improvement with Recall nonregression
on the appropriate corpus. This source contract supplies none of that live
acceptance and grants no deployment or corpus-operation authority.
