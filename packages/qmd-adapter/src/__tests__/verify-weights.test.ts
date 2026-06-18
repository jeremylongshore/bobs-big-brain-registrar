import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  verifyWeights,
  assertWeightsVerified,
  resolveQmdModelsDir,
  WeightIntegrityError,
  type WeightsManifest,
} from '../weights/verify-weights.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('verifyWeights / assertWeightsVerified', () => {
  let dir: string;
  let manifest: WeightsManifest;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qmd-weights-'));
    writeFileSync(join(dir, 'model-a.gguf'), 'AAAA'); // 4 bytes
    writeFileSync(join(dir, 'model-b.gguf'), 'BBBBBB'); // 6 bytes
    manifest = {
      schemaVersion: 1,
      qmd: { npmPackage: '@tobilu/qmd', version: 'test' },
      models: [
        { id: 'a', role: 'embedding', file: 'model-a.gguf', sha256: sha256('AAAA'), size: 4 },
        { id: 'b', role: 'reranker', file: 'model-b.gguf', sha256: sha256('BBBBBB'), size: 6 },
      ],
    };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes when every weight matches the pin', async () => {
    const r = await verifyWeights(manifest, dir);
    expect(r.ok).toBe(true);
    expect(r.results.map((x) => x.status)).toEqual(['ok', 'ok']);
    expect(r.results[0]?.actualSha256).toBe(sha256('AAAA'));
  });

  it('flags a hash mismatch when content changed but size is identical', async () => {
    writeFileSync(join(dir, 'model-a.gguf'), 'XXXX'); // 4 bytes, different content
    const r = await verifyWeights(manifest, dir);
    expect(r.ok).toBe(false);
    expect(r.results.find((x) => x.id === 'a')?.status).toBe('hash-mismatch');
    expect(r.results.find((x) => x.id === 'b')?.status).toBe('ok');
  });

  it('flags a size mismatch and short-circuits before hashing', async () => {
    writeFileSync(join(dir, 'model-b.gguf'), 'BBB'); // 3 bytes, pinned 6
    const r = await verifyWeights(manifest, dir);
    expect(r.ok).toBe(false);
    const b = r.results.find((x) => x.id === 'b');
    expect(b?.status).toBe('size-mismatch');
    expect(b?.actualSize).toBe(3);
    expect(b?.actualSha256).toBeUndefined();
  });

  it('flags a missing weight', async () => {
    rmSync(join(dir, 'model-a.gguf'));
    const r = await verifyWeights(manifest, dir);
    expect(r.ok).toBe(false);
    expect(r.results.find((x) => x.id === 'a')?.status).toBe('missing');
  });

  it('assertWeightsVerified returns the passing result', async () => {
    const r = await assertWeightsVerified(manifest, dir);
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(2);
  });

  it('assertWeightsVerified throws WeightIntegrityError on mismatch (fail closed)', async () => {
    writeFileSync(join(dir, 'model-a.gguf'), 'XXXX');
    await expect(assertWeightsVerified(manifest, dir)).rejects.toBeInstanceOf(WeightIntegrityError);
  });

  it('WeightIntegrityError carries the verify result and names the bad model', async () => {
    rmSync(join(dir, 'model-b.gguf'));
    try {
      await assertWeightsVerified(manifest, dir);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WeightIntegrityError);
      const err = e as WeightIntegrityError;
      expect(err.result.ok).toBe(false);
      expect(err.message).toContain('b [missing]');
    }
  });
});

describe('resolveQmdModelsDir', () => {
  it('honors XDG_CACHE_HOME', () => {
    expect(resolveQmdModelsDir({ XDG_CACHE_HOME: '/x/cache' })).toBe('/x/cache/qmd/models');
  });

  it('falls back to ~/.cache when XDG_CACHE_HOME is unset', () => {
    expect(resolveQmdModelsDir({})).toBe(join(homedir(), '.cache', 'qmd', 'models'));
  });

  it('treats a blank XDG_CACHE_HOME as unset', () => {
    expect(resolveQmdModelsDir({ XDG_CACHE_HOME: '   ' })).toBe(
      join(homedir(), '.cache', 'qmd', 'models'),
    );
  });
});
