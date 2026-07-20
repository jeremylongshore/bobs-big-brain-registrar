import { verifyOriginToken } from '@qmd-team-intent-kb/common';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import type { PipelineResult } from '@qmd-team-intent-kb/policy-engine';

/**
 * Write-time provenance gate (GSB Wave-2 H1) — the promotion-path check that a
 * candidate CLAIMING an origin attestation actually verifies against this
 * installation's origin secret.
 *
 * STRUCTURAL, not policy-configured: like the curator's dedup check (and unlike
 * the rules in `governance_policies.rules_json`), this gate runs on every
 * govern/promotion path regardless of tenant policy. Provenance verification is
 * an integrity property of the write path; making it a configurable policy rule
 * would leave it dormant on every pre-H1 policy.
 *
 * v1 verdict table (documented choice — see the H1 decision record):
 *
 *  - `origin` ABSENT   → `unattested`, ACCEPTED. Every pre-H1 spool line and
 *    legacy capture carries no origin; a hard-reject flag-day would orphan all
 *    of them. The promotion receipt records channel `unattested` (H2) so the
 *    gap stays visible instead of silently passing as attested.
 *  - `origin` PRESENT, no secret available to the govern path →
 *    `origin_token_unverifiable` REJECT (fail-closed: a claimed attestation we
 *    cannot check must not promote as if it verified).
 *  - `origin` PRESENT, HMAC mismatch → `origin_token_invalid` REJECT.
 *  - `origin` PRESENT, HMAC verifies → `attested`, proceeds to policy.
 *
 * Rejections are POLICY-PIPELINE-SHAPED (`PipelineResult` with
 * `outcome:'rejected'`) so they flow through the existing receipted rejection
 * path (`reject()` / the API's 422), never a crash. The verdict is only ever
 * surfaced on the candidate's own governance outcome — there is deliberately NO
 * verify-arbitrary-token surface (no oracle).
 */

/** `ruleType` stamped on origin-gate rule results (a structural pseudo-rule). */
export const ORIGIN_ATTESTATION_RULE_TYPE = 'origin_attestation';

/** Stable reject codes — these land verbatim in `PipelineResult.rejectedBy`. */
export type OriginRejectCode = 'origin_token_invalid' | 'origin_token_unverifiable';

/** Outcome of the origin gate for one candidate. */
export type OriginGateResult =
  | { verdict: 'unattested' }
  | { verdict: 'attested' }
  | { verdict: 'rejected'; code: OriginRejectCode; pipelineResult: PipelineResult };

/**
 * Evaluate the origin gate for a candidate. Pure — no I/O; the caller resolves
 * the installation secret (curator config / API wiring).
 */
export function checkOriginAttestation(
  candidate: MemoryCandidate,
  originSecret: string | undefined,
): OriginGateResult {
  if (candidate.origin === undefined) {
    return { verdict: 'unattested' };
  }
  if (originSecret === undefined || originSecret.length === 0) {
    return rejected(
      candidate,
      'origin_token_unverifiable',
      'Candidate claims an origin attestation but no installation origin secret is configured on this govern path — cannot verify, refusing to promote.',
    );
  }
  const ok = verifyOriginToken(
    originSecret,
    {
      candidateId: candidate.id,
      tenantId: candidate.tenantId,
      capturedAt: candidate.capturedAt,
    },
    candidate.origin.tokenHmac,
  );
  if (!ok) {
    return rejected(
      candidate,
      'origin_token_invalid',
      'Origin token HMAC does not verify against the installation secret for (id, tenantId, capturedAt) — the claimed provenance is forged, replayed across identities, or minted under a different secret.',
    );
  }
  return { verdict: 'attested' };
}

/** Build the policy-pipeline-shaped rejection for a failed origin check. */
function rejected(
  candidate: MemoryCandidate,
  code: OriginRejectCode,
  reason: string,
): OriginGateResult {
  return {
    verdict: 'rejected',
    code,
    pipelineResult: {
      candidateId: candidate.id,
      outcome: 'rejected',
      evaluations: [
        {
          ruleId: code,
          ruleType: ORIGIN_ATTESTATION_RULE_TYPE,
          outcome: 'fail',
          reason,
        },
      ],
      rejectedBy: code,
    },
  };
}
