import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  assertDisclosureClean,
  computeContentHash,
  deriveMemoryId,
} from '@qmd-team-intent-kb/common';
import { effectiveSensitivity } from '@qmd-team-intent-kb/policy-engine';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { AuditRepository, MemoryRepository, verifyAuditChain } from '@qmd-team-intent-kb/store';
import { resolveCandidateMinimumSensitivity } from '../recovery/sensitivity-constraint.js';
import {
  MAX_SOURCE_SNAPSHOT_BYTES,
  MAX_SOURCE_SNAPSHOT_ITEMS,
  SignedSourceSnapshot,
  SourceSnapshotError,
  SourceSnapshotOptions,
  TrustedSourceCheckpoint,
  snapshotCanonicalJson,
  snapshotSigningBytes,
  sourceSnapshotDigest,
} from './source-snapshot-schema.js';
import type { SourceSnapshotItem, SourceSnapshotPayload } from './source-snapshot-schema.js';

function keyFingerprint(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateInventory(payload: SourceSnapshotPayload): void {
  if (
    payload.itemCount !== payload.items.length ||
    payload.inventoryDigest !== sourceSnapshotDigest(payload.items)
  ) {
    throw new SourceSnapshotError('snapshot-mismatch');
  }
  let previousId = '';
  const candidateHashes = new Map<string, string>();
  for (const item of payload.items) {
    const row = item.memory;
    const previousHash = candidateHashes.get(row.candidateId);
    if (
      row.id <= previousId ||
      row.tenantId !== payload.sourceTenantId ||
      row.lifecycle !== 'active' ||
      computeContentHash(row.content) !== row.contentHash ||
      deriveMemoryId(row.candidateId, row.contentHash) !== row.id ||
      (previousHash !== undefined && previousHash !== row.contentHash) ||
      effectiveSensitivity(row.sensitivity, item.minimumSensitivity) !== item.minimumSensitivity
    ) {
      throw new SourceSnapshotError('invalid-source');
    }
    previousId = row.id;
    candidateHashes.set(row.candidateId, row.contentHash);
  }
}

/** Exact checkpoint pin is supplied by a trusted caller, never read from the artifact.
 * This verifies an attestation, not the signer's honesty or a live freshness feed.
 * Importers must reverify inside their destination transaction before applying it.
 */
export function verifySourceSnapshot(
  serialized: string,
  trustedCheckpoint: TrustedSourceCheckpoint,
  now: number,
): SignedSourceSnapshot {
  try {
    if (
      typeof serialized !== 'string' ||
      Buffer.byteLength(serialized) > MAX_SOURCE_SNAPSHOT_BYTES
    ) {
      throw new SourceSnapshotError('invalid-input');
    }
    const raw: unknown = JSON.parse(serialized);
    const snapshot = SignedSourceSnapshot.parse(raw);
    const checkpoint = TrustedSourceCheckpoint.parse(trustedCheckpoint);
    // Nested domain schemas strip unknown fields and supply defaults. Neither
    // transformation is allowed at this authenticated wire boundary.
    if (snapshotCanonicalJson(raw) !== snapshotCanonicalJson(snapshot)) {
      throw new SourceSnapshotError('invalid-input');
    }
    const { payload } = snapshot;
    validateAuthority(payload, checkpoint, now);
    if (
      snapshot.digest !== sourceSnapshotDigest(payload) ||
      snapshot.digest !== checkpoint.snapshotDigest ||
      payload.sequence !== checkpoint.sequence
    ) {
      throw new SourceSnapshotError('snapshot-mismatch');
    }
    const publicBytes = Buffer.from(checkpoint.publicKeyHex, 'hex');
    const key = createPublicKey({ key: publicBytes, format: 'der', type: 'spki' });
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      keyFingerprint(publicBytes) !== checkpoint.keyId ||
      !verify(null, snapshotSigningBytes(payload), key, Buffer.from(snapshot.signature, 'hex'))
    ) {
      throw new SourceSnapshotError('invalid-signature');
    }
    validateInventory(payload);
    return snapshot;
  } catch (error) {
    if (error instanceof SourceSnapshotError) throw error;
    throw new SourceSnapshotError('invalid-input');
  }
}

function validateAuthority(
  payload: SourceSnapshotPayload,
  checkpoint: TrustedSourceCheckpoint,
  now: number,
): void {
  if (
    checkpoint.revoked ||
    payload.sourceId !== checkpoint.sourceId ||
    payload.sourceTenantId !== checkpoint.sourceTenantId ||
    payload.destinationTenantId !== checkpoint.destinationTenantId ||
    payload.keyId !== checkpoint.keyId
  ) {
    throw new SourceSnapshotError('untrusted-source');
  }
  const start = Date.parse(payload.issuedAt);
  const end = Date.parse(payload.expiresAt);
  const validFrom = Date.parse(checkpoint.validFrom);
  const validUntil = Date.parse(checkpoint.validUntil);
  if (
    !Number.isFinite(now) ||
    !(start < end) ||
    !(validFrom < validUntil) ||
    start < validFrom ||
    end > validUntil ||
    now < start ||
    now >= end ||
    now < validFrom ||
    now >= validUntil
  ) {
    throw new SourceSnapshotError('stale-checkpoint');
  }
}

/** Export the complete active canonical inventory, with no store mutations.
 * The caller owns key custody and authorization to export this tenant's content.
 * Raw audit details never leave the source. A signature does not grant read access.
 */
export function exportSourceSnapshot(
  connection: Database.Database,
  input: SourceSnapshotOptions,
  privateKeyHex: string,
): string {
  try {
    const options = SourceSnapshotOptions.parse(input);
    if (
      !(Date.parse(options.issuedAt) < Date.parse(options.expiresAt)) ||
      !/^[a-f0-9]{96}$/.test(privateKeyHex)
    )
      throw new SourceSnapshotError('invalid-input');
    const key = createPrivateKey({
      key: Buffer.from(privateKeyHex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    if (key.asymmetricKeyType !== 'ed25519') throw new SourceSnapshotError('invalid-input');
    const publicBytes = createPublicKey(key).export({ format: 'der', type: 'spki' });
    return connection
      .transaction(() => {
        const audit = new AuditRepository(connection);
        const chain = verifyAuditChain(audit);
        const events = audit.findAllChronological();
        if (
          chain.breaks.length ||
          chain.unverifiedRows ||
          events.some((event) => event.hash_version !== 1 && event.hash_version !== 2)
        ) {
          throw new SourceSnapshotError('invalid-source');
        }
        const rows = new MemoryRepository(connection).findByTenantAndLifecycle(
          options.sourceTenantId,
          'active',
        );
        if (rows.length > MAX_SOURCE_SNAPSHOT_ITEMS)
          throw new SourceSnapshotError('invalid-source');
        rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const items: SourceSnapshotItem[] = rows.map((memory) => {
          const evidence = audit.findByMemoryAndTenant(memory.candidateId, memory.tenantId);
          for (const event of evidence) {
            const kind = event.details['kind'];
            if (
              event.action === 'governed' &&
              ('minimumSensitivity' in event.details ||
                (typeof kind === 'string' && kind.includes('sensitivity-floor'))) &&
              kind !== 'recovery-sensitivity-floor-v1'
            )
              throw new SourceSnapshotError('invalid-source');
          }
          const candidate = MemoryCandidate.parse({
            ...memory,
            id: memory.candidateId,
            status: 'inbox',
            trustLevel: 'untrusted',
            capturedAt: memory.promotedAt,
            prePolicyFlags: {
              potentialSecret: false,
              lowConfidence: false,
              duplicateSuspect: false,
            },
          });
          assertDisclosureClean(memory);
          return {
            memory,
            minimumSensitivity: effectiveSensitivity(
              memory.sensitivity,
              resolveCandidateMinimumSensitivity(candidate, audit),
            ),
            constraintEvidenceDigest: sourceSnapshotDigest(evidence),
          };
        });
        const payload: SourceSnapshotPayload = {
          ...options,
          version: 1,
          scope: 'all-active-source-tenant-v1',
          constraintModel: 'registrar-sensitivity-floor-v1',
          keyId: keyFingerprint(publicBytes),
          auditHead: events.at(-1)?.entry_hash ?? null,
          itemCount: items.length,
          inventoryDigest: sourceSnapshotDigest(items),
          items,
        };
        validateInventory(payload);
        const serialized = snapshotCanonicalJson(
          SignedSourceSnapshot.parse({
            payload,
            digest: sourceSnapshotDigest(payload),
            signature: sign(null, snapshotSigningBytes(payload), key).toString('hex'),
          }),
        );
        if (Buffer.byteLength(serialized) > MAX_SOURCE_SNAPSHOT_BYTES)
          throw new SourceSnapshotError('invalid-source');
        return serialized;
      })
      .deferred();
  } catch (error) {
    if (error instanceof SourceSnapshotError) throw error;
    throw new SourceSnapshotError('invalid-source');
  }
}
