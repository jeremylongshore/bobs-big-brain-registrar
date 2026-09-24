# Decision Record — Reference-import flood and bounded admission

**Date:** 2026-08-02

**Status:** Ratified investigation; implementation follows in the linked beads

**Primary bead:** `bd_000-projects-gpg9`

**GitHub:** Registrar #329, #330, #331

**Plane:** LAB-145, LAB-146, LAB-147

## Decision

The 13x growth in the `reference` category was a one-time producer-side
whole-machine replay on 2026-07-16, not evidence that the normal daily compile
loop is continuously re-capturing the whole brain. The corrective boundary is
therefore split:

1. ICO owns incremental spool emission and a per-run ceiling (`intentional-
cognition-os-l13.3`, compiler PR #190).
2. Registrar owns the admission contract for broad or bulk imports: explicit
   batch identity, declared scope and count, trust classification, a durable
   receipt, and fail-closed promotion when that receipt is absent or invalid
   (`bd_000-projects-gpg9.1`).
3. The historical 2026-07-16 corpus gets a reversible inventory and disposition
   proposal. It is not bulk-deleted or mutated as part of this investigation
   (`bd_000-projects-gpg9.2`).

## Evidence

The live `~/.teamkb/teamkb.db` was inspected read-only. The candidate table
shows the 2026-07-16 cohort as:

| Source | Status    | Category  |  Count |
| ------ | --------- | --------- | -----: |
| import | promoted  | reference | 14,956 |
| import | inbox     | reference |    105 |
| import | duplicate | reference |     44 |

The contemporaneous governance sweep receipt reported `14,958 promoted`, `44
duplicate`, `0 quarantined`, `0 flagged`, and `106 rejected` from `15,108`
processed candidates. The small difference between the receipt total and the
current candidate projection is retained as a reconciliation detail, not
silently rounded away.

The promoted import rows have 17,010 distinct content hashes across the
imported corpus, so this was not an exact-row duplication event. However, the
source paths and timing identify a broad source backfill rather than ordinary
incremental capture. The compiler commit `589bcc4` (2026-07-17) records the
producer-side finding: an explicit whole-machine `--bulk` run had emitted about
17,000 candidates and 51.7 MB.

The registrar spool path does not attach `import_batch_id` values to spool
intake, while the vault-import path does create batch IDs. That asymmetry is
why the next control belongs at the broad-import admission boundary instead of
being inferred later from category counts.

## What this does not claim

- The evidence does not prove that every promoted reference row is low value.
- It does not justify deleting, demoting, or quarantining the legacy corpus
  without a reversible inventory and approval.
- It does not make the qmd dense index a source of truth; retrieval indexes are
  derived and must be rebuilt only after source and governance state settle.
- It does not replace the compiler-side watermark. The producer and registrar
  controls cover different failure boundaries.

## Acceptance boundary

Future broad imports must carry enough durable context for an operator to answer
"what was emitted, from which scope, under which trust mode, and why was this
volume allowed?" before promotion. A normal single-source capture must continue
to work without pretending it is a bulk batch. Any rejected or incomplete batch
must leave an auditable receipt and a documented recovery path.

The legacy cohort remains an evidence set until `bd_000-projects-gpg9.2`
produces its reversible inventory and an explicit disposition is approved.
