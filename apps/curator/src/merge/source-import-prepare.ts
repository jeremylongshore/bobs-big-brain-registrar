import { GovernancePolicy } from '@qmd-team-intent-kb/schema';
import { verifyAuditChain } from '@qmd-team-intent-kb/store';
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
): { snapshots: SignedSourceSnapshot[]; authorityDigest: string } {
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
  return { snapshots, authorityDigest: sourceSnapshotDigest(pairs.map((pair) => pair.checkpoint)) };
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
  const policy = context.policy === undefined ? undefined : GovernancePolicy.parse(context.policy);
  if (policy !== undefined && (!policy.enabled || policy.tenantId !== context.tenantId))
    throw new SourceImportError('invalid-input');
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
  const policyDigest = sourceSnapshotDigest(policy ?? null);
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
      auditHead: auditRows.at(-1)?.entry_hash ?? null,
    }),
  });
  return { plan, snapshots, rows, policy };
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
  return prepareImportGroups(state.snapshots, state.rows, deps, state.plan.tenantId);
}

export function recheckImportAuthority(
  inputs: string[],
  context: SourceImportContext,
  plan: SourceImportPlan,
): void {
  if (
    loadVerifiedSources(inputs, context).authorityDigest !== plan.authorityDigest ||
    sourceSnapshotDigest(
      context.policy === undefined ? null : GovernancePolicy.parse(context.policy),
    ) !== plan.policyDigest
  ) {
    throw new SourceImportError('stale-plan');
  }
}
