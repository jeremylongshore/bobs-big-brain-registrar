/**
 * groundedness labeled fixture — v1 (Wave-2 C2).
 *
 * 60 labeled (claim, memory-excerpt) pairs derived from 30 REAL promoted
 * memories in the live brain's kb-export (innocuous technical/architectural
 * memories only — anything credential- or person-shaped was excluded at
 * selection time). Each memory yields:
 *   - one SUPPORTED claim   — a paraphrase of what the excerpt says;
 *   - one UNSUPPORTED claim — plausible but NOT in the excerpt (an inverted
 *     number, a wrong component, a flipped negation, a swapped argument, or
 *     an overreach), each tagged with its `perturbation`.
 *
 * ## Provenance — semi-synthetic-from-real, stated honestly
 *
 * Excerpts are verbatim memory text (`sourceMemoryId` = the export UUID);
 * claims are authored synthetically for this fixture, so labels are
 * by-construction ground truth. Because the same author wrote the claims and
 * tuned scorer v1's thresholds on this set, the reported metrics are
 * IN-SAMPLE fit — a held-out set is future work (see the module doc).
 *
 * `knownScorerMiss: true` marks items scorer v1 is EMPIRICALLY CONFIRMED to
 * get wrong today (chiefly argument swaps, which preserve the token set) —
 * documented limitations, reported not hidden. An UNDOCUMENTED wrong
 * prediction fails the eval closed.
 *
 * FIXTURE_VERSION is bumped on any item add/remove/relabel.
 */

import type { GroundednessItem } from '../../types.js';

/** Semantic version of THIS fixture. Bump on any change to the item set. */
export const FIXTURE_VERSION = '1.0.0';

export const GROUNDEDNESS_ITEMS: readonly GroundednessItem[] = [
  /* ---------------- 00c95f4e — Confused Deputy Problem -------------------- */
  {
    id: 'grd-confused-deputy-sup',
    sourceMemoryId: '00c95f4e-e1ee-51ad-9331-3aefd68a1629',
    memoryExcerpt:
      'The confused deputy problem in MCP occurs when servers act as authentication proxies between clients and third-party services. Prevention of confused deputy attacks requires OAuth 2.1 with PKCE (Proof Key for Code Exchange) for all authorization requests, state parameter validation, and strict redirect URI validation.',
    claim:
      'Preventing confused deputy attacks in MCP requires OAuth 2.1 with PKCE, state parameter validation, and strict redirect URI validation.',
    label: 'supported',
  },
  {
    id: 'grd-confused-deputy-unsup',
    sourceMemoryId: '00c95f4e-e1ee-51ad-9331-3aefd68a1629',
    memoryExcerpt:
      'The confused deputy problem in MCP occurs when servers act as authentication proxies between clients and third-party services. Prevention of confused deputy attacks requires OAuth 2.1 with PKCE (Proof Key for Code Exchange) for all authorization requests, state parameter validation, and strict redirect URI validation.',
    claim:
      'Preventing confused deputy attacks in MCP requires SAML assertions and mutual TLS between the client and the proxy gateway.',
    label: 'unsupported',
    perturbation: 'wrong-component',
  },

  /* ---------------- 010e0d4e — mutable global registry -------------------- */
  {
    id: 'grd-mutable-registry-sup',
    sourceMemoryId: '010e0d4e-7ac7-52a8-8f2b-b257999ac689',
    memoryExcerpt:
      'A mutable global registry is a software design anti-pattern where module-level constants or maps are mutated at runtime, causing shared state corruption across tenants in multi-tenant systems. This pattern causes three failure modes: multi-tenant pollution, test isolation failure, and race conditions. The fix is to make data instance-owned rather than module-owned.',
    claim:
      'The mutable global registry anti-pattern causes three failure modes — including multi-tenant pollution and race conditions — and the fix is making data instance-owned.',
    label: 'supported',
  },
  {
    id: 'grd-mutable-registry-unsup',
    sourceMemoryId: '010e0d4e-7ac7-52a8-8f2b-b257999ac689',
    memoryExcerpt:
      'A mutable global registry is a software design anti-pattern where module-level constants or maps are mutated at runtime, causing shared state corruption across tenants in multi-tenant systems. This pattern causes three failure modes: multi-tenant pollution, test isolation failure, and race conditions. The fix is to make data instance-owned rather than module-owned.',
    claim:
      'The mutable global registry anti-pattern causes five failure modes and is fixed by freezing the module-level maps at startup.',
    label: 'unsupported',
    perturbation: 'inverted-number',
  },

  /* ---------------- 0532995b — Multi-Tenancy (RLS) ------------------------ */
  {
    id: 'grd-multitenancy-sup',
    sourceMemoryId: '0532995b-5f7b-52f4-9742-a52ddd7988d5',
    memoryExcerpt:
      'Multi-tenancy in MCP server architecture uses a shared database, shared schema model where data isolation is enforced through Row Level Security (RLS). The schema includes a stores table as a master tenant registry, with all tenant tables enforcing RLS by store_id.',
    claim:
      'Tenants share one database and schema, with data isolation enforced through Row Level Security keyed by store_id.',
    label: 'supported',
  },
  {
    id: 'grd-multitenancy-unsup',
    sourceMemoryId: '0532995b-5f7b-52f4-9742-a52ddd7988d5',
    memoryExcerpt:
      'Multi-tenancy in MCP server architecture uses a shared database, shared schema model where data isolation is enforced through Row Level Security (RLS). The schema includes a stores table as a master tenant registry, with all tenant tables enforcing RLS by store_id.',
    claim:
      'Each tenant gets its own dedicated database, with isolation enforced at the connection pool layer.',
    label: 'unsupported',
    perturbation: 'wrong-component',
  },

  /* ---------------- 05e16ec4 — Self-eval metrics must be able to fail ----- */
  {
    id: 'grd-selfeval-sup',
    sourceMemoryId: '05e16ec4-cc15-5afe-8c7b-caee7d25c98c',
    memoryExcerpt:
      'recall@k and citation-coverage were tautological because k >= corpus size, so everything retrieved scored 1.0 (fix: golden cases carry topical distractors with the relevant doc placed LAST, past position k, so the score is earned by ranking); a groundedness metric used skip-on-error, turning a fully-broken pipeline into a PASS (fix: exceptions score 0.0, only a truly-empty applicable set passes).',
    claim:
      'recall@k was tautological because k was at least the corpus size, and the fix was golden cases carrying topical distractors with the relevant doc placed last.',
    label: 'supported',
  },
  {
    id: 'grd-selfeval-unsup',
    sourceMemoryId: '05e16ec4-cc15-5afe-8c7b-caee7d25c98c',
    memoryExcerpt:
      'recall@k and citation-coverage were tautological because k >= corpus size, so everything retrieved scored 1.0 (fix: golden cases carry topical distractors with the relevant doc placed LAST, past position k, so the score is earned by ranking); a groundedness metric used skip-on-error, turning a fully-broken pipeline into a PASS (fix: exceptions score 0.0, only a truly-empty applicable set passes).',
    claim:
      'A groundedness metric that skips on error is safe because a fully-broken pipeline can never reach a PASS.',
    label: 'unsupported',
    perturbation: 'negation-flip',
    // The flipped term ("PASS") sits three tokens after the negation marker,
    // beyond scorer v1's window-1 scope, and the claim's vocabulary stays
    // inside the memory's — a documented distant-negation limitation.
    knownScorerMiss: true,
  },

  /* ---------------- 081bce4f — Compile-Then-Govern Architecture ----------- */
  {
    id: 'grd-compile-govern-sup',
    sourceMemoryId: '081bce4f-1801-539d-a852-add50f441e50',
    memoryExcerpt:
      'The compilation layer (ICO) transforms raw corpus into durable, human-readable, frontmatter-typed knowledge files through six deterministic passes: summarise, extract, synthesise, contradict, gap, and link. The two layers communicate through a file system spool boundary, which provides crash safety, inspectability, independent release cadence, and an auditable hand-off.',
    claim:
      'The compilation layer runs six deterministic passes and hands off to governance through a file system spool boundary.',
    label: 'supported',
  },
  {
    id: 'grd-compile-govern-unsup',
    sourceMemoryId: '081bce4f-1801-539d-a852-add50f441e50',
    memoryExcerpt:
      'The compilation layer (ICO) transforms raw corpus into durable, human-readable, frontmatter-typed knowledge files through six deterministic passes: summarise, extract, synthesise, contradict, gap, and link. The two layers communicate through a file system spool boundary, which provides crash safety, inspectability, independent release cadence, and an auditable hand-off.',
    claim:
      'The compilation layer runs four deterministic passes and hands off to governance through a message queue.',
    label: 'unsupported',
    perturbation: 'inverted-number',
  },

  /* ---------------- 08909f28 — Consecutive-Failure Escalation ------------- */
  {
    id: 'grd-failure-escalation-sup',
    sourceMemoryId: '08909f28-291a-5d1b-a867-030f09f6fc03',
    memoryExcerpt:
      'Consecutive-failure escalation is a monitoring pattern that increases the priority of alerts as a streak of failures continues. It walks per-run logs and raises alert priority once a failure streak forms, ensuring that persistent failures become increasingly visible and are not ignored.',
    claim:
      'Consecutive-failure escalation raises alert priority as a failure streak continues, walking per-run logs so persistent failures stay visible.',
    label: 'supported',
  },
  {
    id: 'grd-failure-escalation-unsup',
    sourceMemoryId: '08909f28-291a-5d1b-a867-030f09f6fc03',
    memoryExcerpt:
      'Consecutive-failure escalation is a monitoring pattern that increases the priority of alerts as a streak of failures continues. It walks per-run logs and raises alert priority once a failure streak forms, ensuring that persistent failures become increasingly visible and are not ignored.',
    claim:
      'Consecutive-failure escalation lowers alert priority during a long failure streak to reduce paging fatigue for the on-call.',
    label: 'unsupported',
    perturbation: 'negation-flip',
  },

  /* ---------------- 098b3789 — Shared Prometheus Metrics Package ---------- */
  {
    id: 'grd-metrics-package-sup',
    sourceMemoryId: '098b3789-37d7-5566-9047-85deeaab471a',
    memoryExcerpt:
      'A shared Prometheus metrics package that standardizes label names, histogram buckets, and counter naming conventions across all services, eliminating inconsistencies that required per-service Grafana dashboard overrides. The package standardizes the /metrics endpoint configuration to port 9090 and path /metrics across all IRSB services.',
    claim:
      'The shared Prometheus metrics package standardizes label names and histogram buckets, and pins the metrics endpoint to port 9090.',
    label: 'supported',
  },
  {
    id: 'grd-metrics-package-unsup',
    sourceMemoryId: '098b3789-37d7-5566-9047-85deeaab471a',
    memoryExcerpt:
      'A shared Prometheus metrics package that standardizes label names, histogram buckets, and counter naming conventions across all services, eliminating inconsistencies that required per-service Grafana dashboard overrides. The package standardizes the /metrics endpoint configuration to port 9090 and path /metrics across all IRSB services.',
    claim:
      'The shared Prometheus metrics package pins the metrics endpoint to port 8080 across all services.',
    label: 'unsupported',
    perturbation: 'inverted-number',
  },

  /* ---------------- 0adb8484 — OAuth 2.0 ---------------------------------- */
  {
    id: 'grd-oauth-sup',
    sourceMemoryId: '0adb8484-ae02-5294-bf21-bc769d139e79',
    memoryExcerpt:
      'The Authorization Server issues JWT access tokens via the client_credentials flow, and the Resource Server secures endpoints. The choice between public and confidential client depends on deployment: local servers use public clients with brokers; remote servers use confidential clients with the Authorization Code Flow.',
    claim:
      'Local servers use public clients with brokers, while remote servers use confidential clients with the Authorization Code Flow.',
    label: 'supported',
  },
  {
    id: 'grd-oauth-unsup',
    sourceMemoryId: '0adb8484-ae02-5294-bf21-bc769d139e79',
    memoryExcerpt:
      'The Authorization Server issues JWT access tokens via the client_credentials flow, and the Resource Server secures endpoints. The choice between public and confidential client depends on deployment: local servers use public clients with brokers; remote servers use confidential clients with the Authorization Code Flow.',
    claim:
      'Local servers use confidential clients with the Authorization Code Flow, while remote servers use public clients with brokers.',
    label: 'unsupported',
    perturbation: 'argument-swap',
    knownScorerMiss: true, // token set identical to the supported claim — v1's admitted blind spot
  },

  /* ---------------- 0b25a9fc — Govern path stays LLM-free ----------------- */
  {
    id: 'grd-llm-free-sup',
    sourceMemoryId: '0b25a9fc-2802-5984-8256-d84d9fe7c8c9',
    memoryExcerpt:
      'Deterministic govern (promote, policy) must not import from packages named or framed as model runtime (e.g. claude-runtime), even when today’s classifyContent is pure sync regex. Prefer re-exporting pure classifiers through policy-engine (which already owns sensitivity-gate) and have the promoter depend on that re-export.',
    claim:
      'The deterministic govern path avoids importing model-runtime packages and instead re-exports pure classifiers through policy-engine.',
    label: 'supported',
  },
  {
    id: 'grd-llm-free-unsup',
    sourceMemoryId: '0b25a9fc-2802-5984-8256-d84d9fe7c8c9',
    memoryExcerpt:
      'Deterministic govern (promote, policy) must not import from packages named or framed as model runtime (e.g. claude-runtime), even when today’s classifyContent is pure sync regex. Prefer re-exporting pure classifiers through policy-engine (which already owns sensitivity-gate) and have the promoter depend on that re-export.',
    claim:
      'Because classifyContent is pure sync regex today, the govern path may import model-runtime packages directly.',
    label: 'unsupported',
    perturbation: 'negation-flip',
  },

  /* ---------------- 0d4a6119 — Search Adapter Pattern --------------------- */
  {
    id: 'grd-search-adapter-sup',
    sourceMemoryId: '0d4a6119-10c7-5c4c-838a-010951be2e36',
    memoryExcerpt:
      'FTS5 ships as default (zero dependencies). qmd is the upgrade path (proven at 18.2K stars). The interface is the contract, not the implementation. This pattern ensures that the search layer can be swapped or upgraded without modifying the core system.',
    claim:
      'FTS5 is the default search backend with zero dependencies, and qmd is the upgrade path; the interface is the contract.',
    label: 'supported',
  },
  {
    id: 'grd-search-adapter-unsup',
    sourceMemoryId: '0d4a6119-10c7-5c4c-838a-010951be2e36',
    memoryExcerpt:
      'FTS5 ships as default (zero dependencies). qmd is the upgrade path (proven at 18.2K stars). The interface is the contract, not the implementation. This pattern ensures that the search layer can be swapped or upgraded without modifying the core system.',
    claim: 'qmd is the upgrade path for the search layer, proven at 44K stars.',
    label: 'unsupported',
    perturbation: 'inverted-number',
  },

  /* ---------------- 0f6b344c — Dual-Layer CVE Clearance ------------------- */
  {
    id: 'grd-cve-clearance-sup',
    sourceMemoryId: '0f6b344c-66d4-50b3-9ce3-65fe11d0e91b',
    memoryExcerpt:
      'Bumping a direct dependency alone is insufficient to permanently clear transitive CVEs because package managers use semantic versioning ranges that can resolve to older, vulnerable versions on future clean installs. A top-level overrides block forces every transitive reference to resolve through pinned versions. Both moves are mandatory; neither alone is complete for permanent CVE clearance.',
    claim:
      'Permanently clearing a transitive CVE takes both the direct dependency bump and a top-level overrides block; neither alone is complete.',
    label: 'supported',
  },
  {
    id: 'grd-cve-clearance-unsup',
    sourceMemoryId: '0f6b344c-66d4-50b3-9ce3-65fe11d0e91b',
    memoryExcerpt:
      'Bumping a direct dependency alone is insufficient to permanently clear transitive CVEs because package managers use semantic versioning ranges that can resolve to older, vulnerable versions on future clean installs. A top-level overrides block forces every transitive reference to resolve through pinned versions. Both moves are mandatory; neither alone is complete for permanent CVE clearance.',
    claim:
      'Bumping the direct dependency alone is sufficient to permanently clear transitive CVEs, so an overrides block is redundant.',
    label: 'unsupported',
    perturbation: 'negation-flip',
  },

  /* ---------------- 104123f1 — An eval metric that cannot fail ------------ */
  {
    id: 'grd-metric-fail-sup',
    sourceMemoryId: '104123f1-bec3-5c82-a0ea-683e1f2ade1d',
    memoryExcerpt:
      'A groundedness metric that skips-on-error turns a broken pipeline into a PASS; it must score 0 on error instead. Also ensure the harness cannot vacuously pass with zero metrics and that provider-parity can actually fail.',
    claim:
      'A groundedness metric must score 0 on error, because skipping on error turns a broken pipeline into a PASS.',
    label: 'supported',
  },
  {
    id: 'grd-metric-fail-unsup',
    sourceMemoryId: '104123f1-bec3-5c82-a0ea-683e1f2ade1d',
    memoryExcerpt:
      'A groundedness metric that skips-on-error turns a broken pipeline into a PASS; it must score 0 on error instead. Also ensure the harness cannot vacuously pass with zero metrics and that provider-parity can actually fail.',
    claim:
      'recall@k becomes tautological when the corpus contains duplicate documents, and the fix is deduplicating before indexing.',
    label: 'unsupported',
    perturbation: 'wrong-component',
  },

  /* ---------------- 10876443 — Strict-Then-Broad Fallback ----------------- */
  {
    id: 'grd-strict-broad-sup',
    sourceMemoryId: '10876443-b467-592d-933d-e8cf3f93ae40',
    memoryExcerpt:
      'The system first attempts a strict AND query where all tokens must co-occur on a single page. If this returns no results, it falls back to a broad OR query with BM25 ranking, which naturally ranks pages with more token matches higher. After implementing the strict-then-broad fallback, the system achieved 5/5 question engagement with 28 citations.',
    claim:
      'Retrieval first tries a strict AND query and falls back to a broad OR query with BM25 ranking when the strict query returns no results.',
    label: 'supported',
  },
  {
    id: 'grd-strict-broad-unsup',
    sourceMemoryId: '10876443-b467-592d-933d-e8cf3f93ae40',
    memoryExcerpt:
      'The system first attempts a strict AND query where all tokens must co-occur on a single page. If this returns no results, it falls back to a broad OR query with BM25 ranking, which naturally ranks pages with more token matches higher. After implementing the strict-then-broad fallback, the system achieved 5/5 question engagement with 28 citations.',
    claim:
      'After the strict-then-broad fallback landed, the system achieved 3/5 question engagement with 12 citations.',
    label: 'unsupported',
    perturbation: 'inverted-number',
  },

  /* ---------------- 14ab3268 — Structured Output Over Model Choice -------- */
  {
    id: 'grd-structured-output-sup',
    sourceMemoryId: '14ab3268-3a72-54a2-a0ad-b6ca692018b3',
    memoryExcerpt:
      'Structured output (schema in, schema out) is more important than the specific LLM model choice for deterministic rendering. The prompt provides a fully-populated example schema, and the LLM returns schema-compliant JSON reliably on the first try, making the output deterministic enough to render.',
    claim:
      'For deterministic rendering, structured schema-in/schema-out output matters more than which LLM model is chosen.',
    label: 'supported',
  },
  {
    id: 'grd-structured-output-unsup',
    sourceMemoryId: '14ab3268-3a72-54a2-a0ad-b6ca692018b3',
    memoryExcerpt:
      'Structured output (schema in, schema out) is more important than the specific LLM model choice for deterministic rendering. The prompt provides a fully-populated example schema, and the LLM returns schema-compliant JSON reliably on the first try, making the output deterministic enough to render.',
    claim:
      'For deterministic rendering, the specific LLM model choice is more important than structured schema output.',
    label: 'unsupported',
    perturbation: 'argument-swap',
    knownScorerMiss: true, // swap preserves the token set — v1's admitted blind spot
  },

  /* ---------------- 15ec30ac — REFUSE/CHALLENGE/FLAG grading -------------- */
  {
    id: 'grd-scanner-grades-sup',
    sourceMemoryId: '15ec30ac-a3b1-5c52-ae8d-28c44c5168a3',
    memoryExcerpt:
      'The supply-chain scanner separates findings into three grades so a false-positive storm never pressures anyone to disable the gate: REFUSE (exit 2, always fails, NEVER waivable) is reserved for genuinely-malicious executable content; CHALLENGE (exit 1 unless waived) is dual-use, cleared only by a reviewed scan-allowlist.txt entry, never by weakening a pattern; FLAG (exit 0, report-only) is ubiquitous/noisy signal.',
    claim:
      'The scanner separates findings into three grades — REFUSE always fails and is never waivable, CHALLENGE clears only via a reviewed allowlist entry, and FLAG is report-only.',
    label: 'supported',
  },
  {
    id: 'grd-scanner-grades-unsup',
    sourceMemoryId: '15ec30ac-a3b1-5c52-ae8d-28c44c5168a3',
    memoryExcerpt:
      'The supply-chain scanner separates findings into three grades so a false-positive storm never pressures anyone to disable the gate: REFUSE (exit 2, always fails, NEVER waivable) is reserved for genuinely-malicious executable content; CHALLENGE (exit 1 unless waived) is dual-use, cleared only by a reviewed scan-allowlist.txt entry, never by weakening a pattern; FLAG (exit 0, report-only) is ubiquitous/noisy signal.',
    claim:
      'A REFUSE finding is waivable through a reviewed scan-allowlist.txt entry, just like a CHALLENGE.',
    label: 'unsupported',
    perturbation: 'negation-flip',
  },

  /* ---------------- 160333ca — A gate that can't evaluate must BLOCK ------ */
  {
    id: 'grd-gate-block-sup',
    sourceMemoryId: '160333ca-7623-50b6-ae36-725364c2ebe5',
    memoryExcerpt:
      'When a pattern was malformed grep exited 2, the error was invisible to set -e/the ERR trap, and the token silently never matched — a fail-OPEN where real leaks passed. The fix: if grep exits >= 2 (cannot evaluate), the gate BLOCKs with a gate-bug reason instead of reporting PASS.',
    claim:
      'If grep exits 2 or higher and the gate cannot evaluate its rule, the gate BLOCKs with a gate-bug reason instead of reporting PASS.',
    label: 'supported',
  },
  {
    id: 'grd-gate-block-unsup',
    sourceMemoryId: '160333ca-7623-50b6-ae36-725364c2ebe5',
    memoryExcerpt:
      'When a pattern was malformed grep exited 2, the error was invisible to set -e/the ERR trap, and the token silently never matched — a fail-OPEN where real leaks passed. The fix: if grep exits >= 2 (cannot evaluate), the gate BLOCKs with a gate-bug reason instead of reporting PASS.',
    claim:
      'If grep exits 2 or higher the gate reports PASS with a warning annotation so a malformed pattern is triaged asynchronously.',
    label: 'unsupported',
    perturbation: 'wrong-component',
  },

  /* ---------------- 16f60762 — Deterministic-First Architecture ----------- */
  {
    id: 'grd-deterministic-first-sup',
    sourceMemoryId: '16f60762-211a-5347-90c9-863e300de6f4',
    memoryExcerpt:
      'The PolicyPipeline composes 8 deterministic rules: secret-detection, content-length, source-trust, relevance-score, dedup-check, tenant-match, sensitivity-gate, and content-sanitization. The pipeline short-circuits on first failure, ensuring that only vetted content becomes part of the curated knowledge base.',
    claim:
      'The PolicyPipeline composes 8 deterministic rules — including secret-detection and dedup-check — and short-circuits on first failure.',
    label: 'supported',
  },
  {
    id: 'grd-deterministic-first-unsup',
    sourceMemoryId: '16f60762-211a-5347-90c9-863e300de6f4',
    memoryExcerpt:
      'The PolicyPipeline composes 8 deterministic rules: secret-detection, content-length, source-trust, relevance-score, dedup-check, tenant-match, sensitivity-gate, and content-sanitization. The pipeline short-circuits on first failure, ensuring that only vetted content becomes part of the curated knowledge base.',
    claim:
      'The PolicyPipeline composes 12 deterministic rules and always evaluates every rule before deciding.',
    label: 'unsupported',
    perturbation: 'inverted-number',
  },

  /* ---------------- 17242c90 — Keyless SHA-256 audit chain ---------------- */
  {
    id: 'grd-audit-chain-sup',
    sourceMemoryId: '17242c90-5922-51d8-b9bc-12b4f2cb558c',
    memoryExcerpt:
      'A bare hash-chained (keyless SHA-256) audit log gives NO tamper-evidence against an attacker with file-write access: they can shear events off the head, renumber survivors, and recompute every hash with no secret, and the file verifies clean. Real defenses: Ed25519-signed events, and out-of-band anchors that live OUTSIDE the file.',
    claim:
      'A keyless SHA-256 hash chain gives no tamper-evidence against an attacker with file-write access; real defenses are Ed25519-signed events and out-of-band anchors.',
    label: 'supported',
  },
  {
    id: 'grd-audit-chain-unsup',
    sourceMemoryId: '17242c90-5922-51d8-b9bc-12b4f2cb558c',
    memoryExcerpt:
      'A bare hash-chained (keyless SHA-256) audit log gives NO tamper-evidence against an attacker with file-write access: they can shear events off the head, renumber survivors, and recompute every hash with no secret, and the file verifies clean. Real defenses: Ed25519-signed events, and out-of-band anchors that live OUTSIDE the file.',
    claim:
      'A keyless SHA-256 hash chain by itself provides tamper-evidence against an attacker with file-write access.',
    label: 'unsupported',
    perturbation: 'negation-flip',
  },

  /* ---------------- 175fae90 — Structured Logging ------------------------- */
  {
    id: 'grd-structured-logging-sup',
    sourceMemoryId: '175fae90-9df8-51f4-b4b6-0785e3671a95',
    memoryExcerpt:
      'Structured logging is a method of logging that formats log records as structured data, such as JSON. This approach includes fields like timestamp, level, logger, message, module, function, line number, exception info, custom attributes, correlation ID, and user context. Structured logging with correlation IDs and user context enables effective troubleshooting.',
    claim:
      'Structured logging formats log records as structured data such as JSON, with fields like timestamp and correlation ID, enabling effective troubleshooting.',
    label: 'supported',
  },
  {
    id: 'grd-structured-logging-unsup',
    sourceMemoryId: '175fae90-9df8-51f4-b4b6-0785e3671a95',
    memoryExcerpt:
      'Structured logging is a method of logging that formats log records as structured data, such as JSON. This approach includes fields like timestamp, level, logger, message, module, function, line number, exception info, custom attributes, correlation ID, and user context. Structured logging with correlation IDs and user context enables effective troubleshooting.',
    claim:
      'Structured logging writes records as XML documents indexed by syslog facility codes for retention.',
    label: 'unsupported',
    perturbation: 'wrong-component',
  },

  /* ---------------- 17c1f4fb — Fail-Closed Compliance --------------------- */
  {
    id: 'grd-fail-closed-sup',
    sourceMemoryId: '17c1f4fb-938f-5ca1-85ca-d5b65d1aaf3c',
    memoryExcerpt:
      'DNC scrubbing is enforced on every outbound SMS with no exceptions or manual overrides, and the zip gate rejects out-of-area leads before enrichment spends money. This design ensures that any failure in the compliance system results in a blocked action.',
    claim:
      'DNC scrubbing runs on every outbound SMS with no manual overrides, and the zip gate rejects out-of-area leads before enrichment spends money.',
    label: 'supported',
  },
  {
    id: 'grd-fail-closed-unsup',
    sourceMemoryId: '17c1f4fb-938f-5ca1-85ca-d5b65d1aaf3c',
    memoryExcerpt:
      'DNC scrubbing is enforced on every outbound SMS with no exceptions or manual overrides, and the zip gate rejects out-of-area leads before enrichment spends money. This design ensures that any failure in the compliance system results in a blocked action.',
    claim: 'Manual overrides of DNC scrubbing are allowed for individual outbound SMS exceptions.',
    label: 'unsupported',
    perturbation: 'negation-flip',
  },

  /* ---------------- 19a6d21a — Multi-Provider Router ---------------------- */
  {
    id: 'grd-provider-router-sup',
    sourceMemoryId: '19a6d21a-f8c3-5c0e-b0bb-31826c9e425c',
    memoryExcerpt:
      'The router makes routing decisions based on configurable policies: cost (cheapest provider), latency (fastest based on rolling average), or preferred (priority list with automatic fallback). Retry logic distinguishes between transient failures (429 triggers immediate fallback, 500 gets one retry with exponential backoff) and permanent failures (401 logged without retry).',
    claim:
      'The router routes by cost, latency, or preferred policies; a 429 triggers immediate fallback while a 500 gets one retry with exponential backoff.',
    label: 'supported',
  },
  {
    id: 'grd-provider-router-unsup',
    sourceMemoryId: '19a6d21a-f8c3-5c0e-b0bb-31826c9e425c',
    memoryExcerpt:
      'The router makes routing decisions based on configurable policies: cost (cheapest provider), latency (fastest based on rolling average), or preferred (priority list with automatic fallback). Retry logic distinguishes between transient failures (429 triggers immediate fallback, 500 gets one retry with exponential backoff) and permanent failures (401 logged without retry).',
    claim: 'A 500 triggers immediate fallback while a 429 gets 3 retries with exponential backoff.',
    label: 'unsupported',
    perturbation: 'inverted-number',
  },

  /* ---------------- 1a0cc872 — Read-once exfil guard (TOCTOU) ------------- */
  {
    id: 'grd-read-once-sup',
    sourceMemoryId: '1a0cc872-c6b1-5177-abdf-c831624fddc9',
    memoryExcerpt:
      'Have the guard read the file ONCE and return that exact buffer for upload — never let guard read the file and upload read it again. A second read opens a TOCTOU gap where the scanned bytes differ from the sent bytes. Also: a blocked file must be treated as NON-retryable (dead-letter on first failure) since it won’t pass on retry.',
    claim:
      'The guard reads the file once and upload sends that exact scanned buffer, closing the TOCTOU gap between scanned bytes and sent bytes.',
    label: 'supported',
  },
  {
    id: 'grd-read-once-unsup',
    sourceMemoryId: '1a0cc872-c6b1-5177-abdf-c831624fddc9',
    memoryExcerpt:
      'Have the guard read the file ONCE and return that exact buffer for upload — never let guard read the file and upload read it again. A second read opens a TOCTOU gap where the scanned bytes differ from the sent bytes. Also: a blocked file must be treated as NON-retryable (dead-letter on first failure) since it won’t pass on retry.',
    claim:
      'A blocked file should be requeued for the next delivery cycle since transient guard failures usually clear themselves.',
    label: 'unsupported',
    perturbation: 'negation-flip',
  },

  /* ---------------- 1a615ecf — MCP Trust Boundaries ----------------------- */
  {
    id: 'grd-mcp-trust-sup',
    sourceMemoryId: '1a615ecf-1660-5c84-866a-5d4bc7dfee4e',
    memoryExcerpt:
      'MCP is a powerful integration point but also a significant attack surface. An untrusted MCP server could inject misleading memories into the system. This is identified as a specific security threat in the project’s threat model.',
    claim:
      'An untrusted MCP server injecting misleading memories is identified as a specific threat in the threat model.',
    label: 'supported',
  },
  {
    id: 'grd-mcp-trust-unsup',
    sourceMemoryId: '1a615ecf-1660-5c84-866a-5d4bc7dfee4e',
    memoryExcerpt:
      'MCP is a powerful integration point but also a significant attack surface. An untrusted MCP server could inject misleading memories into the system. This is identified as a specific security threat in the project’s threat model.',
    claim:
      'The threat model concludes MCP servers are safe by default once installed from the official marketplace.',
    label: 'unsupported',
    perturbation: 'overreach',
  },

  /* ---------------- 1d5bc88e — Cross-family LLM judge --------------------- */
  {
    id: 'grd-cross-family-sup',
    sourceMemoryId: '1d5bc88e-e3b5-5e1b-b52d-2235a69601e4',
    memoryExcerpt:
      'In LLM-as-judge A/B evals, a judge model reliably over-scores outputs from its own model family. The rule adopted: the cross-family judge is authoritative and a same-family judge’s verdict is treated as biased. Design eval grids so at least one judge is from a different model family than every candidate being scored.',
    claim:
      'A same-family judge’s verdict is treated as biased, and the cross-family judge is authoritative.',
    label: 'supported',
  },
  {
    id: 'grd-cross-family-unsup',
    sourceMemoryId: '1d5bc88e-e3b5-5e1b-b52d-2235a69601e4',
    memoryExcerpt:
      'In LLM-as-judge A/B evals, a judge model reliably over-scores outputs from its own model family. The rule adopted: the cross-family judge is authoritative and a same-family judge’s verdict is treated as biased. Design eval grids so at least one judge is from a different model family than every candidate being scored.',
    claim:
      'The same-family judge is authoritative, and the cross-family judge’s verdict is treated as biased.',
    label: 'unsupported',
    perturbation: 'argument-swap',
    knownScorerMiss: true, // swap preserves the token set — v1's admitted blind spot
  },

  /* ---------------- 1d521c56 — Additive Layering -------------------------- */
  {
    id: 'grd-additive-layering-sup',
    sourceMemoryId: '1d521c56-71e3-5672-9f2e-695f2076c032',
    memoryExcerpt:
      'The rubric honors all spec-defined fields with the same names, types, and value sets, but adds a required-field set for marketplace publication, stricter validation for loosely-accepted fields, and polish recommendations. This approach ensures that the rubric never replaces its required-field set with the spec’s floor.',
    claim:
      'Additive layering keeps every spec-defined field intact while adding a required-field set for marketplace publication and stricter validation.',
    label: 'supported',
  },
  {
    id: 'grd-additive-layering-unsup',
    sourceMemoryId: '1d521c56-71e3-5672-9f2e-695f2076c032',
    memoryExcerpt:
      'The rubric honors all spec-defined fields with the same names, types, and value sets, but adds a required-field set for marketplace publication, stricter validation for loosely-accepted fields, and polish recommendations. This approach ensures that the rubric never replaces its required-field set with the spec’s floor.',
    claim:
      'Additive layering replaces the rubric’s required-field set with the spec’s floor to stay aligned upstream.',
    label: 'unsupported',
    perturbation: 'negation-flip',
  },

  /* ---------------- 25126672 — Three-Layer Defense ------------------------ */
  {
    id: 'grd-three-layer-sup',
    sourceMemoryId: '25126672-1d73-5016-bd8c-4142f41bf11a',
    memoryExcerpt:
      'The three-layer defense system protects dashboard pages through three layers: edge middleware checks for a session cookie at the CDN edge, the layout component verifies the Firebase ID token signature and expiration server-side, and page-level guards ensure the user ID matches the Firestore path being queried.',
    claim:
      'Dashboard pages are protected by three layers: an edge session-cookie check, server-side ID token verification, and page-level user-ID guards.',
    label: 'supported',
  },
  {
    id: 'grd-three-layer-unsup',
    sourceMemoryId: '25126672-1d73-5016-bd8c-4142f41bf11a',
    memoryExcerpt:
      'The three-layer defense system protects dashboard pages through three layers: edge middleware checks for a session cookie at the CDN edge, the layout component verifies the Firebase ID token signature and expiration server-side, and page-level guards ensure the user ID matches the Firestore path being queried.',
    claim:
      'The ID token signature is verified inside the browser client, skipping server-side verification for speed.',
    label: 'unsupported',
    perturbation: 'wrong-component',
  },

  /* ---------------- 264536af — Policy Engine ------------------------------ */
  {
    id: 'grd-policy-engine-sup',
    sourceMemoryId: '264536af-60a3-563d-afd1-08adec3bec8f',
    memoryExcerpt:
      'The policy engine integrates with the audit journal and fail-closed decision flow, ensuring that tool calls are denied unless explicitly approved. Manifest data is never passed to policy evaluation because “advertisements are not grants”; policy decisions use only verified signals such as user_id, channel, and tool.',
    claim:
      'Manifest data is never passed to policy evaluation — advertisements are not grants — so decisions use only verified signals such as user_id and channel.',
    label: 'supported',
  },
  {
    id: 'grd-policy-engine-unsup',
    sourceMemoryId: '264536af-60a3-563d-afd1-08adec3bec8f',
    memoryExcerpt:
      'The policy engine integrates with the audit journal and fail-closed decision flow, ensuring that tool calls are denied unless explicitly approved. Manifest data is never passed to policy evaluation because “advertisements are not grants”; policy decisions use only verified signals such as user_id, channel, and tool.',
    claim:
      'Manifest data is passed into policy evaluation so rules can use each tool’s advertised capabilities.',
    label: 'unsupported',
    perturbation: 'negation-flip',
  },

  /* ---------------- 2122e47a — Prompt Injection --------------------------- */
  {
    id: 'grd-prompt-injection-sup',
    sourceMemoryId: '2122e47a-97e3-53f7-a1aa-08e6c400235b',
    memoryExcerpt:
      'Defense against prompt injection requires input sanitization, content boundary definition, instruction hierarchy, and output monitoring. Additional techniques include spotlighting (transforming input text to help AI systems distinguish between valid instructions and external inputs), delimiters and datamarking (marking boundaries between trusted and untrusted data).',
    claim:
      'Prompt-injection defense requires input sanitization, instruction hierarchy, and output monitoring, with techniques like spotlighting and datamarking.',
    label: 'supported',
  },
  {
    id: 'grd-prompt-injection-unsup',
    sourceMemoryId: '2122e47a-97e3-53f7-a1aa-08e6c400235b',
    memoryExcerpt:
      'Defense against prompt injection requires input sanitization, content boundary definition, instruction hierarchy, and output monitoring. Additional techniques include spotlighting (transforming input text to help AI systems distinguish between valid instructions and external inputs), delimiters and datamarking (marking boundaries between trusted and untrusted data).',
    claim:
      'Prompt injection is fully prevented by rate limiting and CAPTCHA challenges on the ingestion API.',
    label: 'unsupported',
    perturbation: 'wrong-component',
  },

  /* ---------------- 00ded0e5 — Multi-Agent AI Collaboration --------------- */
  {
    id: 'grd-multi-agent-sup',
    sourceMemoryId: '00ded0e5-4f88-5d01-bda6-cf891eb95d31',
    memoryExcerpt:
      'In the context of technical writing, it involves three specialized roles: a Technical Content Specialist that transforms technical details into narrative, a Business Impact Analyzer that quantifies business value, and a Portfolio Optimization Specialist that optimizes for professional presentation. It can transform a complex technical project into a professional case study in under 30 minutes.',
    claim:
      'The technical-writing pattern uses three specialized roles and can turn a complex technical project into a professional case study in under 30 minutes.',
    label: 'supported',
  },
  {
    id: 'grd-multi-agent-unsup',
    sourceMemoryId: '00ded0e5-4f88-5d01-bda6-cf891eb95d31',
    memoryExcerpt:
      'In the context of technical writing, it involves three specialized roles: a Technical Content Specialist that transforms technical details into narrative, a Business Impact Analyzer that quantifies business value, and a Portfolio Optimization Specialist that optimizes for professional presentation. It can transform a complex technical project into a professional case study in under 30 minutes.',
    claim:
      'The technical-writing pattern uses seven specialized roles and needs about 90 minutes per case study.',
    label: 'unsupported',
    perturbation: 'inverted-number',
  },

  /* ---------------- 1a47f690 — Dependency Graph Publication Order --------- */
  {
    id: 'grd-publication-order-sup',
    sourceMemoryId: '1a47f690-1356-5a46-b398-43ed626dcb33',
    memoryExcerpt:
      'Version ordering in monorepos is a dependency graph problem; packages must be published in topological order of their dependency graph, not alphabetical order. The release prep followed a checklist for each package: update package.json version, regenerate lockfile, update cross-package workspace references, write CHANGELOG entry, and verify build passes.',
    claim:
      'Monorepo packages are published in topological order of the dependency graph, with a per-package checklist covering version, lockfile, changelog, and build verification.',
    label: 'supported',
  },
  {
    id: 'grd-publication-order-unsup',
    sourceMemoryId: '1a47f690-1356-5a46-b398-43ed626dcb33',
    memoryExcerpt:
      'Version ordering in monorepos is a dependency graph problem; packages must be published in topological order of their dependency graph, not alphabetical order. The release prep followed a checklist for each package: update package.json version, regenerate lockfile, update cross-package workspace references, write CHANGELOG entry, and verify build passes.',
    claim:
      'Publishing monorepo packages in alphabetical order is fine because the registry resolves workspace references at install time.',
    label: 'unsupported',
    perturbation: 'negation-flip',
  },
];
