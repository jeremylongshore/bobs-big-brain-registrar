# Staleness rule evidence and scope

Source contract for `compile-then-govern-39z.2.2`. This is dry-run triage in
`apps/curator/src/staleness/`; it has no production caller, network probe, database
write, lifecycle transition or package-index export.

## Evidence is distinct from a proposed remedy

Each built-in rule declares its estate scope, historical effective date, evidence
basis, pinned source revision and SHA-256, source selector and visibility. All
records are explicitly unsigned and their currentness is not revalidated by the
detector. A hash identifies bytes; it does not authenticate a decision, establish
its meaning or prove that a service is absent today. Custom rules can explicitly
supply `authority: null`; they cannot produce retirement candidates without
complete pinned source references.

| Rule                                | Historical declaration                                                 | Evidence availability                                                                | Proposed remedy                                           |
| ----------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| GCP                                 | Estate teardown effective 2026-07-09, described by a 2026-07-10 record | Private Intent OS decision reference and byte hash; no private contents published    | Review an affirmative instruction for this estate         |
| Compiler and Registrar repositories | Remote renames on 2026-07-19                                           | Public umbrella topology, pinned below                                               | Review repository metadata/links                          |
| Plugin repository                   | Remote rename 2026-07-13; local-directory rename 2026-07-14            | Public umbrella topology; historical rule ID retains July 14                         | Review repository metadata/paths                          |
| Marketplace                         | Retirement and archival declared 2026-07-17                            | Public topology description of a private repository, not a signed retirement receipt | Review marketplace instructions                           |
| ntfy                                | Estate service removal declared 2026-06-13                             | Private decision D23 reference and byte hash; no private contents published          | Review an affirmative instruction for that estate service |

The public source is [umbrella topology section 2 at f3ad985](https://github.com/intent-solutions-io/bobs-big-brain-umbrella/blob/f3ad9856d3f150360e6f437a2c724f7ee5b70d37/000-docs/007-AT-SMAP-repo-topology-and-working-surface.md).
Private sources require independent authorized access to the referenced revision.
These source records supply historical context, not a verified-authority gate.
No signed teardown or owner approval receipt is manufactured by this contract.

## Current observations have narrower meaning

At 2026-10-27T03:09:14Z, read-only HTTP observations returned 301 for each of these
old GitHub repository URLs, with the listed canonical destination. Authenticated
GitHub repository metadata independently resolved the same canonical names.

| Old path under `github.com/jeremylongshore/` | Redirect destination under the same owner |
| -------------------------------------------- | ----------------------------------------- |
| `intentional-cognition-os`                   | `bobs-big-brain-compiler`                 |
| `qmd-team-intent-kb`                         | `bobs-big-brain-registrar`                |
| `governed-second-brain-plugin`               | `bobs-big-brain-plugin`                   |

This is a point-in-time observation, not a promise about future redirects. It
contradicts treating an old name as proof of URL failure or memory-wide
obsolescence. Every rename match remains `manual-review` with remedy
`metadata-review`, including historical references and provenance-only matches.
The detector itself never performs HTTP requests.

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

The result exposes the proposed remedy, historical rule evidence and the accepted
scope evidence locator separately. Both dispositions remain proposals. An
assessment and pinned historical record still cannot bypass prose triage:
narratives, quotations, code, uncertain or mixed advice remain manual review;
clear teardown records retain their exemption. An empty result is not a health
verdict. The syntax heuristic is not a general language/Markdown parser or a
measured corpus-accuracy claim.

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
