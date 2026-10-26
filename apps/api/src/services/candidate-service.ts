import type { AuditRepository, CandidateRepository } from '@qmd-team-intent-kb/store';
import { CandidateStatus } from '@qmd-team-intent-kb/schema';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  CandidateIntake,
  CandidateIntakeError,
  DEFAULT_ALLOWED_ORIGIN_CHANNELS,
} from '@qmd-team-intent-kb/curator';
import type { IntakeActorContext, IntakeResult } from '@qmd-team-intent-kb/curator';
import { badRequest, notFound, unprocessable } from '../errors.js';

export { applyIntakeOverrides, DEFAULT_ALLOWED_ORIGIN_CHANNELS } from '@qmd-team-intent-kb/curator';
export type { IntakeActorContext, IntakeResult } from '@qmd-team-intent-kb/curator';

/** HTTP-compatible facade over the shared canonical candidate boundary. */
export class CandidateService {
  private readonly intakeService: CandidateIntake;

  constructor(
    private readonly repo: CandidateRepository,
    auditRepo?: AuditRepository,
    allowedChannels: readonly string[] = DEFAULT_ALLOWED_ORIGIN_CHANNELS,
  ) {
    this.intakeService = new CandidateIntake(repo, auditRepo, allowedChannels);
  }

  intake(data: unknown, ctx: IntakeActorContext = {}): IntakeResult {
    try {
      return this.intakeService.intake(data, ctx);
    } catch (error) {
      if (error instanceof CandidateIntakeError) {
        throw error.kind === 'invalid'
          ? badRequest(error.message)
          : unprocessable(error.message, error.code);
      }
      throw error;
    }
  }

  /**
   * Retrieve a candidate by its UUID.
   * Throws a 404 ApiError if not found.
   */
  getById(id: string): MemoryCandidate {
    const candidate = this.repo.findById(id);
    if (candidate === null) throw notFound(`Candidate ${id} not found`);
    return candidate;
  }

  /**
   * List candidates for a tenant, optionally narrowed to a single lifecycle
   * `status` (e.g. `quarantined` — the queue the agent-review `brain_inbox` tool
   * reads, jfv.8). When no tenantId is provided a 400 is thrown — the API always
   * requires a tenant scope for list operations. An unknown `status` is a 400
   * (closed CandidateStatus vocabulary), never a silent empty result.
   */
  list(tenantId: string | undefined, status?: string): MemoryCandidate[] {
    if (tenantId === undefined || tenantId.length === 0) {
      throw badRequest('tenantId query parameter is required');
    }
    if (status !== undefined && status.length > 0) {
      const parsed = CandidateStatus.safeParse(status);
      if (!parsed.success) {
        throw badRequest(
          `Invalid status filter '${status}' — must be one of: ${CandidateStatus.options.join(', ')}`,
        );
      }
      return this.repo.findByStatus(parsed.data, tenantId);
    }
    return this.repo.findByTenant(tenantId);
  }

  /**
   * Internal helper — check whether a content hash is already stored.
   * Returns null when no match exists.
   */
  findByHash(hash: string): MemoryCandidate | null {
    return this.repo.findByContentHash(hash);
  }
}
