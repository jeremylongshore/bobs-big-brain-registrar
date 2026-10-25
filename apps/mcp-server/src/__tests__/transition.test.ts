import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@qmd-team-intent-kb/store';
import { AuditRepository, MemoryRepository } from '@qmd-team-intent-kb/store';
import { CuratedMemory as CuratedMemorySchema } from '@qmd-team-intent-kb/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { deriveCandidateId, deriveMemoryId } from '@qmd-team-intent-kb/common';
import { createServer } from '../server.js';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import { applyTransition } from '../tools/transition.js';
import type { McpServerConfig } from '../config.js';
import { FIXED_NOW, makeMemory } from './fixtures.js';

const nowFn = () => FIXED_NOW;

describe('applyTransition()', () => {
  let tmpDir: string;
  let dbPath: string;
  let config: McpServerConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'teamkb-transition-'));
    dbPath = join(tmpDir, 'teamkb.db');
    config = {
      tenantId: 'test-tenant',
      basePath: tmpDir,
      spoolPath: join(tmpDir, 'spool'),
      dbPath,
      feedbackPath: join(tmpDir, 'feedback'),
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedMemory(memory: CuratedMemory): void {
    const db = createDatabase({ path: dbPath });
    const repo = new MemoryRepository(db);
    repo.insert(memory);
    db.close();
  }

  it('transitions active → deprecated successfully', () => {
    const memory = makeMemory({ lifecycle: 'active' });
    seedMemory(memory);

    const result = applyTransition(
      {
        memoryId: memory.id,
        to: 'deprecated',
        reason: 'Superseded by new convention',
        actor: 'user-1',
      },
      config,
      nowFn,
    );

    expect(result.memoryId).toBe(memory.id);
    expect(result.from).toBe('active');
    expect(result.to).toBe('deprecated');
    expect(result.message).toContain('deprecated');
  });

  it('transitions active → archived successfully', () => {
    const memory = makeMemory({ lifecycle: 'active' });
    seedMemory(memory);

    const result = applyTransition(
      { memoryId: memory.id, to: 'archived', reason: 'Permanently retiring this.', actor: 'admin' },
      config,
      nowFn,
    );

    expect(result.from).toBe('active');
    expect(result.to).toBe('archived');
  });

  it('returns a valid UUID for auditEventId', () => {
    const memory = makeMemory();
    seedMemory(memory);

    const result = applyTransition(
      { memoryId: memory.id, to: 'deprecated', reason: 'Old.', actor: 'user-2' },
      config,
      nowFn,
    );

    expect(result.auditEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('persists the new lifecycle state to the DB', () => {
    const memory = makeMemory({ lifecycle: 'active' });
    seedMemory(memory);

    applyTransition(
      { memoryId: memory.id, to: 'deprecated', reason: 'No longer needed.', actor: 'user-1' },
      config,
      nowFn,
    );

    const db = createDatabase({ path: dbPath, readonly: true });
    const repo = new MemoryRepository(db);
    const updated = repo.findById(memory.id);
    db.close();

    expect(updated?.lifecycle).toBe('deprecated');
  });

  it('throws for an invalid lifecycle transition (archived → active)', () => {
    const memory = makeMemory({ lifecycle: 'archived' });
    seedMemory(memory);

    expect(() =>
      applyTransition(
        { memoryId: memory.id, to: 'active', reason: 'Trying to revive.', actor: 'user-1' },
        config,
        nowFn,
      ),
    ).toThrow(/not allowed/i);
  });

  it('throws when memoryId does not exist', () => {
    const db = createDatabase({ path: dbPath });
    db.close(); // Ensure DB file exists with schema

    expect(() =>
      applyTransition(
        { memoryId: randomUUID(), to: 'deprecated', reason: 'Ghost.', actor: 'user-1' },
        config,
        nowFn,
      ),
    ).toThrow(/not found/i);
  });

  it('persists the complete supersession link and receipt for an explicit replacement', () => {
    const memory = makeMemory();
    const replacement = makeMemory({ tenantId: memory.tenantId });
    seedMemory(memory);
    seedMemory(replacement);
    const input = {
      memoryId: memory.id,
      to: 'superseded' as const,
      reason: 'New approved policy',
      actor: 'reviewer',
      supersededBy: replacement.id,
    };
    const result = applyTransition(input, config, nowFn);
    const db = createDatabase({ path: dbPath, readonly: true });
    try {
      const updated = new MemoryRepository(db).findById(memory.id);
      expect(CuratedMemorySchema.safeParse(updated).success).toBe(true);
      expect(updated?.supersession).toEqual({
        supersededBy: replacement.id,
        reason: input.reason,
        linkedAt: FIXED_NOW,
      });
      expect(updated?.lifecycle).toBe('superseded');
      const events = new AuditRepository(db).findByMemory(memory.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        id: result.auditEventId,
        action: 'superseded',
        memoryId: memory.id,
        tenantId: memory.tenantId,
        actor: { type: 'human', id: input.actor },
        reason: input.reason,
        details: { from: 'active', to: 'superseded', supersededBy: replacement.id },
        timestamp: FIXED_NOW,
      });
      expect(events[0]?.reason).toBe(updated?.supersession?.reason);
      expect(events[0]?.timestamp).toBe(updated?.supersession?.linkedAt);
      expect(events[0]?.details.supersededBy).toBe(updated?.supersession?.supersededBy);
    } finally {
      db.close();
    }
  });

  it.each(['missing', 'malformed', 'nonexistent', 'self', 'cross-tenant', 'inactive'])(
    'refuses %s replacement without changing either endpoint or audit',
    (kind) => {
      const memory = makeMemory();
      const replacement = makeMemory({
        tenantId: kind === 'cross-tenant' ? 'other-tenant' : memory.tenantId,
        lifecycle: kind === 'inactive' ? 'deprecated' : 'active',
      });
      seedMemory(memory);
      seedMemory(replacement);
      const supersededBy =
        kind === 'missing'
          ? undefined
          : kind === 'malformed'
            ? 'not-a-uuid'
            : kind === 'nonexistent'
              ? randomUUID()
              : kind === 'self'
                ? memory.id
                : replacement.id;
      const input = {
        memoryId: memory.id,
        to: 'superseded' as const,
        actor: 'reviewer',
        reason: 'Replacement',
        supersededBy,
      };
      expect(() => applyTransition(input, config, nowFn)).toThrow();
      const db = createDatabase({ path: dbPath, readonly: true });
      try {
        const repo = new MemoryRepository(db);
        expect(repo.findById(memory.id)).toMatchObject({
          lifecycle: 'active',
          updatedAt: memory.updatedAt,
        });
        expect(repo.findById(memory.id)?.supersession).toBeUndefined();
        expect(repo.findById(replacement.id)?.lifecycle).toBe(replacement.lifecycle);
        expect(new AuditRepository(db).findByMemory(memory.id)).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  it('rolls back lifecycle, SupersessionLink and receipt when audit insertion fails', () => {
    const memory = makeMemory();
    const replacement = makeMemory({ tenantId: memory.tenantId });
    seedMemory(memory);
    seedMemory(replacement);
    const setup = createDatabase({ path: dbPath });
    try {
      setup.exec(
        "CREATE TRIGGER refuse_supersession_receipt BEFORE INSERT ON audit_events WHEN NEW.action = 'superseded' BEGIN SELECT RAISE(ABORT, 'fixture-audit-refusal'); END",
      );
    } finally {
      setup.close();
    }
    const input = {
      memoryId: memory.id,
      to: 'superseded' as const,
      reason: 'Replacement',
      actor: 'reviewer',
      supersededBy: replacement.id,
    };
    expect(() => applyTransition(input, config, nowFn)).toThrow(/fixture-audit-refusal/);
    const db = createDatabase({ path: dbPath, readonly: true });
    try {
      const repo = new MemoryRepository(db);
      expect(repo.findById(memory.id)?.lifecycle).toBe('active');
      expect(repo.findById(memory.id)?.supersession).toBeUndefined();
      expect(repo.findById(memory.id)?.updatedAt).toBe(memory.updatedAt);
      expect(new AuditRepository(db).findByMemory(memory.id)).toEqual([]);
      expect(repo.findById(replacement.id)?.lifecycle).toBe('active');
    } finally {
      db.close();
    }
  });

  it('accepts current content-derived v5 memory identities', () => {
    const candidateId = deriveCandidateId('fixture-workspace', 'wiki/source.md', 'a'.repeat(64));
    const memory = makeMemory({ candidateId, id: deriveMemoryId(candidateId, 'b'.repeat(64)) });
    seedMemory(memory);
    expect(
      applyTransition(
        { memoryId: memory.id, to: 'archived', reason: 'Retired', actor: 'reviewer' },
        config,
        nowFn,
      ).to,
    ).toBe('archived');
  });

  it('advertises and executes supersession through the actual SDK in-memory transport', async () => {
    const memory = makeMemory();
    const replacement = makeMemory({ tenantId: memory.tenantId });
    seedMemory(memory);
    seedMemory(replacement);
    const server = createServer(config, { canWrite: true, withSync: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'supersession-fixture', version: '0.0.0' });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listing = await client.listTools();
      const tool = listing.tools.find((row) => row.name === 'teamkb_transition');
      expect(tool?.inputSchema.properties).toHaveProperty('supersededBy');
      const response = await client.callTool({
        name: 'teamkb_transition',
        arguments: {
          memoryId: memory.id,
          to: 'superseded',
          reason: 'Approved replacement',
          actor: 'reviewer',
          supersededBy: replacement.id,
        },
      });
      expect(response.isError).not.toBe(true);
      const db = createDatabase({ path: dbPath, readonly: true });
      try {
        expect(new MemoryRepository(db).findById(memory.id)?.supersession?.supersededBy).toBe(
          replacement.id,
        );
      } finally {
        db.close();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('throws for invalid UUID format', () => {
    expect(() =>
      applyTransition(
        { memoryId: 'not-a-uuid', to: 'deprecated', reason: 'Bad ID.', actor: 'user-1' },
        config,
        nowFn,
      ),
    ).toThrow();
  });
});
