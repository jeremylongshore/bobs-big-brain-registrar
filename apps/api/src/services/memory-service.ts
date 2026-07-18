import { randomUUID } from 'node:crypto';
import type { MemoryRepository, AuditRepository } from '@qmd-team-intent-kb/store';
import {
  AuditEvent,
  TransitionRequest,
  RecategorizeRequest,
  validateTransition,
} from '@qmd-team-intent-kb/schema';
import type { CuratedMemory, MemoryLifecycleState } from '@qmd-team-intent-kb/schema';
import { badRequest, notFound } from '../errors.js';

/** Map a target lifecycle state to an audit action verb. */
function lifecycleToAction(to: MemoryLifecycleState): AuditEvent['action'] {
  switch (to) {
    case 'archived':
      return 'archived';
    case 'superseded':
      return 'superseded';
    case 'deprecated':
      return 'demoted';
    case 'active':
      return 'promoted';
  }
}

/**
 * Service layer for curated memory lifecycle management.
 * Validates all transitions and writes a corresponding audit event.
 */
export class MemoryService {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly auditRepo: AuditRepository,
  ) {}

  /**
   * Retrieve a curated memory by its UUID.
   * Throws a 404 ApiError if not found.
   */
  getById(id: string): CuratedMemory {
    const memory = this.memoryRepo.findById(id);
    if (memory === null) throw notFound(`Memory ${id} not found`);
    return memory;
  }

  /**
   * List curated memories, optionally filtered by tenant.
   * When no tenantId is provided the list is empty — tenant scope is
   * always required. Returns an empty array rather than throwing so
   * callers can decide how to surface this constraint.
   */
  list(tenantId: string | undefined): CuratedMemory[] {
    if (tenantId !== undefined && tenantId.length > 0) {
      return this.memoryRepo.findByTenant(tenantId);
    }
    return [];
  }

  /** Find a curated memory by its content hash, or null if not found. */
  findByHash(hash: string): CuratedMemory | null {
    return this.memoryRepo.findByContentHash(hash);
  }

  /**
   * Transition a memory to a new lifecycle state.
   * Validates the transition is allowed, updates the row, and appends
   * an audit event. Throws 400 on invalid transition or bad request body.
   * Throws 404 when the memory does not exist.
   */
  transition(id: string, to: MemoryLifecycleState, requestBody: unknown): CuratedMemory {
    const parsed = TransitionRequest.safeParse(requestBody);
    if (!parsed.success) {
      throw badRequest(`Invalid transition request: ${parsed.error.message}`);
    }

    const memory = this.getById(id); // throws 404 if missing
    const validation = validateTransition(memory.lifecycle, to, parsed.data);
    if (!validation.valid) {
      throw badRequest(validation.error);
    }

    const now = new Date().toISOString();
    this.memoryRepo.updateLifecycle(id, to, now);

    const auditEvent = AuditEvent.parse({
      id: randomUUID(),
      action: lifecycleToAction(to),
      memoryId: id,
      tenantId: memory.tenantId,
      actor: parsed.data.actor,
      reason: parsed.data.reason,
      details: { from: memory.lifecycle, to },
      timestamp: now,
    });
    this.auditRepo.insert(auditEvent);

    // Return the updated memory without a second DB fetch
    return { ...memory, lifecycle: to, updatedAt: now };
  }

  /**
   * Governed in-place recategorization (5bm.7): correct a memory's category
   * without the supersede-and-recreate churn. Validates the request, rejects a
   * no-op (same category), writes the corrected row (the repository re-asserts
   * enum membership), and appends a `recategorized` audit event carrying
   * {fromCategory, toCategory} so the correction is on the append-only chain.
   * Changing the category also moves the memory's export collection on the next
   * exporter run (getDirectory keys on category).
   *
   * Throws 400 on a bad body or a same-category no-op; 404 when the memory does
   * not exist.
   */
  recategorize(id: string, requestBody: unknown): CuratedMemory {
    const parsed = RecategorizeRequest.safeParse(requestBody);
    if (!parsed.success) {
      throw badRequest(`Invalid recategorize request: ${parsed.error.message}`);
    }

    const memory = this.getById(id); // throws 404 if missing
    if (memory.category === parsed.data.category) {
      throw badRequest(`Memory ${id} is already category "${memory.category}"`);
    }

    const now = new Date().toISOString();
    const updated: CuratedMemory = { ...memory, category: parsed.data.category, updatedAt: now };
    this.memoryRepo.update(updated);

    const auditEvent = AuditEvent.parse({
      id: randomUUID(),
      action: 'recategorized',
      memoryId: id,
      tenantId: memory.tenantId,
      actor: parsed.data.actor,
      reason: parsed.data.reason,
      details: { fromCategory: memory.category, toCategory: parsed.data.category },
      timestamp: now,
    });
    this.auditRepo.insert(auditEvent);

    return updated;
  }
}
