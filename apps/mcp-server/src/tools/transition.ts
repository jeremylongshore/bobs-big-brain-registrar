import { randomUUID } from 'node:crypto';
import type { MemoryLifecycleState } from '@qmd-team-intent-kb/schema';
import { TransitionRequest, Uuid, validateTransition } from '@qmd-team-intent-kb/schema';
import { createDatabase, MemoryRepository, AuditRepository } from '@qmd-team-intent-kb/store';
import type { McpServerConfig } from '../config.js';

/** Input for teamkb_transition */
interface TransitionInput {
  memoryId: string;
  to: MemoryLifecycleState;
  reason: string;
  actor: string;
  supersededBy?: string;
}

/** Result returned after a successful transition */
interface TransitionResult {
  memoryId: string;
  from: string;
  to: string;
  auditEventId: string;
  message: string;
}

/**
 * Apply a lifecycle transition to a curated memory.
 *
 * Opens a short-lived read-write connection, validates the transition against
 * the state machine, updates the lifecycle column, and writes an audit event —
 * all inside the same synchronous SQLite transaction.
 *
 * Only called for low-frequency user-initiated actions (deprecation, archival,
 * etc.), so the overhead of opening a connection per call is acceptable.
 */
export function applyTransition(
  input: TransitionInput,
  config: McpServerConfig,
  nowFn: () => string = () => new Date().toISOString(),
): TransitionResult {
  // Use the canonical schema, including current content-derived UUID v5 IDs.
  if (!Uuid.safeParse(input.memoryId).success) {
    throw new Error('Invalid memoryId: expected a UUID');
  }
  const transitionRequest = TransitionRequest.parse({
    reason: input.reason,
    actor: { type: 'human', id: input.actor },
    supersededBy: input.supersededBy,
  });

  const db = createDatabase({ path: config.dbPath });
  try {
    const memoryRepo = new MemoryRepository(db);
    const auditRepo = new AuditRepository(db);

    // Read/validate both endpoints and write state/link/receipt under one lock.
    return db
      .transaction(() => {
        const memory = memoryRepo.findById(input.memoryId);
        if (memory === null) throw new Error(`Memory not found: ${input.memoryId}`);
        const validation = validateTransition(memory.lifecycle, input.to, transitionRequest);
        if (!validation.valid) throw new Error(validation.error);
        const now = nowFn();
        const auditEventId = randomUUID();
        const fromState = memory.lifecycle;
        if (input.to === 'superseded') {
          // validateTransition above requires this field; no state-only fallback.
          if (transitionRequest.supersededBy === undefined)
            throw new Error('supersededBy is required');
          memoryRepo.supersede(
            input.memoryId,
            transitionRequest.supersededBy,
            transitionRequest.reason,
            now,
          );
        } else {
          memoryRepo.updateLifecycle(input.memoryId, input.to, now);
        }
        auditRepo.insert({
          id: auditEventId,
          action:
            input.to === 'archived'
              ? 'archived'
              : input.to === 'superseded'
                ? 'superseded'
                : 'demoted',
          memoryId: input.memoryId,
          tenantId: memory.tenantId,
          actor: transitionRequest.actor,
          reason: transitionRequest.reason,
          details: {
            from: fromState,
            to: input.to,
            ...(input.to === 'superseded' ? { supersededBy: transitionRequest.supersededBy } : {}),
          },
          timestamp: now,
        });
        return {
          memoryId: input.memoryId,
          from: fromState,
          to: input.to,
          auditEventId,
          message: `Memory transitioned from "${fromState}" to "${input.to}"`,
        };
      })
      .immediate();
  } finally {
    db.close();
  }
}
