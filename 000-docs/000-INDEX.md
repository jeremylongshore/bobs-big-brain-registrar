# 000-docs Index — qmd-team-intent-kb

## Documents by Category

### PP — Product & Planning

- `000-PP-PLAN-mega-blueprint.md` — Canonical project blueprint (pre-implementation)
- `004-PP-RMAP-phase-plan.md` — Phased implementation roadmap (Phase 0–9)
- `024-PP-CLOS-v1-scope-closeout.md` — v1 scope closeout and deferred items

### AT — Architecture & Technical

- `001-AT-ARCH-repo-blueprint.md` — Repository structure and tech stack
- `002-AT-ARCH-architecture-overview.md` — System architecture and component design
- `003-AT-DSGN-system-thesis.md` — Problem statement and design rationale
- `007-AT-DSGN-data-model-draft.md` — Domain model draft (Zod schemas planned)
- `026-AT-DSGN-repo-resolver-design.md` — repo-resolver package design (RepoContext, tenant derivation, caching)
- `034-AT-NTRP-ecosystem-thesis.md` — "Compile, Then Govern" thesis paper (byte-identical cross-repo copy)
- `035-AT-DECR-post-thesis-build-direction-2026-05-23.md` — Post-thesis build direction executive council decision record
- `036-AT-THRT-spool-boundary-threat-model.md` — Spool boundary threat model
- `037-AT-DSGN-qmd-adapter-source-index-separation.md` — qmd-adapter source/index separation ADR
- `038-AT-DECR-retrieval-backend-decision-2026-06-18.md` — Retrieval backend decision (thinker-canon council)

### TQ — Testing & Quality

- `005-TQ-TEST-testing-ci-strategy.md` — Testing philosophy, CI pipeline, quality gates
- `006-TQ-SECU-security-governance.md` — Threat model and security controls

### OD — Operations & Deployment

- `008-OD-RELS-release-versioning-policy.md` — Semantic versioning and changelog policy
- `020-OD-RELS-v1-release-checklist.md` — v1 release checklist and gates
- `028-OD-SECU-release-signing.md` — Release supply-chain signing (cosign + SLSA provenance)
- `029-OD-RELS-npm-publishing-strategy.md` — Which packages are publishable to npm and how

### DR — Documentation & Reference

- `009-DR-GUID-contribution-workflow.md` — Step-by-step contributor guide
- `030-DR-GUID-import-conversion-recipes.md` — How to import from Obsidian, Notion, Google Docs, Confluence, etc.

### WA — Workflows & Automation

- `010-WA-WFLW-internal-claude-operations.md` — /doc-filing, /beads, /release, AAR workflows

### PM — Project Management

- `011-PM-RISK-risk-register.md` — Active risk tracking (12 risks)

### OD — Operations & Deployment (continued)

- `016-OD-OPSM-branch-protection-checklist.md` — GitHub branch protection configuration checklist
- `027-OD-OPSM-edge-daemon-runbook.md` — edge-daemon operations runbook (install, config, health check, recovery, upgrade, rollback)
- `040-OD-OPSM-brain-api-tailnet-deploy.md` — brain API tailnet deploy runbook (systemd --user service, token management, team-mode client, verify, hardening gaps)

### AA — After Action & Review

- `012-AA-AACR-initial-aar.md` — Phase 0 after action review
- `013-AA-AACR-phase1-schema.md` — Phase 1 core schema after action review
- `014-AA-AACR-phase2-runtime.md` — Phase 2 claude runtime after action review
- `015-AA-AACR-phase3-adapter.md` — Phase 3 qmd adapter after action review
- `017-AA-AACR-phase4-api.md` — Phase 4 policy engine, store, and API after action review
- `018-AA-AACR-phase5-curator.md` — Phase 5 curator engine after action review
- `019-AA-AACR-phase6-exporter.md` — Phase 6 git exporter after action review
- `021-AA-AACR-phase7-reporting.md` — Phase 7 reporting after action review
- `022-AA-AACR-phase8-security.md` — Phase 8 security hardening after action review
- `023-AA-AACR-phase9-release-readiness.md` — Phase 9 release readiness after action review
- `031-AA-AACR-v0.6.0-release-aar.md` — v0.6.0 release report / after action review

### RL — Release

- `039-RL-REPT-qmd-team-intent-kb-release-v0.7.0.md` — v0.7.0 release report

## Chronological Listing

| #   | Code    | File                                | Description                      |
| --- | ------- | ----------------------------------- | -------------------------------- |
| 000 | PP-PLAN | mega-blueprint                      | Canonical project blueprint      |
| 001 | AT-ARCH | repo-blueprint                      | Repository structure             |
| 002 | AT-ARCH | architecture-overview               | System architecture              |
| 003 | AT-DSGN | system-thesis                       | Design rationale                 |
| 004 | PP-RMAP | phase-plan                          | Implementation roadmap           |
| 005 | TQ-TEST | testing-ci-strategy                 | Testing and CI                   |
| 006 | TQ-SECU | security-governance                 | Security and threats             |
| 007 | AT-DSGN | data-model-draft                    | Domain model                     |
| 008 | OD-RELS | release-versioning-policy           | Release policy                   |
| 009 | DR-GUID | contribution-workflow               | Contributor guide                |
| 010 | WA-WFLW | internal-claude-operations          | Claude workflows                 |
| 011 | PM-RISK | risk-register                       | Risk tracking                    |
| 012 | AA-AACR | initial-aar                         | Phase 0 AAR                      |
| 013 | AA-AACR | phase1-schema                       | Phase 1 AAR                      |
| 014 | AA-AACR | phase2-runtime                      | Phase 2 AAR                      |
| 015 | AA-AACR | phase3-adapter                      | Phase 3 AAR                      |
| 016 | OD-OPSM | branch-protection-checklist         | Branch protection setup          |
| 017 | AA-AACR | phase4-api                          | Phase 4 AAR                      |
| 018 | AA-AACR | phase5-curator                      | Phase 5 AAR                      |
| 019 | AA-AACR | phase6-exporter                     | Phase 6 AAR                      |
| 020 | OD-RELS | v1-release-checklist                | v1 release checklist             |
| 021 | AA-AACR | phase7-reporting                    | Phase 7 AAR                      |
| 022 | AA-AACR | phase8-security                     | Phase 8 AAR                      |
| 023 | AA-AACR | phase9-release-readiness            | Phase 9 AAR                      |
| 024 | PP-CLOS | v1-scope-closeout                   | v1 scope closeout                |
| 025 | AA-AACR | v0.3.0-release-report               | v0.3.0 release report            |
| 026 | AT-DSGN | repo-resolver-design                | repo-resolver package design     |
| 027 | OD-OPSM | edge-daemon-runbook                 | edge-daemon operations runbook   |
| 028 | OD-SECU | release-signing                     | Release supply-chain signing     |
| 029 | OD-RELS | npm-publishing-strategy             | npm publishing strategy          |
| 030 | DR-GUID | import-conversion-recipes           | Import from various sources      |
| 031 | AA-AACR | v0.6.0-release-aar                  | v0.6.0 release report            |
| 034 | AT-NTRP | ecosystem-thesis                    | Compile, Then Govern thesis      |
| 035 | AT-DECR | post-thesis-build-direction         | Post-thesis council decision     |
| 036 | AT-THRT | spool-boundary-threat-model         | Spool boundary threat model      |
| 037 | AT-DSGN | qmd-adapter-source-index-separation | qmd-adapter source/index ADR     |
| 038 | AT-DECR | retrieval-backend-decision          | Retrieval backend decision       |
| 039 | RL-REPT | qmd-team-intent-kb-release-v0.7.0   | v0.7.0 release report            |
| 040 | OD-OPSM | brain-api-tailnet-deploy            | Brain API tailnet deploy runbook |

## Next Available Sequence: 041
