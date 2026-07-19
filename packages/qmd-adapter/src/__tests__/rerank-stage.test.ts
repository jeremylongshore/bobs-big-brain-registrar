import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RerankCache } from '../rerank/rerank-cache.js';
import { RerankClient } from '../rerank/rerank-client.js';
import { RerankStage, resolveCitationPath } from '../rerank/rerank-stage.js';
import type { QmdSearchResult } from '../types.js';

/**
 * Deterministic canned-score stub: each document embeds a `relevance=<x>`
 * marker; the stub scores the doc with exactly that number. This makes the
 * expected ordering a property of the test fixtures, not of any model.
 */
function startStub(): Promise<{ url: string; server: Server; calls: () => number }> {
  let callCount = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      callCount += 1;
      const parsed = JSON.parse(body) as { documents: string[] };
      const results = parsed.documents.map((doc, index) => {
        const match = /relevance=([0-9.]+)/.exec(doc);
        return { index, relevance_score: match ? Number(match[1]) : 0 };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server, calls: () => callCount });
    });
  });
}

/** A fused hit whose citation resolves into the temp export tree. */
function hit(name: string, fusedScore: number): QmdSearchResult {
  return {
    file: `qmd://kb-curated/${name}`,
    score: fusedScore,
    snippet: `snippet of ${name}`,
    collection: 'kb-curated',
  };
}

describe('RerankStage (B1) — opt-in reorder, fail-open to the fused order', () => {
  let exportDir: string;
  let server: Server | null = null;

  beforeAll(() => {
    exportDir = mkdtempSync(join(tmpdir(), 'rerank-stage-'));
    mkdirSync(join(exportDir, 'curated'), { recursive: true });
    // Fused order will be a, b, c, d — rerank markers invert it.
    writeFileSync(join(exportDir, 'curated', 'a.md'), 'doc a relevance=0.10 about nothing');
    writeFileSync(join(exportDir, 'curated', 'b.md'), 'doc b relevance=0.40 somewhat related');
    writeFileSync(join(exportDir, 'curated', 'c.md'), 'doc c relevance=0.90 highly relevant');
    writeFileSync(join(exportDir, 'curated', 'd.md'), 'doc d relevance=0.60 fairly relevant');
  });

  afterAll(() => {
    rmSync(exportDir, { recursive: true, force: true });
  });

  afterEach(() => {
    server?.close();
    server = null;
  });

  const fused = () => [hit('a.md', 0.9), hit('b.md', 0.8), hit('c.md', 0.7), hit('d.md', 0.6)];

  it('reorders the fused list by cross-encoder score', async () => {
    const stub = await startStub();
    server = stub.server;
    const stage = new RerankStage({
      client: new RerankClient({ url: stub.url }),
      exportDir,
    });
    const result = await stage.apply('query', fused());
    expect(result.map((r) => r.file)).toEqual([
      'qmd://kb-curated/c.md',
      'qmd://kb-curated/d.md',
      'qmd://kb-curated/b.md',
      'qmd://kb-curated/a.md',
    ]);
    // The returned score is the model's relevance score (read-path only).
    expect(result[0]?.score).toBeCloseTo(0.9);
  });

  it('truncates to topN and honours candidateWindow', async () => {
    const stub = await startStub();
    server = stub.server;
    const stage = new RerankStage({
      client: new RerankClient({ url: stub.url }),
      exportDir,
      candidateWindow: 3, // d.md never reaches the model
      topN: 2,
    });
    const result = await stage.apply('query', fused());
    // Among a, b, c the scores are 0.1, 0.4, 0.9 → c, b.
    expect(result.map((r) => r.file)).toEqual(['qmd://kb-curated/c.md', 'qmd://kb-curated/b.md']);
  });

  it('breaks score ties deterministically by prior fused rank', async () => {
    const stub = await startStub();
    server = stub.server;
    mkdirSync(join(exportDir, 'curated'), { recursive: true });
    writeFileSync(join(exportDir, 'curated', 'tie1.md'), 'tie one relevance=0.50');
    writeFileSync(join(exportDir, 'curated', 'tie2.md'), 'tie two relevance=0.50');
    const stage = new RerankStage({
      client: new RerankClient({ url: stub.url }),
      exportDir,
    });
    const list = [hit('tie2.md', 0.9), hit('tie1.md', 0.8)]; // tie2 first in fused order
    const result = await stage.apply('query', list);
    expect(result.map((r) => r.file)).toEqual([
      'qmd://kb-curated/tie2.md',
      'qmd://kb-curated/tie1.md',
    ]);
  });

  it('serves repeated queries from the cache — the model is called once', async () => {
    const stub = await startStub();
    server = stub.server;
    const cache = new RerankCache({ path: ':memory:', modelId: 'm', modelVersion: 'v' });
    const stage = new RerankStage({
      client: new RerankClient({ url: stub.url }),
      cache,
      exportDir,
    });
    const first = await stage.apply('query', fused());
    const second = await stage.apply('query', fused());
    expect(stub.calls()).toBe(1); // second pass fully cache-served
    expect(second.map((r) => r.file)).toEqual(first.map((r) => r.file));
    cache.close();
  });

  it('fails open to the fused order when the service is down (connection refused)', async () => {
    const stage = new RerankStage({
      client: new RerankClient({ url: 'http://127.0.0.1:1', timeoutMs: 300 }),
      exportDir,
    });
    const original = fused();
    const result = await stage.apply('query', original);
    expect(result).toEqual(original);
  });

  it('fails open to the fused order on timeout', async () => {
    server = createServer(() => {
      /* never respond */
    });
    const url = await new Promise<string>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const { port } = (server as Server).address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    const stage = new RerankStage({
      client: new RerankClient({ url, timeoutMs: 100 }),
      exportDir,
    });
    const original = fused();
    expect(await stage.apply('query', original)).toEqual(original);
  });

  it('fails open to the fused order on a non-200 response', async () => {
    server = createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const url = await new Promise<string>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const { port } = (server as Server).address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    const stage = new RerankStage({
      client: new RerankClient({ url }),
      exportDir,
    });
    const original = fused();
    expect(await stage.apply('query', original)).toEqual(original);
  });

  it('passes 0- and 1-element lists through untouched without calling the model', async () => {
    const stub = await startStub();
    server = stub.server;
    const stage = new RerankStage({
      client: new RerankClient({ url: stub.url }),
      exportDir,
    });
    expect(await stage.apply('query', [])).toEqual([]);
    const single = [hit('a.md', 0.9)];
    expect(await stage.apply('query', single)).toEqual(single);
    expect(stub.calls()).toBe(0);
  });

  it('falls back to the snippet when a citation does not resolve to an export file', async () => {
    const stub = await startStub();
    server = stub.server;
    const stage = new RerankStage({
      client: new RerankClient({ url: stub.url }),
      exportDir,
    });
    // Unresolvable citations → snippets carry the markers instead.
    const ghosts: QmdSearchResult[] = [
      {
        file: 'qmd://kb-curated/missing1.md',
        score: 0.9,
        snippet: 'relevance=0.20',
        collection: 'kb-curated',
      },
      {
        file: 'qmd://kb-curated/missing2.md',
        score: 0.8,
        snippet: 'relevance=0.80',
        collection: 'kb-curated',
      },
    ];
    const result = await stage.apply('query', ghosts);
    expect(result.map((r) => r.file)).toEqual([
      'qmd://kb-curated/missing2.md',
      'qmd://kb-curated/missing1.md',
    ]);
  });
});

describe('resolveCitationPath (B1)', () => {
  it('maps a collection citation through its export sourceSubdir', () => {
    expect(resolveCitationPath('/kb', 'qmd://kb-curated/note.md')).toBe('/kb/curated/note.md');
    expect(resolveCitationPath('/kb', 'qmd://kb-decisions/adr.md')).toBe('/kb/decisions/adr.md');
  });

  it('rejects unknown collections, non-qmd ids, and path-escaping file parts', () => {
    expect(resolveCitationPath('/kb', 'qmd://kb-inbox/x.md')).toBeNull(); // no export subdir
    expect(resolveCitationPath('/kb', 'qmd://not-a-collection/x.md')).toBeNull();
    expect(resolveCitationPath('/kb', '/etc/passwd')).toBeNull();
    expect(resolveCitationPath('/kb', 'qmd://kb-curated/../../etc/passwd')).toBeNull();
    expect(resolveCitationPath('/kb', 'qmd://kb-curated/')).toBeNull();
  });
});
