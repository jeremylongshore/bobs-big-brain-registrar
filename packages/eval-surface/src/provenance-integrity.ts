/**
 * provenance-integrity evaluator — is every curated memory's provenance sound,
 * and is the audit chain intact?
 *
 * Two layers of "can you trust this memory":
 *  1. Per-memory content integrity — does each memory's stored `contentHash`
 *     actually match the SHA-256 of its `content`? A mismatch means the content
 *     was altered after the fingerprint was recorded (tampering / corruption).
 *  2. Audit-chain integrity — does the store's append-only SHA-256 audit chain
 *     verify end to end (no broken links)?
 *
 * The verdict passes iff every memory's content hash is consistent AND the audit
 * chain has zero breaks.
 *
 * Pure: takes the memory + audit repositories, returns a verdict. No emit, no
 * sign. (Note: `verifyAuditChain` walks the global chain by design — it is a
 * single append-only ledger across tenants. A tenant-scoped bundle-exposing API
 * is a separate hardening concern, tracked at bead tr08.21.)
 */

import { computeContentHash } from '@qmd-team-intent-kb/common';
import type { AuditRepository, MemoryRepository } from '@qmd-team-intent-kb/store';
import { verifyAuditChain } from '@qmd-team-intent-kb/store';

import type { EvaluatorResult } from './types.js';

const VALID_SOURCES = new Set(['claude_session', 'manual', 'import', 'mcp']);

export interface ProvenanceIntegrityOptions {
  /** Tenant to scope the per-memory content-integrity walk. Omit = all tenants. */
  readonly tenantId?: string;
}

export function evaluateProvenanceIntegrity(
  memoryRepo: MemoryRepository,
  auditRepo: AuditRepository,
  options: ProvenanceIntegrityOptions = {},
): EvaluatorResult {
  const memories =
    options.tenantId !== undefined
      ? memoryRepo.findByTenant(options.tenantId)
      : allMemories(memoryRepo);

  let contentHashMismatches = 0;
  let invalidSources = 0;
  for (const m of memories) {
    if (computeContentHash(m.content) !== m.contentHash) contentHashMismatches += 1;
    if (!VALID_SOURCES.has(m.source)) invalidSources += 1;
  }

  const chain = verifyAuditChain(auditRepo);
  // CHAIN_FORK rows are non-malicious ordering artifacts (all hashes intact),
  // NOT tampering — report them apart from tamper breaks (bead yxp). Both still
  // fail this integrity eval (threshold 1.0); a forked chain is not pristine.
  const chainForks = chain.breaks.filter((b) => b.reason === 'CHAIN_FORK').length;
  const chainTamperBreaks = chain.breaks.length - chainForks;
  const chainAnomalies = chain.breaks.length;

  const passed = contentHashMismatches === 0 && invalidSources === 0 && chainAnomalies === 0;
  // Score: fraction of all integrity checks that held (memories × 2 checks + chain).
  const totalChecks = memories.length * 2 + 1;
  const failedChecks = contentHashMismatches + invalidSources + (chainAnomalies > 0 ? 1 : 0);
  const score = totalChecks === 0 ? 1 : (totalChecks - failedChecks) / totalChecks;

  return {
    name: 'provenance-integrity',
    passed,
    score: Number(score.toFixed(4)),
    threshold: 1.0,
    details: {
      memories_checked: memories.length,
      content_hash_mismatches: contentHashMismatches,
      invalid_sources: invalidSources,
      audit_chain_rows: chain.totalRows,
      audit_chain_breaks: chainTamperBreaks,
      audit_chain_forks: chainForks,
    },
  };
}

/** Gather memories across all tenants via the per-tenant index. */
function allMemories(repo: MemoryRepository): ReturnType<MemoryRepository['findByTenant']> {
  const byTenant = repo.countByTenant();
  const out: ReturnType<MemoryRepository['findByTenant']> = [];
  for (const tenantId of Object.keys(byTenant)) {
    out.push(...repo.findByTenant(tenantId));
  }
  return out;
}
