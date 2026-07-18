import { randomUUID } from 'node:crypto';
import type { MemoryCategory as MemoryCategoryType } from '@qmd-team-intent-kb/schema';
import { MemoryCategory } from '@qmd-team-intent-kb/schema';
import { createDatabase, MemoryRepository, AuditRepository } from '@qmd-team-intent-kb/store';
import type { McpServerConfig } from '../config.js';

/** Input for teamkb_recategorize (5bm.7) */
interface RecategorizeInput {
  memoryId: string;
  category: MemoryCategoryType;
  reason: string;
  actor: string;
}

/** Result returned after a successful recategorization */
interface RecategorizeResult {
  memoryId: string;
  fromCategory: string;
  toCategory: string;
  auditEventId: string;
  message: string;
}

/**
 * Governed in-place recategorization of a curated memory (5bm.7).
 *
 * Category is assigned probabilistically at compile time; a miscategorization
 * permanently distorts ranking and export-collection placement, and the only
 * prior correction path was supersede-and-recreate (which inflated the
 * superseded-churn the ontology audit found). This corrects the category in
 * place and writes a `recategorized` audit event ({fromCategory, toCategory}) —
 * the memory row's `update()` re-asserts enum membership, and both writes commit
 * in one SQLite transaction. Low-frequency user action, so a per-call connection
 * is acceptable (mirrors applyTransition).
 */
export function applyRecategorize(
  input: RecategorizeInput,
  config: McpServerConfig,
  nowFn: () => string = () => new Date().toISOString(),
): RecategorizeResult {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(input.memoryId)) {
    throw new Error(`Invalid memoryId: "${input.memoryId}" is not a valid UUID`);
  }
  if (!MemoryCategory.safeParse(input.category).success) {
    throw new Error(`Invalid category: "${input.category}"`);
  }

  const db = createDatabase({ path: config.dbPath });
  try {
    const memoryRepo = new MemoryRepository(db);
    const auditRepo = new AuditRepository(db);

    const memory = memoryRepo.findById(input.memoryId);
    if (memory === null) {
      throw new Error(`Memory not found: ${input.memoryId}`);
    }
    if (memory.category === input.category) {
      throw new Error(`Memory is already category "${memory.category}"`);
    }

    const now = nowFn();
    const auditEventId = randomUUID();
    const fromCategory = memory.category;

    const applyFn = db.transaction(() => {
      // The row update re-asserts enum membership (5bm.1); a bad category never lands.
      memoryRepo.update({ ...memory, category: input.category, updatedAt: now });
      auditRepo.insert({
        id: auditEventId,
        action: 'recategorized',
        memoryId: input.memoryId,
        tenantId: memory.tenantId,
        actor: { type: 'human', id: input.actor },
        reason: input.reason,
        details: { fromCategory, toCategory: input.category },
        timestamp: now,
      });
    });

    applyFn();

    return {
      memoryId: input.memoryId,
      fromCategory,
      toCategory: input.category,
      auditEventId,
      message: `Memory recategorized from "${fromCategory}" to "${input.category}"`,
    };
  } finally {
    db.close();
  }
}
