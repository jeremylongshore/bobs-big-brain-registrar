import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockQmdExecutor } from '../executor/mock-executor.js';
import { QmdAdapter } from '../adapter.js';
import { reindex } from '../reindex/reindex.js';

describe('reindex', () => {
  let mock: MockQmdExecutor;
  let adapter: QmdAdapter;
  let exportDir: string;

  beforeEach(() => {
    mock = new MockQmdExecutor();
    exportDir = mkdtempSync(join(tmpdir(), 'qmd-reindex-test-'));
    adapter = new QmdAdapter({ tenantId: 'test-tenant', exportDir }, mock);
  });

  afterEach(() => {
    rmSync(exportDir, { recursive: true, force: true });
  });

  it('registers missing collections then updates the index', async () => {
    mock.queueSuccess(''); // collection list -> none registered
    for (let i = 0; i < 4; i++) mock.queueSuccess(''); // 4 collection adds
    mock.queueSuccess('Updated'); // qmd update

    const result = await reindex(adapter);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.collectionsCreated).toEqual([
        'kb-curated',
        'kb-decisions',
        'kb-guides',
        'kb-archive',
      ]);
      expect(result.value.indexUpdated).toBe(true);
    }
    // update ran as the last command
    expect(mock.lastCommand).toEqual(['update']);
  });

  it('is idempotent — a re-run against already-registered collections creates none', async () => {
    // list returns all 4 already present → ensureCollections adds nothing
    mock.queueSuccess('kb-curated\nkb-decisions\nkb-guides\nkb-archive');
    mock.queueSuccess('Updated'); // qmd update still runs (re-index)

    const result = await reindex(adapter);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.collectionsCreated).toEqual([]);
      expect(result.value.indexUpdated).toBe(true);
    }
  });

  it('fails closed if collection registration fails — update is NOT attempted', async () => {
    mock.queueSuccess(''); // list -> none
    mock.queueFailure('disk full'); // first collection add fails

    const result = await reindex(adapter);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('command_failed');
    }
    // `update` must never have run after a failed ensure.
    expect(mock.commands.some((c) => c[0] === 'update')).toBe(false);
  });

  it('surfaces an update failure', async () => {
    mock.queueSuccess('kb-curated\nkb-decisions\nkb-guides\nkb-archive'); // all present
    mock.queueFailure('qmd update crashed');

    const result = await reindex(adapter);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Failed to update index');
    }
  });

  it('catches a raw throw from ensureCollections and returns a failed Result (does not reject)', async () => {
    // `ensureCollections()` calls `mkdirSync`, which throws synchronously on a
    // read-only fs / EACCES rather than returning a `Result`. reindex must catch
    // that and convert it to a failed Result — never let the promise reject.
    const throwingAdapter = {
      async ensureCollections(): Promise<never> {
        throw new Error('EACCES: permission denied, mkdir');
      },
      async update(): Promise<never> {
        throw new Error('update should not run after a throwing ensureCollections');
      },
    } as unknown as QmdAdapter;

    const result = await reindex(throwingAdapter);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('command_failed');
      expect(result.error.message).toContain('EACCES');
    }
  });

  it('coerces a non-Error throw to a string message', async () => {
    const throwingAdapter = {
      async ensureCollections(): Promise<never> {
        throw 'string failure';
      },
      async update(): Promise<never> {
        throw new Error('unreachable');
      },
    } as unknown as QmdAdapter;

    const result = await reindex(throwingAdapter);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('command_failed');
      expect(result.error.message).toBe('string failure');
    }
  });
});
