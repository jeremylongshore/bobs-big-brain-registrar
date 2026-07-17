import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeIndexManager } from '../native/native-index-manager.js';

describe('NativeIndexManager', () => {
  let exportDir: string;
  let manager: NativeIndexManager;

  function write(subdir: string, name: string, content: string, mtimeSec?: number): string {
    const dir = join(exportDir, subdir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, content);
    if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
    return path;
  }

  beforeEach(() => {
    exportDir = mkdtempSync(join(tmpdir(), 'native-index-test-'));
    manager = new NativeIndexManager({ exportDir, indexPath: ':memory:', refreshTtlMs: 0 });
  });

  afterEach(() => {
    manager.close();
    rmSync(exportDir, { recursive: true, force: true });
  });

  it('indexes the export tree with qmd:// citation ids per collection', () => {
    write('curated', 'abc.md', 'the governed pipeline');
    write('decisions', 'def.md', 'we chose sqlite');
    const indexed = manager.ensureFresh();
    expect(indexed).toBe(2);
    const hits = manager.search('governed', 10, []);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('qmd://kb-curated/abc.md');
    expect(hits[0]!.collection).toBe('kb-curated');
  });

  it('matches hyphen- and dot-joined terms that keyword-AND tokenizers miss', () => {
    write('curated', 'mcp-fix.md', 'the governed-brain MCP server was registered twice');
    write('guides', 'doc-fix.md', 'currency fixes for CLAUDE.md across repos');
    manager.ensureFresh();
    // Hyphenated query term → tokenized → matches the hyphenated doc text.
    expect(manager.search('governed-brain registered', 10, [])).toHaveLength(1);
    // Dotted filename term in the query matches dotted text in the doc.
    expect(manager.search('CLAUDE.md currency', 10, [])).toHaveLength(1);
    // And the un-hyphenated phrasing reaches the hyphenated doc too.
    expect(manager.search('governed brain MCP', 10, [])).toHaveLength(1);
  });

  it('re-indexes a changed file and drops a deleted one', () => {
    const path = write('curated', 'a.md', 'original topic alpha', 1_000_000);
    manager.ensureFresh();
    expect(manager.search('alpha', 10, [])).toHaveLength(1);

    writeFileSync(path, 'rewritten topic beta');
    utimesSync(path, 2_000_000, 2_000_000);
    expect(manager.ensureFresh()).toBe(1);
    expect(manager.search('alpha', 10, [])).toHaveLength(0);
    expect(manager.search('beta', 10, [])).toHaveLength(1);

    unlinkSync(path);
    manager.ensureFresh();
    expect(manager.search('beta', 10, [])).toHaveLength(0);
    expect(manager.count()).toBe(0);
  });

  it('skips the sweep inside the TTL window', () => {
    write('curated', 'a.md', 'alpha');
    const throttled = new NativeIndexManager({
      exportDir,
      indexPath: ':memory:',
      refreshTtlMs: 60_000,
    });
    try {
      expect(throttled.ensureFresh(1_000_000)).toBe(1);
      write('curated', 'b.md', 'beta');
      // Within the TTL: no sweep, new file not yet visible.
      expect(throttled.ensureFresh(1_030_000)).toBe(0);
      // After the TTL: swept.
      expect(throttled.ensureFresh(1_070_000)).toBe(1);
    } finally {
      throttled.close();
    }
  });

  it('filters search results to the allowed collections', () => {
    write('curated', 'a.md', 'shared topic');
    write('archive', 'b.md', 'shared topic');
    manager.ensureFresh();
    expect(manager.search('shared', 10, [])).toHaveLength(2);
    const curatedOnly = manager.search('shared', 10, ['kb-curated', 'kb-decisions', 'kb-guides']);
    expect(curatedOnly).toHaveLength(1);
    expect(curatedOnly[0]!.collection).toBe('kb-curated');
  });

  it('tolerates a missing export dir (empty index, no throw)', () => {
    const empty = new NativeIndexManager({
      exportDir: join(exportDir, 'does-not-exist'),
      indexPath: ':memory:',
      refreshTtlMs: 0,
    });
    try {
      expect(empty.ensureFresh()).toBe(0);
      expect(empty.search('anything', 10, [])).toEqual([]);
    } finally {
      empty.close();
    }
  });
});
