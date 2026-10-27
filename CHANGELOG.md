# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add an internal finite reviewed staleness settlement and separately reviewed
  reactivation core. It binds canonical and complete stored-row snapshots, rule
  definitions, captured evidence bytes and an independently supplied manifest
  digest; canonical state and audit receipts settle in one immediate transaction
  with exact readback, rollback and replay controls. Disposable-store coverage
  includes unknown metadata drift and ignored/altered writes. No CLI/API wiring,
  live authority, corpus sweep, index refresh or deployment is included
  (`compile-then-govern-39z.2.3`).

### Changed

- Qualify staleness declarations with pinned historical source references and
  private/unsigned evidence limits. Repository renames request metadata review;
  platform retirement candidates additionally require an explicit per-memory,
  per-rule estate applicability assessment. External references and unknown scope
  remain review findings. No live sweep, verified-authority gate or apply path is
  included (`compile-then-govern-39z.2.2`). The private Curator source interface
  now requires rule `remedy`/`authority` and returns finding `remedy`, `authority`
  and `scopeEvidenceRef`; the optional third argument supplies applicability.
  Default calls retain all non-exempt matches for manual review. No version bump
  or package publication is included.

### Fixed

- Distinguish explicit prescriptive staleness candidates from manual-review
  matches in the dry-run detector. Completed narratives, quoted/code examples,
  provenance-only platform mentions and mixed historical advice remain visible
  for review; clear teardown records retain their exemption. This is a small
  syntax heuristic, not a corpus-precision measurement or transition authority.
  No apply path or rule-evidence gate is changed (`compile-then-govern-39z.2.1`).

- For API graph reads, enforce the selected tenant, API-derived token allowlist
  and audience policy. Reject blank or repeated tenant selectors.
  Constrain both link endpoints before recursive expansion so restricted tenant
  or audience nodes cannot bridge to readable descendants or affect path ranking.
  Indexed edge/endpoint lookups use cached statements. Unscoped API reads retain
  cross-tenant access unless a tenant is selected; trusted repository calls that
  omit scope retain prior behavior. No migration or deployment is included (`compile-then-govern-ion`).

- Reconcile owning and stock harness verification using one installed verifier
  and additive patterns. Retain all eight existing protected policy paths and
  expand coverage to package/CI commands and verifier-selection controls, with
  copied-file mutation checks in CI. Existing thresholds and waivers are unchanged;
  manifest changes require explicit review (`compile-then-govern-ba9`).

- Restrict global policy dormancy and index freshness diagnostics to unscoped
  administrators at `GET /api/health/diagnostics`. Anonymous `GET /api/health`
  retains liveness, DB connectivity, uptime and version, with no tenant or policy
  metadata. Diagnostic consumers must migrate to the authenticated route;
  no service deployment is performed (`compile-then-govern-zgh`).

- Reconcile source documentation for retrieval defaults, package/API/MCP inventories,
  CI commands, and historical decision authority; repair the document index and links
  (`compile-then-govern-eqw.6.3`). No runtime or model-selection change.

- Scope `fast-uri` overrides by requested major: AJV and Swagger retain patched
  3.1.9, while Fastify validation and serialization receive supported patched
  4.2.3. Preserve real header, schema, SDK and URI security controls across both
  selected lines (`compile-then-govern-1io.1.12`).

### Fixed

- Preserve ordinary host `on`/`once` signal callback control when qmd forwards
  shutdown to its tracked POSIX groups. Run bounded group cleanup before those
  callbacks, including once callbacks registered before executor startup; retain
  default termination when no host listener remains. Later prepended host
  listeners and existing process-group limits remain outside this guarantee.

### Added

- Share fixed spool-intake observation counters across the curator CLI and daemon,
  including disclosure categories, tampered files and admission refusals. Preserve
  detailed legacy output and existing policy/archive behavior; daemon observations
  are unavailable on failed or skipped intake. Document retained raw refused
  content and repeat-call limits; counters are not unique audit receipts.

- Check every copied owned-launcher option field and parser configuration against
  the SHA-256-pinned qmd2.5.3 CLI metadata without importing qmd. Regression
  controls reject altered types, aliases, defaults, multiplicity, missing entries
  and strict/positional drift; runtime behavior and dependencies are unchanged.

- Expose canonical anchor JSONL parsing and verification of captured records, so
  fixed recovery integrations can verify their bounded read without reopening a
  path. Existing path verification delegates to the same checks and retains its
  existing read behavior; snapshot verification establishes no file binding or
  external publication.

- Recovery integrations can check synchronous readiness under the shared flock
  and the same immediate SQLite transaction before fresh application. Refusal
  leaves recovery unsettled; historical replay and repair keep their existing
  commit reporting and still require postcommit verification.

- Add strict recovery-only qmd2.5.3 registry inspection for an explicit owned
  runtime. Compare YAML and SQLite collection names, source roots and behavior;
  refuse hooks, filters, conflicting paths and file replacement. Distinguish
  partial setup from a complete registry, and verify actual selected list
  execution before/after stage checks. Generic legacy setup is unchanged;
  document/index completeness and fixed recovery integration remain parent work
  (`compile-then-govern-eqw.8.1.2.7.1`).

- Add trusted asynchronous recovery composition that keeps the validated physical
  store, existing database and acquired kernel flock bound through awaited postprocessing.
  Fresh partial applies run that stage; apply replay skips it, while explicit
  repair requires verified existing settlement and never governs. Keep known
  commits after callback or cleanup faults, recheck store/settlement between
  stages, retain sanitized warnings and snapshot operation identity before await.
  Callback completion does not certify full recovery; concrete plugin anchoring,
  tenant-isolated exports/indexes and their proof remain parent work
  (`compile-then-govern-eqw.8.1.2.7`).

- Add `curator-recovery plan`, `apply` and `status` for explicit private,
  current-schema stores. Pin reviewed plans to physical directory/database
  identities, refuse special-file inputs without blocking, and hold the actual
  brain `.write.lock` across canonical application. Keep plan/status read-only,
  require explicit private origin-key files, sanitize policy warnings and report
  database settlement separately from pending anchors, exports and indexes.
  Postcommit integration and private-copy/live recovery remain parent work
  (`compile-then-govern-eqw.8.1.2.6`).

- Add atomic same-store application and read-only status for frozen recovery
  plans. Bind actual intake identities, selected governance with source floors,
  verified conditional archival and final receipt to the complete reviewed plan.
  Preserve mixed holds, flags and refusals as partial outcomes; verify earlier
  receipts and final row snapshots, roll back unexpected faults and refuse
  drifted replays. Later human reviews require separate finalization. Filesystem
  locking, CLI, anchors, derived refresh and live recovery remain parent work
  (`compile-then-govern-eqw.8.1.2.5`).

- Add read-only finite recovery plans binding complete reviewed source snapshots,
  exclusions, target policies, store locator and declared human authority to
  fresh canonical proposals. Preserve source kind and import risk, cap trust,
  retain source sensitivity floors and refuse target conflicts. Reuse canonical
  intake preparation without writing rows or loading origin keys; optional
  supplied keys mint fresh tokens. Validate private JSON plans against an
  externally reviewed digest. Apply, locking, archival, anchors and live recovery
  remain separate (`compile-then-govern-eqw.8.1.2.4`).

- Bind reviewed recovery sensitivity floors into selected manifests and durable
  candidate audit receipts. Preserve the strongest same-store floor through
  policy evaluation, promotion, later member review and human hold release;
  retain original classified-level policy refusals as well as effective-level
  refusals. Promotion verifies the evaluated constraint again under its write
  lock and records classified/minimum/effective levels. Candidate metadata and
  no-floor behavior stay unchanged. Remote clone receipt transport and live
  recovery orchestration remain separate (`compile-then-govern-eqw.8.1.2.3`).

- Add conditional `archiveRecoveredSource` for a reviewed source/target manifest.
  Verify current admitted target and candidate snapshots plus pinned canonical
  promotion and selected-run receipts before archiving one active source with
  its receipt on the same SQLite connection. Preserve source payload, metadata,
  trust and sensitivity bounds; recheck evidence after writes and on replay.
  This core does not capture, take a filesystem lock, anchor, refresh exports or
  execute live recovery (`compile-then-govern-eqw.8.1.2.2`).

- Add finite `governSelectedCandidates` over reviewed candidate snapshot bindings,
  using the canonical curator under one immediate SQLite transaction. Preserve
  unrelated queues and holds, member quarantine and policy decisions; refuse
  unapproved supersession and roll back failed disposition/receipt writes.
  Repeat runs return historical settlement evidence. This core API does not
  ingest a recovery manifest, archive source memories, take the filesystem lock,
  anchor or refresh derived files (`compile-then-govern-eqw.8.1.1`).

- Add public `rejectReviewedCandidate` for person-reviewed inbox rejection on
  one SQLite connection. Check tenant, declared human/admin-or-owner authority,
  audience standing, linked memories and active holds under a write lock; commit the retained
  candidate's rejected status and canonical receipt together. Refuse repeats
  without another receipt. This core API does not add an installed review command,
  hold release, model tool, external anchor or export reconciliation
  (`compile-then-govern-eqw.10.1`).

- Add bounded generated audit-chain contracts with version-aware hash and
  tamper checks, bounded sequential insertion/sequence ordering, exception
  tuple/reason pins and
  retained-anchor rewrite controls. Use synthetic rows, private in-memory stores
  and fixed-seed shrinking; preserve existing production formats and example
  assertions (`compile-then-govern-6ps.10`).

- Add a read-only promoted-receipt identity and export-header check with a
  hermetic promotion-to-export proof. Report order inherits the store query order;
  the checker imposes no ordering. Resolve eligible memories through canonical
  export paths and qmd collections; fail on missing or unsafe files and substituted
  or foreign identity frontmatter. Body substitution is outside the check. Report
  intentionally restricted exports separately and refuse an empty acceptance
  denominator (`compile-then-govern-6ps.9`).

- Add a pure contradiction dry-run planner over caller-verified compilation
  lineage and explicit emission-to-promotion endpoint mappings. Eligible pairs
  retain source evidence and require review; malformed, ambiguous, cross-tenant,
  inactive, self, duplicate and exact-restatement pairs are refused. No graph,
  lifecycle or search activation is included (`compile-then-govern-39z.1.1`).

### Fixed

- Commit audited candidate intake and its canonical proposal receipt together on
  one SQLite connection. Verify candidate payload/hash and receipt readback so
  aborted, ignored or drifted writes fail and roll back. The API reuses the shared
  Curator intake boundary; schema, channel, disclosure, authority overrides,
  tenant-scoped replay and redaction checks remain in use. Explicit unaudited
  direct-service construction remains unreceipted; historical replays do not
  fabricate missing receipts. Recovery orchestration and live transfer remain
  separate (`compile-then-govern-eqw.8.1.2.1`).

- Make API reviewer rejection atomic on one immediate SQLite transaction, with
  current candidate/hold/admitted-memory checks and verified status/receipt writes.
  Retain AI/system review of inbox and non-held quarantined proposals; refuse
  repeated or already-admitted rejection without another receipt. Candidate content
  survives, and silently ignored or aborted writes roll back (6ps.23).

- Isolate DenseIndexer HTTP fixtures on private Unix sockets so unrelated host
  loopback requests cannot enter their strict rejection counters. Preserve the
  original seven-request malformed-input assertion, explicitly test rejection of
  a root request, and retain unchanged production-fetch TCP EmbedClient tests
  (6ps.24). The earlier unexpected callers remain unidentified.

- Run explicitly enabled retrieval acceptance over an internally owned export
  copy and rebuild qmd/native indexes in a private worker. Preserve source
  indexes, registries and state databases; remove validated successful scratch
  after worker exit and retain uncertain failure scratch for investigation.
  Reports describe the copied corpus, with existing default-lane isolation and
  dataset assertions retained (`compile-then-govern-39z.23`).

- Include equal-watermark memories in incremental exports and persist the clock
  sampled before the memory read, rather than a completion timestamp. Preserve
  content comparison so boundary rechecks cause no duplicate file writes. This
  fixes visible equal-time insert/update/archive omissions and replaces the
  completion-time watermark. This is not an atomic snapshot or logical commit
  cursor; pre-start-timestamped, sufficiently late or backdated/skewed commits
  still require explicit reconciliation
  (`compile-then-govern-6ps.22`).

- Persist explicit MCP and HTTP supersession transitions with a canonical
  replacement link and audit event in one transaction. Require an existing active,
  distinct replacement in the same tenant; reject state-only supersession writes
  and accept current content-derived UUIDs. Preserve curator promotion behavior
  and the batch CLI's explicit supersession refusal (`qmd-team-intent-kb-ehi`).

- Verify owned qmd artifact files through a reused bounded buffer and precompute
  layout lookups, preserving full-byte hashes, native-file verification and strict
  graph/layout checks. Reject files that change identity, size or recorded metadata
  while hashing. This source change requires a newly staged artifact; it does not
  establish availability within the existing command budgets
  (`compile-then-govern-1io.1.5.1.3.2.3.1`).

- Exclude optional standalone HTTP from the owned qmd launcher. Parsed `--http`
  options are refused before spawning, while MCP stdio, literal arguments and
  explicit external binary overrides retain their behavior. This restriction
  requires a newly staged artifact and manifest; it does not patch the included
  qmd HTTP source or change existing/global installations
  (`compile-then-govern-1io.1.5.2`).

- Share opt-in owned qmd command selection across adapter and MCP sync, with a
  paired artifact root/manifest digest and no legacy fallback for broken
  declarations. Preserve command budgets, tenant registry/cache locations and
  explicit binary compatibility; disable ancestor index discovery with an explicit
  selector. Team startup skips local qmd probing and sync registration. This source
  integration does not activate an artifact, update global tools or deliver plugin
  runtime packaging (`compile-then-govern-1io.1.5.1.2`).

- Refresh residual dependency paths to qs 6.16.1, fast-copy 4.2.0, Fastify
  5.12.7, ip-address 10.7.4 and fast-uri 3.1.9. The typed-rest-client 2.3.1
  exact qs pin is an explicit compatibility exception, covered through its real
  URL helper. The inherited fast-uri 3 override still falls outside two Fastify
  parent declarations for version 4; selected local-reference validation and
  serialization cases are exercised while parent-range reconciliation remains separate
  (`compile-then-govern-1io.1.12`). Synthetic advisory and normal-operation
  contracts cover the selected repository dependencies; qmd, node-llama-cpp
  and native/model pins remain unchanged.

- Refresh installed helper dependencies to tar 7.5.22, nanoid 5.1.16,
  body-parser 2.4.0 and undici 8.12.3; align both MCP SDK paths on 1.32.2.
  The scoped simple-git 4.0.2 override is a reviewed major-range exception for
  node-llama-cpp 3.18.1, covered by real local Git consumer and unsafe-input
  refusal contracts. qmd, node-llama-cpp and native/model pins stay unchanged.
  These repository changes do not update separately installed qmd executables
  or harden qmd's optional standalone HTTP transport.

- Upgrade all resolved Zod dependencies to 4.6.7 and Vite to 8.3.5 (patched
  floor 8.3.3) for GHSA-mrhx-c7xc-m3w5 and GHSA-587h-7wmj-h5pm. Scoped
  qmd/core overrides align with the owned Zod range. That validator-only update
  left qmd and MCP SDK versions unchanged; the subsequent SDK refresh is described above. Offline contracts exercise owned size-bounded collections,
  both actual SDK instances, and the pinned qmd MCP stdio server. SDK compatibility
  modules still include Zod 3 code; these tests cover the selected patched Zod 4 paths.

- Add native lexical candidates for English question-shaped queries when strict
  and dense retrieval arms yield no usable hits (including qmd failure). The fallback uses 2–12
  distinct topical terms, up to 200 collection-scoped candidates and a minimum
  term-coverage threshold. The fallback does not augment existing nonempty lists; quoted inputs do not
  broaden. Unquoted inputs beginning with a recognized question word can broaden,
  including operator-style inputs; operators remain literal, not executable.
  Refuse fallback above 25,000 native documents, 2,000 scoped postings per term or 10,000
  total term postings. Bounded probes and coverage-before-cutoff ranking use one deferred
  read transaction. These caps do not bound document size or index-refresh work.
  Timeout configuration and tenant guards are unchanged; no new wall-time bound
  is established for synchronous SQLite work. Apply native
  collection scope before the result cutoff (`compile-then-govern-39z.33.5`).

- Default dense indexing to one document per request for embedders with
  limited request capacity. Each request retains its existing deadline;
  explicit batch overrides, query timeouts and vector identity rules are retained.
  Retry/fail-open policy code is unchanged; the default request/retry unit is
  now one document (`compile-then-govern-1io.6`).

- Make the reranker canned HTTP test fixture reject malformed JSON/documents
  and await connection teardown, so an empty request cannot escape as an unhandled JSON
  exception during otherwise-passing validation (`compile-then-govern-1io.4.1`).

- Commit HTTP memory lifecycle/category updates and their audit receipts in
  one shared transaction, rolling both back on failure while retaining nested
  caller transactions (`compile-then-govern-1io.7`).

- Arm qmd host-signal cleanup before spawning the launcher so SIGINT during
  spawn cannot leave a running detached child unregistered. Failed/no-PID
  spawns release their reservation; normal release/untrack removes qmd
  handlers once no group or spawn remains. Signal teardown removes its own
  listener separately before a re-raise; host handlers are never removed. A forced
  startup-race regression fails before the fix and passes after it (umbrella
  `compile-then-govern-1io.4`).

- **Estate evaluation isolates derived-index writes (`compile-then-govern-1io.3`).**
  `eval:estate` now backs up the store and selected tenant's qmd/native/dense
  indexes to a private temporary workspace, runs its worker there, and cleans
  up after exit. Native refresh and dense model invalidation affect copies;
  qmd environment overrides and project discovery cannot select live indexes.
  Reports and probes expose source-index presence and dense degradation,
  including unavailable construction, empty indexes and dimension mismatch.
  Each database backup is WAL-consistent; the ensemble and live export tree
  are not one atomic snapshot. Source read-only SQLite connections may update
  coordination sidecars, but do not rewrite database or committed WAL data.

- Deprecated memories now export to `archive/` and are excluded from default
  curated search after export reconciliation and index refresh (umbrella bead
  `compile-then-govern-39z.13`). Their database lifecycle remains deprecated;
  explicit archive/all search still reaches them. Reactivation plus reconciliation
  restores the active folder and removes the stale archive copy.

### Changed

- Dense query diagnostics retain fixed timeout, transport, HTTP and response-validation categories while preserving the existing vector/null and lexical fail-open contracts. Estate evaluation reports bounded events attributed to scored, gap or probe IDs, with complete aggregate counts and an explicit dropped-event counter; these diagnostic events omit query text, response bodies, URLs and raw errors (the evaluation report still includes its existing query and retrieval fields). The earlier five generic failures cannot be classified retrospectively.

- Record seventeen local memory retirements and fifteen accepted corrections; update seventeen question labels (sixteen replace relevant citations, fourteen correction citations become gold), preserve all 45 scored questions, and publish frozen labels plus a two-by-two citation replay. On corrected labels, the later local run measured Recall@10 0.4389 and obsolete exposure 5/45 versus 0.3759 and 12/45 on the earlier lists. Five dense query failures make this degraded retrieval evidence, not a controlled pure-hybrid or deployed acceptance claim; remaining gaps stay tracked.

- Add seven authority-checked, query-specific obsolete estate labels and a dated local observation/relabel receipt; expose known mixed-current gold awaiting selective repair. No retrieval ranking or corpus mutation.

- **Estate eval labels follow the corrected rewrites (umbrella bead
  `compile-then-govern-39z.28`).** Eleven partly stale brain docs were recaptured with their
  one wrong claim fixed and the originals archived, and the admin-bypass merge note was archived
  by owner decision; `estate-onboarding-v1` now points at the rewrites and drops the obsolete
  labels on the archived originals. Live after relabel: Recall@10 0.5389, FAMA@10 0.5389,
  obsolete exposure 0 of 45 (was 2); see the dataset README.

### Added

- **Forgetting-aware retrieval eval (umbrella bead `compile-then-govern-39z.5`).** `famaAtK`
  (Memora's FAMA, applied to a ranked list) joins Recall/nDCG in the eval harness, and
  `EvalQuery.obsolete` labels docs that used to answer a query but are now wrong. New
  `estate-onboarding-v1` set: 45 scored new-hire questions (23 with obsolete labels) plus 5
  documentation holes. `pnpm eval:estate` runs it live and read-only through the team-API search
  path and prints `DEGRADED` when the dense arm fails open. First run: Recall@10 0.4815, FAMA@10
  0.4577, obsolete docs served on 7 of 45 questions.
- **Estate eval reports filled documentation holes by rank (umbrella bead
  `compile-then-govern-39z.26`).** `EstateGap.answeredBy` names the doc captured to fill a
  hole; `pnpm eval:estate` prints where it ranks (and `answerRank` in `--json`) without
  scoring it, so the 45 scored questions stay comparable. After archiving 34 obsolete docs and
  capturing five missing facts: obsolete exposure 0.1556 → 0.0222, all five holes answered at
  rank 1–2, Recall@10 0.4741 → 0.4333 (recent notes embedded by the same reindex displaced
  three canonical answers; see the dataset README).
- **Governed redaction now scrubs every tenant's derived search index (umbrella bead
  `compile-then-govern-39z.19`, runbook `000-docs/054-OD-RNBK` §4.7).** On 2026-10-04 the redacted
  text survived `curator redact` + `export --reconcile` + `reindex` in `~/.teamkb/qmd-index/`:
  qmd's BM25 cache keeps inactive rows and orphaned `content` rows, the native FTS5 index kept the
  moved row and its `-wal` the text, and the plugin's `local` tenant index was never reindexed. New
  `qmd-index scrub-index [--dry-run] [--json] [--scan-fragments-file <path>]` discovers every tenant
  directory, reconciles the qmd cache, native FTS5 index and dense sidecar (whose snippet column is
  plaintext) against kb-export, rebuilds and optimizes both FTS5 indexes, and runs
  `secure_delete` + WAL truncate + `VACUUM`; an optional byte scan of every file under the index
  directory reports file names and counts, never the text. It refuses an index file whose layout
  differs from the pinned qmd 2.5.3 schema (exit `5`), reports a busy database by name (exit `4`),
  and refuses a reconcile that would remove more than a quarter of a file's documents unless
  `--allow-mass-removal`. `curator-cli redact` runs it after the database scrub (as a child process,
  removed text on stdin) and byte-scans the indexes with the same removed text; new flags
  `--index-dir`, `--export-dir` (default: beside `--db`) and `--skip-index-scrub`. An incomplete
  index scrub makes `redact` exit `4`. `@qmd-team-intent-kb/store` adds `scanFilesForFragments`.

- **Bounded human-escalation hold for ambiguous audience and secret decisions (Epic K bead K6,
  decision `053-AT-DECR`, reusing the `014-AT-DECR` recommend / pipeline-owns split).** A candidate
  whose audience or secret question the rules can detect but not decide is now put on a hold; it is
  no longer left in the inbox with no exit, and it is neither promoted nor dropped. Entry is a
  deterministic rule outcome only: an `audience_narrowing`, `sensitivity_gate` or flag-action
  `secret_detection` flag, or a `member` proposal that declares `admins` or `owner`. A hold reuses
  the existing `quarantined` candidate status plus a `held` audit receipt that carries the triggers
  and the expiry, so there is no new status and no store migration. Bounds: a hold closes
  UNPROMOTED after 14 days (`TEAMKB_HOLD_TTL_DAYS`), and past 100 open holds per tenant
  (`TEAMKB_HOLD_MAX_ACTIVE`) the gate fails closed and reports it. A reviewer, a model included, may
  attach a recommendation (`POST /api/holds/:candidateId/recommend`), which writes one receipt and
  changes no state. A person with admin or owner standing resolves it: `curator-cli holds
  <list|resolve|expire> --db --tenant [...] [--dry-run] [--json]`, `GET /api/holds` and
  `POST /api/holds/:candidateId/resolve`. A release re-runs the whole deterministic gate and
  promotes with the audience the person chose; an audience wider than the recommended tier needs an
  explicit acknowledgment. Each change commits with its hash-chained receipt in one transaction.
  Runbook: `000-docs/055-OD-RNBK-human-escalation-hold.md`.
  **Behavior changes:** `Curator.processSingle` returns a new outcome `held`, and
  `CurationBatchResult` gains `held` and `holdCapBlocked`. `POST /api/candidates/:id/promote` on
  such a candidate now answers 422 with code `held_for_review` (it answered 422 "flagged" before)
  and `POST /api/candidates/:id/reject` on a held candidate answers 422 `on_hold`. `AuditAction`
  gains `held`, `hold_recommended` and `hold_resolved`. A token record in `tokens.json` may carry
  `"agent": true`; such a token, and the `teamkb-review-agent` actor, cannot resolve a hold.
  Measured escalation rate: 9 of 29 on the K3 hand-labeled audience fixture, 3 of 33 on the
  govern-decision adversarial set.

- **Secret scan catches passwords stated in prose and credentials in any-scheme URLs.** Two new
  deterministic patterns join the governance secret scan (capture-time redaction and the
  promote-time `secret_detection` rule): `prose-password` (`password` / `passwd` / `passphrase`,
  then `is` / `was` / `:` / `=` within 40 characters, then a quoted or backticked value of 6–128
  non-whitespace characters) and `url-embedded-credentials` (`scheme://user:secret@host` for any
  scheme). Documentation placeholders (`username:password`, `<password>`, `${VAR}`, `changeme`,
  env-var names, file paths) are excluded. The rule's failure reason now names each pattern and
  its line, never the matched text. **Reason format change:** the stored rejection reason was
  `… (ids: a, b)` and is now `… (ids: a, b; locations: a at line 3; b at line 7)`; anything parsing
  that string must allow the new `; locations: …` suffix.
- **Whole-brain secret sweep (`curator-cli secret-sweep --db <path> --tenant <id> [--pattern <id>]... [--json]`).**
  Opens the store read-only and re-runs the same scan over every curated memory of the tenant in
  every lifecycle state. Prints only memory id, title, lifecycle, category and pattern names (a
  title that itself matched is withheld). Exit 0 clean, 3 findings, 2 usage error, 1 I/O failure.

- **Governed audience narrowing (Epic K bead K3, decision `053-AT-DECR`).** A promoted memory's
  audience can now be narrowed after promotion, toward a stricter tier only (`tenant` -> `admins` ->
  `owner`): `curator-cli narrow-audience --db --tenant --to --actor --reason (--memory-id <id|prefix>
  | --ids-file <path>) [--dry-run] [--json]` and admin-only `POST /api/memories/:id/narrow-audience`.
  The audience write and a hash-chained `audience_narrowed` receipt (actor, time, from, to, reason)
  commit in one transaction. Widening, an equal tier and an unknown tier are refused. `--dry-run`
  opens the store read-only. A narrowed memory leaves the shared export tree on the next exporter
  reconcile.
- **`audience_narrowing` policy rule (K3, KR8.2).** A new `PolicyRuleType` (no store migration) that
  flags a candidate whose declared audience is wider than its content calls for (credentials ->
  `owner`, PII -> `admins`). Flag-only and recommendation-only: it never rejects and never writes an
  audience. Measured on its own hand-labeled 29-case fixture, separately from the disclosure
  metrics: precision 0.81, recall 0.93. It is in `RECOMMENDED_POLICY_RULES`, so an existing store
  reports it as dormant until `curator-cli upgrade-policy` runs.
- **Governed redaction (K3 expanded scope).** `curator-cli redact --db --tenant --memory-id
  <id|prefix> --actor --reason (--replacement-text | --replacement-file | --lines <ranges> | --scan)
  [--replacement-title] [--show-title] [--dry-run] [--json] [--skip-scrub]` replaces the content of a
  promoted memory that holds a secret, in the memory row and in every candidate copy, recomputes the
  content hash, and appends hash-chained `redacted` receipts carrying the actor, reason, old and new
  content hashes and secret-pattern names. The removed text is never written to a receipt, to output
  or to an error. Every mode re-scans the result and refuses if a secret pattern still fires. After
  the transaction it rebuilds the FTS index, truncates the WAL, runs `VACUUM` and byte-scans the
  database, `-wal` and `-shm` files for the removed text (exit `4` if that is incomplete). No
  existing audit row is edited, so the chain verifies exactly as before. Runbook, including what
  redaction cannot reach (existing backups, exports, indexes, spool and compile artifacts):
  `000-docs/054-OD-RNBK`. Known gap: `curator-cli merge-govern` has not been taught about redaction
  receipts, so a clone that contains a redacted memory fails the merge gate's id check.
- **Claim-level audience field (Epic K bead K2, decision `053-AT-DECR`).** A memory can now say who
  inside its tenant it is for: optional `metadata.audience` of `tenant` (default), `admins` or
  `owner`, on both `MemoryCandidate` and `CuratedMemory`. It is declared at capture and carried by
  promotion, lives in the existing `metadata_json` column (no store migration), and a record without
  it behaves exactly as before. The API filters `POST /api/search`, `GET /api/memories`,
  `GET /api/memories/:id`, `GET /api/memories/by-hash/:hash`, the graph routes, and the
  transition/recategorize responses by the caller's read standing; a memory the caller is not
  cleared for answers 404. Owner standing is a new optional `"owner": true` on an `admin` token
  record (loopback dev no-auth is the owner; the legacy shared key is not). The git-exporter writes
  only `tenant`-audience memories to the shared export tree, and reconcile removes the file of a
  memory whose audience was narrowed. Limitation: `admins`/`owner` memories are therefore absent
  from the qmd index and are not returned by qmd-cited search for anyone until per-audience indexes
  exist.
- **git-exporter reconcile mode (`runExport({ reconcile: true })`, `exporter-cli export --reconcile`).**
  Converges the whole export tree on the DB instead of exporting only memories changed since the
  last run: lifecycle changes made outside a promotion (curator `batch-transition`) land in
  `archive/`, files deleted or torn mid-write are rewritten, and stale copies (wrong directory,
  newly restricted sensitivity, memories no longer in the DB) are removed. Orphan removals are
  capped (`maxOrphanRemovals`, default 50, `--max-orphan-removals`) so an empty or wrong DB cannot
  wipe a healthy tree; other tenants' files and files without attributable frontmatter are never
  touched. Archive moves are now content-compared like writes, so a re-run reports `unchanged`
  instead of rewriting.
- **qmd binary discovery (`resolveQmdBinary`, `TEAMKB_QMD_BIN`).** The default `RealQmdExecutor`
  now resolves qmd as: explicit `qmdBinary` config, then `TEAMKB_QMD_BIN`, then `PATH`, then
  `~/.bun/bin/qmd`. A pinned path that is not executable is an error rather than a silent fallback.
  The binary's directory is prepended to the child `PATH`. When nothing is found, the executor
  returns exit 127 and `ensureCollections()` / `update()` report `not_available` with a message
  naming every searched location and the fix, instead of the opaque `Failed to update index`.

- Authenticated `GET /api/audit/receipt-tip` exposes the content-safe global governance-receipt chain head and can resolve a previously observed SHA-256 tip after the chain advances. It verifies the chain before answering, fails closed on tamper signatures, reports legacy unverified rows and benign ordering forks separately, and does not claim to identify the exact search results an agent read. This completes the registrar half of AGP's `gsb_receipt_tip_hash` pointer contract. The chain-boundary documentation now also names the canonical shared spool at `~/.teamkb/spool` rather than the retired `brain/spool` location.

- **Receipted governance-policy upgrade (`curator-cli upgrade-policy`, epic
  `qmd-team-intent-kb-5bm.2`).** New `curator-cli upgrade-policy --tenant <id> [--db] [--dry-run]
  [--json]` brings a store's live governance policy up to the recommended anti-dormancy shape
  (`RECOMMENDED_POLICY_RULES` — every registered rule enabled) and writes a `policy_upgraded` audit
  receipt carrying the previous rules verbatim, so the change is reversible from the chain alone.
  Three explicit outcomes (`upgraded` / `created` / `already-complete`); `--dry-run` previews without
  writing. This is the operator-safe migration path — it never edits the live brain directly. (The
  recommended-policy + dormancy doctor tooling itself shipped earlier under `5bm.10`; this is the
  previously-missing command that applies it to a store.)
- **Bulk-digestion scoping (`5bm.8`).** A new non-default `kb-bulk` collection (`bulk/` export
  subdir): memories whose source is `bulk_import` (whole-machine digestions) now route there via
  `getActiveDirectory` instead of flooding the default-searched category collections (the 2026-07-16
  flood put ~9.7k bulk `reference` files in `kb-guides`). A new `bulk` search scope is the deliberate
  way into that corpus; the default `curated` scope excludes it on both the qmd (collection-level)
  and SQLite-fallback (source-level) paths.

### Changed

- **Dedup now refuses redacted text.** A governed redaction changes a memory's stored content hash,
  so an exact-hash check alone would let the original text be re-ingested. The curator, API
  promotion, API intake (`422`, code `redacted_content`) and the candidate insert choke point now
  also refuse content whose hash is the pre-redaction hash on a `redacted` receipt.
- **`provenance-walk` verifies a redacted memory against its receipts.** A redacted memory's id no
  longer derives from its current content hash; the walk now checks the id against the
  pre-redaction hash recorded on the `redacted` receipts and that the receipts' hash history ends
  at the current hash. A row changed any other way still fails.

- Hardened the three public skills for skills.sh: `brain`, `brain-save`, and `teamkb` now distinguish
  the shipped read-only `intent-brain` client from the source-built local operator server, document
  the real authentication and storage boundaries, use explicit model/effort metadata and runtime
  references, and report spool writes as proposals rather than promotions. `teamkb` is now a bounded,
  self-contained workflow that requires explicit approval before importing up to 20 Markdown files.
- **`bulk_import` candidates are stamped low-trust at the schema boundary (`5bm.8`).** A
  `bulk_import` candidate must now carry `trustLevel` `low` or `untrusted` (the default `medium` is
  refused by `MemoryCandidate`), so a whole-machine digestion can never claim curated-grade trust and
  the `source_trust` rule can gate it. **Migration note:** any pre-PR `bulk_import` candidate stamped
  `medium` under the old emitter convention now **fails closed** at re-validation — this is intended
  (it surfaces mis-stamped digestions rather than admitting them silently), and such a row is
  corrected via the governed recategorization/curation tooling (or a one-shot re-stamp), not dropped.
  Depends on the deferred coordination to have ICO's emitter stamp `bulk_import` low at capture time
  (flagged in PR #310); until then, bulk digestions must carry an explicit low/untrusted stamp.
- **Contradiction-check tokenizer is Unicode-aware (E1 review follow-up).** The token-overlap
  heuristic now tokenizes whole words for space-delimited scripts and per-character for space-less
  CJK (`\p{sc=Han|Hiragana|Katakana|Hangul}` unigrams), replacing the ASCII-only `[a-z0-9]` that
  collapsed all non-Latin text to empty token sets.
- **Contradiction-check lookup is category-scoped at the store (E1 review follow-up).**
  `MemoryRepository.findByTenantAndLifecycleAndCategory` lets the rule filter same-category actives in
  SQL instead of loading and deserializing the whole active set per candidate.

- **Repository renamed** from `jeremylongshore/qmd-team-intent-kb` to
  `jeremylongshore/bobs-big-brain-registrar` on 2026-07-19 (public product name: **Bob's Big Brain
  Registrar**, the govern engine of Bob's Big Brain). GitHub serves 301 redirects from the old URL.
  Deliberately UNCHANGED: the `@qmd-team-intent-kb/*` npm scope, the
  `ghcr.io/jeremylongshore/qmd-team-intent-kb-edge-daemon` container image name, and all
  `qmd-team-intent-kb-*` bead IDs — those are published artifact identifiers, not the repo name.
- `ci/emit-evidence/emit-evidence.ts` now derives the signed evidence manifest's signing subject
  from `GITHUB_REPOSITORY` at runtime (with the new slug as a non-CI fallback) instead of a
  hardcoded repo slug, so the manifest subject always matches the cosign OIDC certificate identity
  — rename-proof, and exactly what the fail-closed dashboard ingest verifies.

### Fixed

- **Recent narrow notes no longer push canonical answers out of the top 10 (umbrella bead
  `compile-then-govern-39z.29`).** The rerank multiplied every hit by an unbounded 90-day
  freshness decay of `updatedAt`, which is the import or edit time, not when the fact became
  true. Every doc bulk-imported 2026-07-15/16 sat at ~0.49 against ~0.95 for this month's notes,
  so a short lesson from last week outranked the testing SOP or the brain's topology doc at half
  their fused score. Freshness is now bounded to [0.8, 1] (`FRESHNESS_FLOOR`,
  `freshnessRerankFactor` in `packages/common/src/freshness.ts`), a tiebreaker rather than a
  relevance signal. Live brain, 2026-10-16: estate-onboarding-v1 Recall@10 0.4259 → 0.5370,
  FAMA@10 0.4222 → 0.5302; the held-out governed-brain-v1 set through the same rerank 0.8214 →
  0.9881 (nDCG 0.5768 → 0.8570). Obsolete exposure 1 → 2 of 45: both docs are queued for rewrite
  in `compile-then-govern-39z.28`.
- **The embedder no longer stays down after an outside stop, and its outage keeps paging (umbrella
  bead `compile-then-govern-39z.25`).** On 2026-10-10 21:00 CST something outside systemd sent
  llama-server SIGTERM; it exited 0, `Restart=on-failure` treated that as deliberate, and every
  search ran lexical-only for 2.5 days (estate-onboarding-v1 Recall@10 0.08 instead of 0.48).
  `scripts/bbb-embedder.service` now uses `Restart=always` with a 5-starts-in-5-minutes limit. The
  health check paged Buzz once and the alert floor then dropped 196 identical repeats as duplicates;
  it is now tracked here (`scripts/bbb-embedder-health.{sh,service,timer}`, previously only in
  `~/bin`) and stamps each outage's start time and a 6-hour reminder count into the alert, so an
  outage pages when it starts, every 6 hours while it lasts, and once on recovery. Runbook
  `000-docs/051-AT-RNBK` §5–6 updated.

## [0.8.0] - 2026-07-18

### Added

- **Fused lexical retrieval on the production query path.** The dormant native FTS5 (BM25) backend
  is now activated and fused with the external qmd binary via deterministic **reciprocal-rank
  fusion** (k=60) behind `QmdAdapter.query()` — a new persistent per-tenant `NativeIndexManager`
  (incremental mtime-diff refresh, first-build fast path 453s → 3.8s on the live 17k-file corpus)
  plus a pure `rrf-fusion`, with `disableNativeFusion` as the kill switch. Kills the 2026-07-16
  0-hits-for-our-own-memory miss class (qmd's keyword-AND tokenizer can't match `governed-brain` /
  `CLAUDE.md`; FTS5's unicode61 tokenizer can), serving stays 100% model-free (#257).
- **Freshness + category rerank on the cited (qmd) path.** `rerankCitedHits` +
  `extractMemoryIdFromCitation` in `@qmd-team-intent-kb/common`, applied in `searchViaQmd` after
  score normalisation, so last week's decision no longer loses to a year-old reference doc; every
  hit keeps its `qmd://` citation (#256).
- **Retrieval eval as a CI-gated regression series.** A self-contained stratified ratchet over a
  committed synthetic corpus (never `~/.teamkb`) that fails if lexical **or** semantic Recall@10
  regresses, reported separately (#243); a dedicated `tokenization` stratum locking the two literal
  2026-07-16 incident queries (fused 5/5 vs 2/5 with fusion off) that emits a machine-readable
  `eval-results/synthetic-v1.json` artifact on pass and fail (#258); and the govern-decision +
  provenance evals promoted to a named required CI job (#242).
- **Recommended full-coverage governance policy + anti-dormancy gate** (`packages/policy-engine`):
  `RECOMMENDED_POLICY_RULES` / `buildRecommendedPolicy` covering every registered rule, plus
  `findUncoveredRuleTypes` / `assertPolicyCompleteness` — a CI gate that makes it impossible to add
  a rule the recommended policy leaves inert (the live policy ran only 2 of 8 rules, a direct cause
  of the 2026-07-16 ~15k-candidate flood) (#266). Live-policy dormancy is now surfaced as a distinct
  field in `GET /api/health` so an operator can see inert rules (#278).
- **Governed in-place recategorization** — a tool + API + receipted audit transition to correct a
  memory's category without supersede-and-recreate, which was inflating lifecycle churn (#272).
- **`bulk_import` MemorySource** added to the enum + `curated_memories.source` CHECK so policy can
  gate whole-machine digestions distinctly from deliberate imports (#274).
- **Brain team-bridge API hardening** (EPIC 0 / R-series): one-shot promote-candidate →
  governed-memory endpoint (#203); no-comp/no-PII disclosure gate enforced at candidate intake
  (#201, regexes hardened #202); agent-review approve/reject surface + candidate status-flip fix
  (#238); server-side candidate-intake override with a provenance receipt (#230); idempotent
  tenant-scoped content-hash candidate dedup (#241); per-actor capture quota + aligned DB path
  (#240); pre-hashed scrypt tokens accepted at rest (#227); durable revoke-by-actor persisted
  revocation list (#229); promote() writes wrapped in one transaction for atomic receipts (#231);
  tag-pinned release deployment for the brain API (#228) with a tailnet deploy runbook (#211).
- **EPIC 1 merge substrate (demand-gated, foundation only):** content-derived UUID v5 +
  deterministic audit-chain timestamps (#206), a govern-at-merge gate that re-derives the union as
  untrusted (#207), a per-actor Ed25519 signed DAG anchor + merge-aware verifier (#208), a
  cross-repo namespace drift guard (#210), and residual EPIC 0/1 hardening — enum-membership scan,
  same-content dedup, gate-entry id invariant, N-way merge proof (#209).
- **First real retrieval + govern numbers:** hand-labeled Recall@10 / nDCG@10 over the live corpus
  (#223) and per-check govern-decision precision/recall with an R10 boundary-scan fix (#221).
- **Advisory CI reviewer + evidence:** an in-repo **MiniMax-M3 two-lane** PR reviewer (a defect
  lane and an adversarial-claims lane) with `REVIEW.md` as the canonical reviewer law (#263); signed
  gate-result evidence emitted for the labs dashboard (#252); a `changelog-updated` dispatch to the
  umbrella on merge (#250); a repo-tailored `.greptile` config (#232); and `SUPPORT.md` (#244).
- **`scripts/bbb-qmd`** — operator wrapper that runs the pinned `@tobilu/qmd` against the team brain
  index (`~/.teamkb/qmd-index/<tenant>` via XDG), not personal `~/.cache/qmd`. `pnpm bbb-qmd --which`
  shows binary + version + tenant paths. Ride Tobi's releases via Dependabot pin; do not fork qmd.
- **Operator runbook** `000-docs/042-OD-OPSM-bbb-qmd-operator-runbook.md` and **onboarding Q-bank**
  `000-docs/043-OD-EVAL-onboarding-qbank-v1.md` for day-1 retrieval regression scoring.
- **Search canary** expanded with SOPS / beads / Contabo VPS known-positive controls (fail loud if
  estate themes disappear from the index).
- **`pnpm eval:onboarding`** (`scripts/eval-onboarding-qbank.sh`) — day-1 outsider keyword probes via
  `bbb-qmd`; exit 0 at ≥80% (baseline after day-1 pack: **23/24**).
- **B1 auto-govern primitives** (`packages/store` + `packages/curator`) — a **marker-based** inbox:
  `CandidateStatus` widened so insert-only `candidates` are retired by a terminal status change,
  **never deleted** (the review queue + only copy is preserved), plus tenant-scoped content-hash
  dedup and spool archiving. The deterministic foundation for governing the remote-capture inbox.
  (jfv.2.1, #236)

### Changed

- **Ontology write-path hardening (epic `5bm`), so the governed store can't be enum-smuggled.**
  `assertMemoryEnumMembership` now guards `category` / `trust_level` / `sensitivity` / `lifecycle` /
  `source` / `author.type` at the top of `MemoryRepository.insert` and `update` (previously only
  read-time schema validation stood between a raw caller and a disclosure-shaped string in an enum
  column), plus row-level CHECK constraints on the new-DB DDL (#265); migration **v9** backfills
  those CHECK constraints onto the live legacy `curated_memories` table via a fail-closed, in-place
  rebuild with zero blast radius on fresh DBs (#277). The promoter now persists the **classified**
  sensitivity from the deterministic content classifier instead of hardcoding `internal` — which had
  made the exporter's confidential/restricted skip dead code (#267). `updateLifecycle` now rejects
  transitions the lifecycle state graph forbids (#268). The spool `MemoryCandidate` carries a
  validated `schemaVersion` so a future ICO v2 line is rejected, not silently downgraded to v1 (#271).
- **Dependabot: hold `typescript` at its current major.** Added `typescript` semver-major to the
  ignore list (alongside `dependency-cruiser` and `@eslint/js`): the dev-dependencies group tried to
  bump `typescript` 5.x → **7.0.2** — the native/preview compiler — which crashes `@typescript-eslint`
  and broke the `validate` Lint gate. Held back until the lint/tsx toolchain supports TS 7.
- **Merged the batched dependency-group updates** (#234 dev-deps, #235 prod-deps): 13 dev-dep bumps
  landed (vitest, knip, prettier 3.9.5, testcontainers, tsx, `@intentsolutions/audit-harness`, …)
  with `typescript` held at 5.x; reformatted one test file for prettier 3.9.5.
- Ignore `.worktrees/` (local Agent-isolation worktree checkouts).

### Fixed

- **Candidate intake: id-first idempotency + created vs already_exists knowledge.**
  `CandidateService.intake` now short-circuits on existing **id** (same tenant) before content-hash
  dedup, so session-stable client ids collapse re-distilled retries. Returns
  `{ candidate, intake: 'created' | 'already_exists' }`; `POST /api/candidates` responds **201** +
  `intake: created` or **200** + `intake: already_exists`. Skips a second `proposed` receipt on
  collapse. Closes the Property 1/2 seam called out in the fire-and-forget writer review (#249).
- **git-exporter fails closed on an unmapped category** instead of laundering it into the
  governance-approved `curated/` bucket (#269), with the category→directory mapper locked to the
  schema enum (#270); a single malformed memory is now **quarantined and reported** rather than
  aborting the whole export run (#276).
- **Retrieval reliability:** idempotent qmd reindex + a search-health canary to end silent 0-hit
  degradation (#220).
- **Honest audit-chain verify:** sequence-ordering + `CHAIN_FORK` classification (#212); a byte-pinned
  exception manifest + 3-state audit-break classifier (#214); provenance-integrity now passes on
  no-tampering and discloses benign forks (#215).
- **Govern precision:** gate the heroku UUID rule + converge the PII vocab to raise precision (#224).
- **repo-resolver:** classify git "dubious ownership" as `NotAGitRepo` (#213).

### Security

- **Read-time sensitivity enforcement — confidential/restricted memories are never returned on any
  search path.** The git-exporter already skipped them from the qmd index at write time, but the API
  SQLite fallback and the MCP local-mode path still returned raw `curated_memories` rows; a
  default-exclude read filter closes that leak (#275).
- **Closed two secret-scan evasions the govern-eval measured** — split-newline and base64-wrapped
  keys — so a smuggled credential no longer slips the disclosure gate (#222).

## [0.7.0] - 2026-06-19

### Added

- **Retrieval backend foundations (epic `0t9`).** A native FTS5 (BM25) keyword backend that drops the external qmd binary for keyword search (#192); a backend-agnostic Recall@10 / nDCG@10 eval harness that gates BM25 against a future semantic path (#191); and SHA-256-pinned, fail-closed retrieval-model weight verification (#190). Decision of record: ship BM25 now, eval-gate a lean native sqlite-vec (EmbeddingGemma-300M) semantic path; skip qmd's heavy hybrid. See ADR `000-docs/038-AT-DECR`.
- **External anchor log for the audit chain** — detects silent full-chain rewrites that a local re-hash would otherwise hide (#187).
- **Audit-events hash chain + `verify-audit-chain` CLI** (#154), with spool-manifest SHA-256 verification on ingest and quarantine of tampered files (#156).
- **`curator-cli`** — the ingest → policy → promote governance pipeline as a CLI (#153); optional `evalCallback` wired into `promote()` emitting eval-result events (#168).
- **QMD functional eval surface** — three evaluators (#167) plus an eval-result audit action (#166).
- **`exporter-cli` + real-qmd integration** for demo stages 5-6 (#158).
- **Weekly cited-query count per-teammate report** (#186).
- **Plugin + MCP surface** — a self-contained marketplace MCP client (install-once, no build); the `intent-brain` plugin with `/brain` + `/brain-promote` skills; a `teamkb_search` MCP tool with a `TEAMKB_API_URL` hosting flip; qmd wired into search for `qmd://` citations.
- **Per-user auth** — per-user tokens, an admin-only write gate, and a per-read access audit.
- **Quickstart** — qmd indexing + curated-answer query; full compile when `ANTHROPIC_API_KEY` is set.

### Changed

- **Relicensed to Apache-2.0** and added the `@intentsolutions/core` dependency (#166).
- **qmd tracked as a pinned devDependency** for controlled auto-bump (#161); bumped to qmd 2.5.3.
- Refactored `edge-daemon` `runCycle` into phases and tightened the CRAP complexity gate 40 → 30 (#157).
- Grouped the Dependabot config (dev / production / github-actions) and merged a batch of dependency updates.

### Fixed

- Soft-fail the Codecov upload on Dependabot PRs — secrets are withheld from Dependabot runs, so the token-less upload was failing every dependency-update PR (#193).
- Install qmd in CI so the qmd-gated integration tests actually run (#160).
- Bridge the git-exporter layout to qmd collections (#159).
- Correct the compile-then-govern URL to the `intent-solutions-io` org.

### Security

- **Tenant-scope the audit read API** — closes a cross-tenant audit-log leak (#169).

## [0.6.0] - 2026-05-15

### Security

- **Cleared 6 high-severity dev-tooling CVEs.** `pnpm.overrides` block pins `picomatch@2: ^2.3.2` (closes ReDoS via micromatch/fast-glob/knip path), `picomatch@4: ^4.0.4` (closes ReDoS in newer path via vite/fdir), `fast-uri: ^3.1.2` (closes path traversal + host confusion via ajv/Stryker). Direct `vite: ^7.3.2` devDep added to pull patched vite for vitest peer (closes `server.fs.deny` bypass + arbitrary file read via dev server). `pnpm audit --audit-level=high` is now clean.

### Added

- **Intent Solutions Testing SOP — Batch 1** (PR #126): `tests/TESTING.md` policy file, `tests/RTM.md` requirements traceability matrix seed, husky + lint-staged pre-commit hooks, vitest coverage thresholds (line 80, branch 70, function 75), Stryker mutation testing config, Semgrep SAST job, CLAUDE.md Testing SOP section. Closes GH #90/#91/#92/#93/#94/#97.
- **Intent Solutions Testing SOP — Batch 2**: dependency-cruiser monorepo architecture rules (`.dependency-cruiser.cjs`) enforced in CI via `pnpm depcruise`. Encodes 6 invariants from `000-docs/003-AT-DSGN-system-thesis.md` as machine-verifiable import-graph rules: packages must not depend on apps; no cross-app imports except apps/curator (which publishes a workspace package); no circular deps; test-fixtures may only be imported by tests; no dist/ imports; all imports must resolve. Closes GH #95.
- **Real gitleaks secret scanning** via `gitleaks-action@v2` on every PR — replaces the prior homegrown `git grep` regex scanner that only fired on PRs touching `package.json`/`pnpm-lock.yaml`. Closes GH #96.
- **Intent Solutions Testing SOP — Batch 3**: `tests/PERSONAS.md` declares the 6 distinct user roles the system serves (developer, curator, org-admin, auditor, operator, bot-agent) with 23 key flows and critical-tier marking. `tests/JOURNEYS.md` declares 6 end-to-end user flows (memory-capture, memory-retrieval, vault-import, policy-update, audit-verification, wiki-link-resolution) with 43 step-by-step mappings. `tests/TESTING.md` §Traceability updated to reflect new artifacts. Test-to-persona / step-to-test linking infrastructure deferred to a follow-up pass (annotation convention TBD). Closes GH #99.
- **Intent Solutions Testing SOP — Batch 4**: `scripts/crap-score.ts` — TypeScript-AST-aware cyclomatic complexity scanner (ports CCSC's reference implementation, adapted for the monorepo to walk `packages/*/src` + `apps/*/src`). Wired to CI as a new `Complexity gate (CRAP / Wall 5)` step. Initial threshold 40 with 4 points of headroom over the current ceiling (`apps/edge-daemon` `runCycle` at 36) — tightening to the Wall 5 ideal of 30 tracked in `qmd-team-intent-kb-igs` (refactor `runCycle` first). Added `tsx` as a root devDep to run the script. Closes GH #100.
- **Intent Solutions Testing SOP — Batch 5**: testcontainers infrastructure for L4 integration tests. After a survey of every L4 surface (per `tests/TESTING.md` §"L4 — partial waiver"), no current code path requires a real-service container — but the audit explicitly tracked the gap and Batch 5 establishes the pattern. Adds `testcontainers` + `@testcontainers/postgresql` + `pg` devDeps. Ships one demonstrative test (`tests/integration/postgres-forward-compat.test.ts`): spins up `postgres:16-alpine`, applies the store DDL (with documented SQLite→postgres translation), round-trips a candidate row, verifies PRIMARY KEY uniqueness, sanity-checks the tenant index — surfaces dialect-specific SQL early. Separate `integration` CI job that fires on push to main and on PRs labeled `integration` — does NOT slow the fast `validate` loop. Three documented trigger conditions for expanding L4 coverage are tracked in `qmd-team-intent-kb-2r6` (P3). Closes GH #98.
- **Intent Solutions Testing SOP — Batch 6**: contract testing via OpenAPI snapshot, replacing the generic Pact recommendation that doesn't fit this monorepo's shape (no internal service-to-service HTTP boundary; no external consumer code yet). Ships `apps/api/src/__tests__/openapi-contract.test.ts` — boots `apps/api` in-process, fetches `GET /openapi.json`, snapshot-tests the structural surface (paths × methods, schema names, security schemes, tag names). Any unintentional API surface change fails CI until a contributor explicitly runs `pnpm vitest --update-snapshots` and the diff becomes a code-review signal. Forward trigger to install actual Pact (`@pact-foundation/pact`) tracked in `qmd-team-intent-kb-4zw` (P3) — fires when an external consumer repo is created and deployed independently from `apps/api` with a different release cadence. Closes GH #101.
- **Intent Solutions Testing SOP — Batch 7 (closing pin)**: `scripts/harness-pin.sh` + committed `.harness-hash`. SHA-256 manifest of every engineer-owned policy artifact in the repo (`tests/TESTING.md`, `tests/RTM.md`, `tests/PERSONAS.md`, `tests/JOURNEYS.md`, `.dependency-cruiser.cjs`, `stryker.config.mjs`, `vitest.config.ts`, `scripts/crap-score.ts`). New CI step `Policy-artifact hash pin (harness-pin --verify)` fails on any unrecognized policy-byte change. AI agents can update observational sections freely but cannot silently change policy without engineer-initiated re-pin (`pnpm harness-pin:init`). Repo-local script encodes the right pin set; upstream pattern-configurability tracked in `qmd-team-intent-kb-tpp` (P3). Closes GH #102. **All 14 audit-tests issues from the 2026-04-24 audit are now closed.**

### Changed

- **`.github/workflows/security.yml`** broadened: gitleaks runs on every PR (secrets can land in any file). `audit` + `lockfile-integrity` jobs continue to gate dep-touching PRs only (their narrow scope is intentional).
- **`.github/workflows/ci.yml`**: new `Architecture rules (dependency-cruiser)` step between `Type check` and `Test`.

### Fixed

- **`apps/api/tsconfig.json` + `apps/mcp-server/tsconfig.json`**: added the missing `{ "path": "../curator" }` project reference. Both apps import from `@qmd-team-intent-kb/curator` (an `apps/curator`-exported workspace package) but lacked the project reference, so clean CI builds failed with `TS2307: Cannot find module '@qmd-team-intent-kb/curator'`. Local builds masked the issue via composite-build cache. This had been the root cause of CI redness on main since the 2026-04-16 v0.5.0 wiki-link PR introduced the imports.
- **`package.json` `pnpm.onlyBuiltDependencies`**: added `better-sqlite3`, `esbuild`, `husky` so that pnpm 9's build-script security model allows the native bindings to compile on clean install. Without this, 451 of 1,312 tests fail with "Could not locate the bindings file" on every fresh clone.

## [0.5.0] - 2026-04-16

### Added

- **Knowledge Graph**: `memory_links` table with 5 link types (relates_to, supersedes, contradicts, depends_on, part_of), bidirectional neighbor queries, and recursive CTE graph traversal up to configurable depth.
- **Import Batches**: `import_batches` table for batch lifecycle tracking (active → completed | rolled_back) with file/created/rejected/skipped counts.
- **Vault Import Pipeline**: Recursive Markdown directory walker with `.obsidian/`, `.trash/`, `.git/` exclusion; YAML frontmatter parser (title, category, tags); content hash collision detection against curated memories, candidates, and intra-batch duplicates; batch-tracked candidate creation; rollback capability.
- **Import API Routes**: `POST /api/import/preview` (dry-run), `POST /api/import` (execute), `GET /api/import/batches` (list), `GET /api/import/batches/:id` (detail), `DELETE /api/import/batches/:id` (rollback).
- **Graph Traversal API**: `GET /api/memories/:id/neighbors` (bidirectional links), `GET /api/memories/:id/graph?depth=N` (recursive traversal, max depth 5).
- **Wiki-Link Resolution**: Parser for `[[slug]]` and `[[slug|display]]` syntax with code-block awareness. Write-path: auto-creates `relates_to` graph edges during promotion. Read-path: `?resolve_links=true` query param on memory GET rewrites links to API URLs.
- **MCP Tools**: `teamkb_vault_preview`, `teamkb_vault_import`, `teamkb_vault_rollback` for Obsidian vault import; `teamkb_neighbors` for graph exploration.
- **Schema Enums**: `LinkType`, `LinkSource`, `ImportBatchStatus` for graph and import domain model.
- **Repositories**: `MemoryLinksRepository` (CRUD + neighbors + traverse), `ImportBatchRepository` (CRUD + updateCounts + complete + rollback).
- **Curator Supersession Edges**: Promoter persists `supersedes` graph edges with Jaccard similarity weight when `MemoryLinksRepository` is provided.
- **Git Exporter**: `formatMemoryAsMarkdown` accepts optional `LinkResolver` callback for wiki-link resolution on export.
- Import conversion recipes documentation (`000-docs/030-DR-GUID-import-conversion-recipes.md`) covering Obsidian, Notion, Google Docs, Confluence, and pandoc workflows.

### Changed

- **Zod 4 Migration**: `packages/schema` and `packages/repo-resolver` migrated from zod@3 to zod@4. Fixed `z.record(z.unknown())` → `z.record(z.string(), z.unknown())` and nested `.default({})` explicit full defaults for Zod 4 compatibility.
- **MCP Server**: Removed inline enum workarounds — now imports `MemoryCategory` and `MemoryLifecycleState` directly from schema package.
- `CandidateRepository.insert()` accepts optional `importBatchId` for batch association.
- `CandidateRepository.deleteByBatch()` enables batch rollback.

### Fixed

- `MemoryLinksRepository.traverse()` uses `ROW_NUMBER` window function for deterministic results when multiple paths to the same node exist.

## [0.4.0] - 2026-04-15

### Added

- `apps/api`: generated OpenAPI 3.1 spec served at `GET /openapi.json` and Swagger UI at `GET /docs`, powered by `@fastify/swagger` + `@fastify/swagger-ui`. Routes declare minimal schema metadata (tags, summary, description) for navigable documentation. The spec and docs UI are exempt from API key authentication so they stay publicly reachable.
- npm publishing configuration for reusable library packages (`@qmd-team-intent-kb/schema`, `@qmd-team-intent-kb/common`, `@qmd-team-intent-kb/repo-resolver`) — `publishConfig.access = public`, `files` allowlist, and minimal package READMEs. Internal-only packages (`store`, `qmd-adapter`, `claude-runtime`, `test-fixtures`, `policy-engine`) remain `private: true`. Strategy documented in `000-docs/029-OD-RELS-npm-publishing-strategy.md`.
- `apps/edge-daemon`: configurable health-server bind host via `DAEMON_HEALTH_HOST` environment variable. Defaults to `127.0.0.1` for security; set to `0.0.0.0` for container deployments.
- `apps/edge-daemon`: repo-scope filtering now surfaces `unscoped` candidate count for operator visibility when candidates bypass scoping.

### Changed

- Consolidated shared test fixture factories (`makeCandidate`, `makeMemory`, `RecordingLogger`) into `@qmd-team-intent-kb/test-fixtures` package. All test files now import from the shared package.
- Removed unused code paths identified by knip sweep, including vestigial logger implementations and weak type casts.
- Schema tests refactored to use rest-destructure pattern instead of `as Record<string, unknown>` delete pattern.
- Store repositories now validate on read with Zod instead of type casts.
- Upgraded `actions/checkout` to v6, `pino` to v10.3.1, `prettier` to v3.8.3.

### Fixed

- `apps/edge-daemon`: health-server start now properly awaited during `stop()` to prevent resource leaks.
- `apps/edge-daemon`: systemd unit override now correctly configures spool and PID paths to `/var/lib/edge-daemon`.
- `apps/edge-daemon`: `pino-pretty` moved from `devDependencies` to `dependencies` for production logging.
- `000-docs`: runbook Health Check section now documents `/healthz` and `/last-cycle` endpoints.
- `.github/workflows`: Gemini review prompt and MCP server configuration restored after accidental removal.

### Security

- Release workflow now builds, pushes, and signs the edge-daemon container image on tag pushes. Images are published to `ghcr.io/jeremylongshore/qmd-team-intent-kb-edge-daemon`, signed keyless via `cosign` using GitHub Actions OIDC (Rekor transparency log), and accompanied by SLSA Level 3 build provenance generated by `slsa-github-generator`. Verification procedure documented in `000-docs/028-OD-SECU-release-signing.md`. (Repo renamed 2026-07-19 to `jeremylongshore/bobs-big-brain-registrar`: the cosign `--certificate-identity-regexp` must use the new slug for post-rename releases; the GHCR image name intentionally keeps the historical slug.)

## [0.3.0] - 2026-03-19

### Added

- MCP server (`apps/mcp-server`) with 5 tools: `teamkb_propose`, `teamkb_import`, `teamkb_status`, `teamkb_transition`, `teamkb_sync`
- Claude Code plugin packaging: `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`
- SessionStart hook (`scripts/bootstrap.sh`) for database initialization and qmd collection setup
- Stop hook (`scripts/flush-spool.sh`) for end-of-session spool draining
- TeamKB skill definition (`skills/teamkb/SKILL.md`) for ambient capture guidance
- 4 subagent definitions: `teamkb-curator`, `teamkb-classifier`, `teamkb-conflict-checker`, `teamkb-scout`
- Rejection feedback channel (`apps/edge-daemon/src/feedback.ts`) for governance learning
- FTS5 virtual table for full-text search with ranked results
- Schema migrations framework (`packages/store`) with `schema_migrations` table
- Intra-batch deduplication in curator pipeline
- Path traversal validation in spool writer and git exporter
- Per-agent spool files for multi-agent concurrency

### Fixed

- Node 20 compatibility using fast-glob instead of node:fs/promises glob (requires Node 22)
- Timing-safe API key comparison with `crypto.timingSafeEqual`
- Fail-closed authentication in production mode
- LIKE wildcard escaping (`%`, `_`, `\`) in SQL text search
- Shutdown handler exits with non-zero code on failure

### Security

- File permissions 0700 on `~/.teamkb/` directory
- `busy_timeout = 5000` pragma for WAL mode concurrency
- `--` argument separator for qmd CLI commands

---

## [0.2.0] - 2026-03-19

### Added

- Search API endpoint (`POST /api/search`) with freshness-aware reranking combining raw scores with exponential time decay and category boost
- Edge daemon (`apps/edge-daemon`) with full implementation: local spool watch, curation cycle, staleness sweep, index sync, PID locking, graceful shutdown
- Staleness automation — auto-deprecate active memories older than configurable `staleDays` threshold with audit trail
- Freshness scoring utilities (`packages/common`) with exponential decay, category boost weights, and generic reranking function
- SQL text search on MemoryRepository with LIKE-based query, tenant/category filters, active-only scope
- Graduated relevance scoring in policy engine: content length tiers, unique word count signal, manual/import source bonus

### Changed

- Relevance score rule now uses graduated weights: title (+0.20), content 50-200 chars (+0.10), content >200 chars (+0.20), unique words >15 (+0.10), manual/import source (+0.10)
- Upgraded Vitest to v4.1, ESLint to v10, Zod to v4, @types/node to v25
- Added `vitest.config.ts` for explicit test file discovery

### Fixed

- TypeScript project references now properly configured across all packages

---

## [0.1.0] - 2026-03-19

### Added

- API middleware stack: rate-limiter (sliding window), API key authentication, input sanitizer with recursive traversal (Phase 8, 76 tests)
- Content classifier with sensitivity-gate and content-sanitization policy rules (Phase 8)
- Export gating — git-exporter respects sensitivity classification (Phase 8)
- Path-safety utilities in common package with traversal and null-byte detection (Phase 8)
- Reporting app with lifecycle analytics: memory aggregator, policy aggregator, lifecycle formatters (Phase 7, 53 tests)
- Git exporter with incremental Markdown export, YAML frontmatter, category-based directory mapping, and idempotent writes (Phase 6, 76 tests)
- Curator engine with full promotion pipeline: spool intake, exact-hash dedup, policy evaluation, Jaccard supersession detection, dry-run mode (Phase 5, 79 tests)
- Control plane REST API with Fastify: candidate intake, memory lifecycle transitions, policy CRUD, audit trail, health check (Phase 4C, 62 tests)
- SQLite persistence layer (`packages/store`) with better-sqlite3, WAL mode, 5 repositories, in-memory testing (Phase 4B, 38 tests)
- Policy engine with 6 deterministic rule evaluators and short-circuit pipeline: secret detection, content length, source trust, relevance score, dedup check, tenant match (Phase 4A, 54 tests)
- Release workflow with dispatch trigger, tag trigger, changelog validation, and placeholder detection
- Security workflow with weekly npm audit, lockfile integrity check, and secret scanning
- Nightly workflow with full validation, dependency audit, and outdated dependency check
- Test artifact upload in CI workflow for post-run analysis
- `build` script in root package.json (`tsc -b`)
- Issue template config linking blank issues to GitHub Discussions
- Branch protection checklist doc (016-OD-OPSM)
- qmd adapter with curated-only default search, 5 collection types, and index isolation per tenant
- Real qmd CLI integration with RealQmdExecutor and health check
- Claude runtime capture layer with local JSONL spool, secret detection (11 patterns), and content redaction
- Shared utilities: Result<T, E> type, SHA-256 content hashing, TeamKB path resolution
- Shell hook templates and CLAUDE.md guidance block generators
- Core domain model with Zod schemas for MemoryCandidate, CuratedMemory, GovernancePolicy, SearchQuery/Result, and AuditEvent
- Lifecycle state machine with transition validation (active, deprecated, superseded, archived)
- Shared primitive types (UUID, SHA-256 hash, ISO datetime, Author, ContentMetadata)
- 12 enum definitions covering memory source, trust level, category, and governance actions
- SearchScope defaults to curated-only, enforcing governed search behavior
- CuratedMemory refinement requiring supersession link when lifecycle is superseded
- 225 schema tests covering valid/invalid inputs, defaults, and edge cases
- Monorepo scaffolding with pnpm workspaces (apps/, packages/, kb-export/, tests/, scripts/, examples/)
- Architecture documentation and system thesis (000-docs/001-repo-blueprint)
- Security policy with project-specific threat model covering memory integrity, MCP risk, and tenant isolation
- Contribution guidelines with commit conventions, PR expectations, and review process
- CI pipeline with lint, format check, type check, and test validation via GitHub Actions
- Gemini code review via Workload Identity Federation on pull requests
- 12-document knowledge base in 000-docs/
- Release and versioning policy following Semantic Versioning
- Beads task tracking initialization with 10 epics spanning foundation through enterprise features
