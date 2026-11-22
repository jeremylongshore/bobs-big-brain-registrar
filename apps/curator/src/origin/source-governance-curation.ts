import { isDeepStrictEqual } from 'node:util';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { Curator } from '../curator.js';
import { requiresRegistrarMcpReview } from '../review/registrar-mcp-review.js';
import type { sourceGovernanceRepositories } from './source-governance-prepare.js';
import type {
  SourceGovernanceContext,
  SourceGovernanceSettlement,
} from './source-governance-schema.js';

type Repos = ReturnType<typeof sourceGovernanceRepositories>;
export function curateSourceCandidate(
  candidate: MemoryCandidate,
  deps: Repos,
  context: SourceGovernanceContext,
  now: string,
): Pick<SourceGovernanceSettlement, 'outcome' | 'memoryId'> {
  // Learning a stricter source for an existing candidate never reopens its
  // disposition. Only the enclosing floor/alias writes apply in this mode.
  if (candidate.status !== 'inbox') return { outcome: 'restricted-existing', memoryId: null };
  let outcome: SourceGovernanceSettlement['outcome'];
  let memoryId: string | null = null;
  if (candidate.metadata.proposedByRole === 'member' || requiresRegistrarMcpReview(candidate)) {
    outcome = 'quarantined';
  } else {
    const result = new Curator(deps, {
      tenantId: candidate.tenantId,
      ...(context.originSecret === undefined ? {} : { originSecret: context.originSecret }),
      supersessionMode: 'report',
      now: () => now,
    }).processSingle(candidate);
    // A source attestation is not authority to retire other memories.
    if (result.supersessionReport !== undefined || result.supersededIds?.length)
      throw new Error('Source governance refuses unapproved supersession');
    outcome = result.outcome;
    memoryId = result.memoryId ?? null;
  }
  // Automated rejection/flag leaves the row reviewable; only confirmed admission,
  // deduplication and human-review quarantine retire it from ordinary inbox work.
  const status =
    outcome === 'held' || outcome === 'quarantined'
      ? 'quarantined'
      : outcome === 'promoted' || outcome === 'duplicate'
        ? outcome
        : 'inbox';
  if (
    deps.candidateRepo.updateStatus(candidate.id, status, candidate.tenantId) !== 1 ||
    !isDeepStrictEqual(deps.candidateRepo.findById(candidate.id), { ...candidate, status })
  )
    throw new Error('Source candidate disposition was not retained');
  return { outcome, memoryId };
}
