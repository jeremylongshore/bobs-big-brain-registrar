import { describe, it, expect, beforeEach } from 'vitest';
import { MockQmdExecutor } from '../executor/mock-executor.js';
import { CollectionManager } from '../collections/collection-manager.js';

describe('CollectionManager', () => {
  let mock: MockQmdExecutor;
  let manager: CollectionManager;

  beforeEach(() => {
    mock = new MockQmdExecutor();
    manager = new CollectionManager(mock);
  });

  describe('addCollection', () => {
    it('adds a collection successfully', async () => {
      mock.queueSuccess('');
      const result = await manager.addCollection('kb-curated', '/path/to/docs');
      expect(result.ok).toBe(true);
      expect(mock.lastCommand).toEqual([
        'collection',
        'add',
        '/path/to/docs',
        '--name',
        'kb-curated',
      ]);
    });

    it('returns error on failure', async () => {
      mock.queueFailure('already exists');
      const result = await manager.addCollection('kb-curated', '/path');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('command_failed');
      }
    });
  });

  describe('removeCollection', () => {
    it('removes a collection', async () => {
      mock.queueSuccess('');
      const result = await manager.removeCollection('kb-inbox');
      expect(result.ok).toBe(true);
      expect(mock.lastCommand).toEqual(['collection', 'remove', 'kb-inbox']);
    });
  });

  describe('listCollections', () => {
    it('lists collections', async () => {
      mock.queueSuccess('kb-curated\nkb-guides\nkb-inbox');
      const result = await manager.listCollections();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(['kb-curated', 'kb-guides', 'kb-inbox']);
      }
    });

    it('handles empty list', async () => {
      mock.queueSuccess('');
      const result = await manager.listCollections();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe('ensureCollections', () => {
    it('creates the 4 exportable collections, sourced from export subdirs', async () => {
      // listCollections returns empty
      mock.queueSuccess('');
      // 4 addCollection calls (kb-inbox has no exported source)
      for (let i = 0; i < 4; i++) {
        mock.queueSuccess('');
      }
      const result = await manager.ensureCollections('/exports');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(['kb-curated', 'kb-decisions', 'kb-guides', 'kb-archive']);
      }
      // Each collection sources from its git-exporter subdir, not <base>/<name>
      const addCommands = mock.commands.filter((c) => c[0] === 'collection' && c[1] === 'add');
      expect(addCommands).toContainEqual([
        'collection',
        'add',
        '/exports/curated',
        '--name',
        'kb-curated',
      ]);
      expect(addCommands).toContainEqual([
        'collection',
        'add',
        '/exports/archive',
        '--name',
        'kb-archive',
      ]);
    });

    it('does not register kb-inbox (no exported source)', async () => {
      mock.queueSuccess(''); // list
      for (let i = 0; i < 4; i++) mock.queueSuccess(''); // adds
      const result = await manager.ensureCollections('/exports');
      expect(result.ok).toBe(true);
      const addedNames = mock.commands
        .filter((c) => c[0] === 'collection' && c[1] === 'add')
        .map((c) => c[c.length - 1]);
      expect(addedNames).not.toContain('kb-inbox');
    });

    it('skips existing collections', async () => {
      // listCollections returns all exportable collections already present
      mock.queueSuccess('kb-curated\nkb-decisions\nkb-guides\nkb-archive');
      const result = await manager.ensureCollections('/exports');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });
  });
});
