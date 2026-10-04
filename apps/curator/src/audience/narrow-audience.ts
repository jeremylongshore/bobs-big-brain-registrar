/**
 * Governed audience narrowing of an already-promoted memory (Epic K bead K3,
 * decision `000-docs/053-AT-DECR`).
 *
 * A memory's audience is declared at capture and, until now, was fixed at
 * promotion. This is the governed way to change it afterwards, in ONE direction
 * only: toward a narrower tier (`tenant` -> `admins` -> `owner`). Widening is a
 * different act with different risks (bead K4) and is refused here.
 *
 * The audience write and its hash-chained `audience_narrowed` receipt (actor,
 * time, from, to, reason) commit in a single transaction, so a narrowed memory
 * always has its receipt and a receipt always has its narrowed memory. Narrowing
 * changes who may read a claim; it never changes its content or its existence.
 *
 * @module audience/narrow-audience
 */

import { randomUUID } from 'node:crypto';

import { validateAudienceNarrowing } from '@qmd-team-intent-kb/common';
import type { AudienceNarrowingRefusal } from '@qmd-team-intent-kb/common';
import {
  Audience,
  AuditEvent as AuditEventSchema,
  CuratedMemory as CuratedMemorySchema,
} from '@qmd-team-intent-kb/schema';
import type { AuditRepository, MemoryRepository } from '@qmd-team-intent-kb/store';

/** Why a narrowing request was refused. */
export type NarrowAudienceRefusalCode =
  AudienceNarrowingRefusal | 'not_found' | 'missing_reason' | 'missing_actor';

/** One narrowing request. */
export interface NarrowAudienceInput {
  memoryId: string;
  /** Tenant scope: a memory in another tenant is reported as not found. */
  tenantId: string;
  /** The requested (narrower) audience tier. */
  to: string;
  /** Who is narrowing — recorded as the receipt's human actor. */
  actor: string;
  /** Why — recorded verbatim on the receipt. */
  reason: string;
  /** Validate and report without writing. */
  dryRun?: boolean;
  /** Injected clock (ISO-8601). Defaults to the wall clock. */
  now?: string;
}

/** Outcome of one narrowing request. */
export type NarrowAudienceResult =
  | {
      ok: true;
      memoryId: string;
      from: string;
      to: string;
      /** The receipt's id; null in dry-run (nothing was written). */
      auditEventId: string | null;
    }
  | { ok: false; memoryId: string; code: NarrowAudienceRefusalCode; error: string };

function refuse(
  memoryId: string,
  code: NarrowAudienceRefusalCode,
  error: string,
): NarrowAudienceResult {
  return { ok: false, memoryId, code, error };
}

/**
 * Narrow one promoted memory's audience. Deterministic and synchronous; never
 * throws for a refusal (unknown id, widening, same tier, unknown tier, missing
 * reason or actor) — those come back as `{ ok: false, code }`.
 */
export function narrowAudience(
  input: NarrowAudienceInput,
  memoryRepo: MemoryRepository,
  auditRepo: AuditRepository,
): NarrowAudienceResult {
  const { memoryId } = input;
  if (input.reason.trim() === '') {
    return refuse(memoryId, 'missing_reason', 'A reason is required to narrow an audience');
  }
  if (input.actor.trim() === '') {
    return refuse(memoryId, 'missing_actor', 'An actor is required to narrow an audience');
  }

  const memory = memoryRepo.findById(memoryId);
  if (memory === null || memory.tenantId !== input.tenantId) {
    return refuse(
      memoryId,
      'not_found',
      `Memory ${memoryId} not found in tenant ${input.tenantId}`,
    );
  }

  const validation = validateAudienceNarrowing(memory.metadata.audience, input.to);
  if (!validation.valid) return refuse(memoryId, validation.code, validation.error);

  if (input.dryRun === true) {
    return { ok: true, memoryId, from: validation.from, to: validation.to, auditEventId: null };
  }

  const now = input.now ?? new Date().toISOString();
  const auditEventId = randomUUID();
  const updated = CuratedMemorySchema.parse({
    ...memory,
    metadata: { ...memory.metadata, audience: Audience.parse(validation.to) },
    updatedAt: now,
  });
  const receipt = AuditEventSchema.parse({
    id: auditEventId,
    action: 'audience_narrowed',
    memoryId,
    tenantId: memory.tenantId,
    actor: { type: 'human', id: input.actor },
    reason: input.reason,
    details: { from: validation.from, to: validation.to },
    timestamp: now,
  });

  // One transaction: the metadata change and its receipt commit together.
  // `.immediate()` takes the write lock up front so the audit append's own
  // prev-hash read cannot interleave with another writer (it nests as a savepoint).
  memoryRepo.connection
    .transaction((): void => {
      memoryRepo.update(updated);
      auditRepo.insert(receipt);
    })
    .immediate();

  return { ok: true, memoryId, from: validation.from, to: validation.to, auditEventId };
}
