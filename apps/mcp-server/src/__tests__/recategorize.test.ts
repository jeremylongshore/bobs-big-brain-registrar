import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, MemoryRepository, AuditRepository } from '@qmd-team-intent-kb/store';
import { applyRecategorize } from '../tools/recategorize.js';
import type { McpServerConfig } from '../config.js';
import { FIXED_NOW, makeMemory } from './fixtures.js';

const nowFn = () => FIXED_NOW;

describe('applyRecategorize() — governed in-place category correction (5bm.7)', () => {
  let tmpDir: string;
  let dbPath: string;
  let config: McpServerConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'teamkb-recat-'));
    dbPath = join(tmpDir, 'teamkb.db');
    config = {
      tenantId: 'test-tenant',
      basePath: tmpDir,
      spoolPath: join(tmpDir, 'spool'),
      dbPath,
      feedbackPath: join(tmpDir, 'feedback'),
    };
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function seed(category: string) {
    const memory = makeMemory({ category: category as never });
    const db = createDatabase({ path: dbPath });
    new MemoryRepository(db).insert(memory);
    db.close();
    return memory;
  }

  it('corrects the category and writes a recategorized audit event', () => {
    const memory = seed('reference');
    const result = applyRecategorize(
      { memoryId: memory.id, category: 'decision', reason: 'is a decision', actor: 'jeremy' },
      config,
      nowFn,
    );
    expect(result.fromCategory).toBe('reference');
    expect(result.toCategory).toBe('decision');

    const db = createDatabase({ path: dbPath });
    try {
      expect(new MemoryRepository(db).findById(memory.id)?.category).toBe('decision');
      const events = new AuditRepository(db).findByMemory(memory.id);
      expect(events.some((e) => e.action === 'recategorized')).toBe(true);
      const recat = events.find((e) => e.action === 'recategorized');
      expect(recat?.details).toMatchObject({ fromCategory: 'reference', toCategory: 'decision' });
    } finally {
      db.close();
    }
  });

  it('rejects a same-category no-op', () => {
    const memory = seed('pattern');
    expect(() =>
      applyRecategorize(
        { memoryId: memory.id, category: 'pattern', reason: 'x', actor: 'jeremy' },
        config,
        nowFn,
      ),
    ).toThrow(/already category/);
  });

  it('rejects an unknown category', () => {
    const memory = seed('reference');
    expect(() =>
      applyRecategorize(
        { memoryId: memory.id, category: 'made-up' as never, reason: 'x', actor: 'jeremy' },
        config,
        nowFn,
      ),
    ).toThrow(/Invalid category/);
  });

  it('rejects an invalid UUID before opening the DB', () => {
    expect(() =>
      applyRecategorize(
        { memoryId: 'not-a-uuid', category: 'decision', reason: 'x', actor: 'jeremy' },
        config,
        nowFn,
      ),
    ).toThrow(/not a valid UUID/);
  });

  it('throws when the memory does not exist', () => {
    expect(() =>
      applyRecategorize(
        {
          memoryId: '00000000-0000-4000-8000-000000000000',
          category: 'decision',
          reason: 'x',
          actor: 'jeremy',
        },
        config,
        nowFn,
      ),
    ).toThrow(/Memory not found/);
  });
});
