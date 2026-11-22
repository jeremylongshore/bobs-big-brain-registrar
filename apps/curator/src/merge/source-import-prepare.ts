import { GovernancePolicy } from '@qmd-team-intent-kb/schema';
import { CandidateRepository, PolicyRepository, verifyAuditChain } from '@qmd-team-intent-kb/store';
import { SourceImportError, MAX_IMPORT_SOURCES, SourceImportPlan } from './source-import-schema.js';
import type { SourceImportContext, SourceImportDependencies } from './source-import-schema.js';
import {
  MAX_SOURCE_SNAPSHOT_BYTES,
  MAX_SOURCE_SNAPSHOT_ITEMS,
  SignedSourceSnapshot,
  TrustedSourceCheckpoint,
  sourceSnapshotDigest,
} from './source-snapshot-schema.js';
import { verifySourceSnapshot } from './source-snapshot.js';
import { destinationRows, prepareImportGroups } from './source-import-groups.js';
import { inspectSourceProgress } from './source-import-state.js';

export function boundImportInputs(inputs: readonly string[]): string[] {
  if (
    !Array.isArray(inputs) ||
    inputs.length < 1 ||
    inputs.length > MAX_IMPORT_SOURCES ||
    inputs.some((value) => typeof value !== 'string') ||
    inputs.reduce((total, value) => total + Buffer.byteLength(value), 0) > MAX_SOURCE_SNAPSHOT_BYTES
  ) {
    throw new SourceImportError('invalid-input');
  }
  return [...inputs];
}

export function loadVerifiedSources(
  inputs: string[],
  context: SourceImportContext,
): {
  snapshots: SignedSourceSnapshot[];
  authorityDigest: string;
  validFrom: number;
  validUntil: number;
} {
  const checkpoints = context
    .loadCheckpoints()
    .map((value) => TrustedSourceCheckpoint.parse(value));
  const accepted = new Map<
    string,
    { snapshot: SignedSourceSnapshot; checkpoint: TrustedSourceCheckpoint }
  >();
  const now = context.now();
  for (const serialized of inputs) {
    const parsed = SignedSourceSnapshot.parse(JSON.parse(serialized));
    const scope = parsed.payload;
    if (scope.destinationTenantId !== context.tenantId)
      throw new SourceImportError('invalid-input');
    const matching = checkpoints.filter(
      (pin) =>
        pin.sourceId === scope.sourceId &&
        pin.sourceTenantId === scope.sourceTenantId &&
        pin.destinationTenantId === scope.destinationTenantId,
    );
    if (matching.length !== 1) throw new SourceImportError('invalid-input');
    const checkpoint = matching[0]!;
    const snapshot = verifySourceSnapshot(serialized, checkpoint, now);
    accepted.set(snapshot.digest, { snapshot, checkpoint });
  }
  const pairs = [...accepted.values()].sort((a, b) =>
    a.snapshot.digest < b.snapshot.digest ? -1 : 1,
  );
  const snapshots = pairs.map((pair) => pair.snapshot);
  if (
    snapshots.reduce((total, snapshot) => total + snapshot.payload.itemCount, 0) >
    MAX_SOURCE_SNAPSHOT_ITEMS
  ) {
    throw new SourceImportError('invalid-input');
  }
  return {
    snapshots,
    authorityDigest: sourceSnapshotDigest(pairs.map((pair) => pair.checkpoint)),
    validFrom: Math.max(
      ...pairs.map(({ snapshot, checkpoint }) =>
        Math.max(Date.parse(snapshot.payload.issuedAt), Date.parse(checkpoint.validFrom)),
      ),
    ),
    validUntil: Math.min(
      ...pairs.map(({ snapshot, checkpoint }) =>
        Math.min(Date.parse(snapshot.payload.expiresAt), Date.parse(checkpoint.validUntil)),
      ),
    ),
  };
}

export function destinationCandidates(deps: SourceImportDependencies, tenantId: string) {
  return new CandidateRepository(deps.memoryRepo.connection)
    .findByTenant(tenantId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function destinationPolicy(deps: SourceImportDependencies, context: SourceImportContext) {
  const configured = new PolicyRepository(deps.memoryRepo.connection)
    .findByTenant(context.tenantId)
    .filter((policy) => policy.enabled);
  if (configured.length > 1) throw new SourceImportError('invalid-destination');
  const supplied =
    context.policy === undefined ? undefined : GovernancePolicy.parse(context.policy);
  if (supplied !== undefined && (!supplied.enabled || supplied.tenantId !== context.tenantId))
    throw new SourceImportError('invalid-input');
  const stored = configured[0];
  if (
    stored !== undefined &&
    supplied !== undefined &&
    sourceSnapshotDigest(stored) !== sourceSnapshotDigest(supplied)
  )
    throw new SourceImportError('stale-plan');
  const policy = stored ?? supplied;
  return {
    policy,
    policyDigest: sourceSnapshotDigest({ configured: stored ?? null, effective: policy ?? null }),
  };
}

export function prepareSourceImportState(
  inputs: string[],
  deps: SourceImportDependencies,
  context: SourceImportContext,
) {
  if (deps.memoryRepo.connection !== deps.auditRepo.connection)
    throw new SourceImportError('invalid-input');
  if (context.tenantId.trim() !== context.tenantId || context.tenantId.length === 0)
    throw new SourceImportError('invalid-input');
  const { policy, policyDigest } = destinationPolicy(deps, context);
  const { snapshots, authorityDigest } = loadVerifiedSources(inputs, context);
  const chain = verifyAuditChain(deps.auditRepo);
  const auditRows = deps.auditRepo.findAllChronological();
  if (
    chain.breaks.length ||
    chain.unverifiedRows ||
    auditRows.some((event) => event.hash_version !== 1 && event.hash_version !== 2)
  ) {
    throw new SourceImportError('invalid-destination');
  }
  for (const snapshot of snapshots) inspectSourceProgress(snapshot, deps.auditRepo);
  const rows = destinationRows(deps, context.tenantId);
  const sourceSnapshotDigests = snapshots.map((snapshot) => snapshot.digest);
  const candidates = destinationCandidates(deps, context.tenantId);
  const importDigest = sourceSnapshotDigest({
    kind: 'source-import-v1',
    tenantId: context.tenantId,
    sourceSnapshotDigests,
    policyDigest,
  });
  const plan = SourceImportPlan.parse({
    version: 1,
    tenantId: context.tenantId,
    importDigest,
    policyDigest,
    sourceSnapshotDigests,
    authorityDigest,
    destinationDigest: sourceSnapshotDigest({
      rows,
      candidates,
      auditHead: auditRows.at(-1)?.entry_hash ?? null,
    }),
  });
  return { plan, snapshots, rows, candidates, policy };
}

export function groupsForImport(
  state: ReturnType<typeof prepareSourceImportState>,
  deps: SourceImportDependencies,
) {
  for (const snapshot of state.snapshots) {
    for (const item of snapshot.payload.items) {
      if (
        deps.auditRepo.findRedactionByOldContentHash(
          item.memory.contentHash,
          state.plan.tenantId,
        ) !== null
      ) {
        throw new SourceImportError('conflicting-content');
      }
    }
  }
  return prepareImportGroups(
    state.snapshots,
    state.rows,
    state.candidates,
    deps,
    state.plan.tenantId,
  );
}

export function recheckImportAuthority(
  inputs: string[],
  context: SourceImportContext,
  plan: SourceImportPlan,
  deps: SourceImportDependencies,
): void {
  const verified = loadVerifiedSources(inputs, context);
  if (
    verified.authorityDigest !== plan.authorityDigest ||
    destinationPolicy(deps, context).policyDigest !== plan.policyDigest
  ) {
    throw new SourceImportError('stale-plan');
  }
  // Sample once more after signature/policy work; no history scan follows this.
  const now = context.now();
  if (!Number.isFinite(now) || now < verified.validFrom || now >= verified.validUntil)
    throw new SourceImportError('stale-plan');
}
