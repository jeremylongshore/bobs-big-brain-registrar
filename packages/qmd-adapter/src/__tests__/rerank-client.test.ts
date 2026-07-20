import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { RerankClient } from '../rerank/rerank-client.js';

/** Start an in-process stub server; returns its base URL. */
function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('RerankClient (B1) — fail-open HTTP client for the local reranker', () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it('parses a well-formed /v1/rerank response into branded scored docs', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.1 },
          ],
        }),
      );
    });
    const client = new RerankClient({ url: await listen(server) });
    const scored = await client.rerank('q', ['doc a', 'doc b']);
    expect(scored).not.toBeNull();
    expect(scored).toHaveLength(2);
    expect(scored?.[0]).toMatchObject({ index: 1 });
    expect(scored?.[0]?.score).toBeCloseTo(0.9);
  });

  it('returns [] without any HTTP call for an empty document list', async () => {
    // Point at a closed port: if the client tried to call out, it would fail.
    const client = new RerankClient({ url: 'http://127.0.0.1:1' });
    expect(await client.rerank('q', [])).toEqual([]);
  });

  it('fails open (null) on connection refused', async () => {
    const client = new RerankClient({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
    expect(await client.rerank('q', ['doc'])).toBeNull();
    expect(await client.healthy()).toBe(false);
  });

  it('fails open (null) on timeout', async () => {
    server = createServer(() => {
      /* never respond */
    });
    const client = new RerankClient({ url: await listen(server), timeoutMs: 100 });
    expect(await client.rerank('q', ['doc'])).toBeNull();
  });

  it('fails open (null) on a non-200 status', async () => {
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    const client = new RerankClient({ url: await listen(server) });
    expect(await client.rerank('q', ['doc'])).toBeNull();
  });

  it('fails open (null) on a non-JSON body', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('this is not json');
    });
    const client = new RerankClient({ url: await listen(server) });
    expect(await client.rerank('q', ['doc'])).toBeNull();
  });

  it('fails open (null) on a malformed row (out-of-range index / missing score)', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [{ index: 5, relevance_score: 0.9 }] }));
    });
    const client = new RerankClient({ url: await listen(server) });
    expect(await client.rerank('q', ['doc'])).toBeNull();
  });

  it('health probe returns true when /health answers 200', async () => {
    server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const client = new RerankClient({ url: await listen(server) });
    expect(await client.healthy()).toBe(true);
  });
});
