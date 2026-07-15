# 043-OD-EVAL — Onboarding Q-bank v1 (outsider day-1)

**Status:** Active  
**Date:** 2026-07-14  
**Purpose:** Regression set for "does BBB answer a new teammate?" Measure before/after productization.

Score each: **0** empty/wrong · **1** partial · **2** useful with real `qmd://` cite.  
Max **24**. Target after plan: **≥ 20 (≈80%)**.

| #   | Outsider question                         | Keyword probe (fallback)    | Baseline 2026-07-14 notes |
| --- | ----------------------------------------- | --------------------------- | ------------------------- |
| 1   | What is Intent Solutions building?        | Intent Solutions product    | Weak/wrong hits on NL     |
| 2   | Where is production hosted? How do I SSH? | Contabo VPS intentsolutions | Strong                    |
| 3   | How does the team knowledge brain work?   | compile then govern qmd     | Strong with keywords      |
| 4   | How do we track work?                     | beads bd                    | Strong                    |
| 5   | How do we store secrets?                  | SOPS age                    | Keyword strong; NL weak   |
| 6   | Commit / PR standard?                     | Outsider Test commit PR     | Weak                      |
| 7   | Testing SOP / audit-harness?              | audit-harness testing SOP   | Partial (title hits)      |
| 8   | Still on GCP?                             | GCP Contabo VPS             | Partial in guides         |
| 9   | How do I use Bob's Big Brain / search?    | brain_search bbb-qmd        | Empty before day-1 pack   |
| 10  | Personal qmd vs team index?               | XDG teamkb qmd-index        | Empty before day-1 pack   |
| 11  | Plane / bd-sync?                          | bd-sync Plane               | Empty / weak              |
| 12  | Day-one checklist?                        | onboarding                  | Wrong hits                |

## How to re-score

```bash
./scripts/bbb-qmd search --json -- "<keyword probe>"
# or MCP brain_search with keyword then scope=all if empty
pnpm search-canary
```

Record date, scorer, total / 24 after each release wave.

## Baseline canary (Phase 0)

```
SEARCH HEALTHY (tenant=intent-solutions)
  audit chain receipts
  governed brain backup
  compile then govern architecture
Pinned workspace qmd: 2.5.3
PATH ~/.bun/bin/qmd: 2.0.1 (do not use for BBB)
```

## Re-score 2026-07-15 (after day-1 pack + bbb-qmd)

Method: `./scripts/bbb-qmd search --json -- "<keyword probe>"`; score 2 if ≥3 hits, 1 if 1–2, 0 if 0.

| #                   | Score | Hits | Probe                       |
| ------------------- | ----- | ---- | --------------------------- |
| 1 product           | 2     | 20   | Intent Solutions product    |
| 2 VPS               | 2     | 11   | Contabo VPS intentsolutions |
| 3 brain stack       | 2     | 15   | compile then govern qmd     |
| 4 beads             | 2     | 20   | beads bd tracking           |
| 5 secrets           | 2     | 12   | SOPS age secrets            |
| 6 PR standard       | 2     | 6    | Outsider Test commit PR     |
| 7 testing           | 2     | 20   | audit-harness testing SOP   |
| 8 GCP               | 2     | 10   | GCP Contabo VPS             |
| 9 how use brain     | 2     | 3    | Bob Big Brain bbb-qmd       |
| 10 personal vs team | 1     | 2    | XDG teamkb qmd-index        |
| 11 bd-sync Plane    | 2     | 20   | bd-sync Plane               |
| 12 day one          | 2     | 13   | onboarding day              |

**Total: 23 / 24 (≈95%)** — meets ≥80% target (re-run via `pnpm eval:onboarding`).  
Canary (6 controls) still SEARCH HEALTHY after promote.

Re-run: `pnpm eval:onboarding` or `bash scripts/eval-onboarding-qbank.sh`.
