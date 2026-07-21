import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EmbedClient,
  EMBEDDINGGEMMA_DOCUMENT_PREFIX,
  EMBEDDINGGEMMA_QUERY_PREFIX,
} from '../dense/embed-client.js';

/** Start an in-process stub server; returns its base URL. */
function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Collect a request body as a string. */
function readBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => resolve(body));
  });
}

describe('EmbedClient (B4) — fail-open HTTP client for the local embedder', () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it('parses a well-formed /v1/embeddings response into per-input Float32Arrays', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1, 0] },
            { index: 0, embedding: [1, 0, 0] },
          ],
        }),
      );
    });
    const client = new EmbedClient({ url: await listen(server) });
    const vectors = await client.embed(['a', 'b'], 'document');
    expect(vectors).not.toBeNull();
    expect(vectors).toHaveLength(2);
    // Out-of-order response indexes land back in input order.
    expect(Array.from(vectors?.[0] ?? [])).toEqual([1, 0, 0]);
    expect(Array.from(vectors?.[1] ?? [])).toEqual([0, 1, 0]);
  });

  it('applies the EmbeddingGemma role prefixes to every input', async () => {
    let seenBody = '';
    server = createServer((req, res) => {
      void readBody(req).then((body) => {
        seenBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }));
      });
    });
    const client = new EmbedClient({ url: await listen(server) });

    await client.embed(['how is the audit verified'], 'query');
    expect(JSON.parse(seenBody).input).toEqual([
      `${EMBEDDINGGEMMA_QUERY_PREFIX}how is the audit verified`,
    ]);

    await client.embed(['the audit log doc'], 'document');
    expect(JSON.parse(seenBody).input).toEqual([
      `${EMBEDDINGGEMMA_DOCUMENT_PREFIX}the audit log doc`,
    ]);
  });

  it('returns [] without any HTTP call for an empty input list', async () => {
    // Point at a closed port: if the client tried to call out, it would fail.
    const client = new EmbedClient({ url: 'http://127.0.0.1:1' });
    expect(await client.embed([], 'query')).toEqual([]);
  });

  it('fails open (null) on connection refused', async () => {
    const client = new EmbedClient({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
    expect(await client.embed(['doc'], 'document')).toBeNull();
    expect(await client.healthy()).toBe(false);
  });

  it('fails open (null) on timeout', async () => {
    server = createServer(() => {
      /* never respond */
    });
    const client = new EmbedClient({ url: await listen(server), timeoutMs: 300 });
    expect(await client.embed(['doc'], 'document')).toBeNull();
  });

  it('fails open (null) on non-200', async () => {
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    const client = new EmbedClient({ url: await listen(server) });
    expect(await client.embed(['doc'], 'document')).toBeNull();
  });

  const malformed: Array<[string, unknown]> = [
    ['not JSON at all', undefined],
    ['missing data', {}],
    ['wrong count', { data: [{ index: 0, embedding: [1, 0] }] }],
    [
      'out-of-range index',
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 5, embedding: [0, 1] },
        ],
      },
    ],
    [
      'duplicate index leaves a hole',
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] },
        ],
      },
    ],
    [
      'ragged dimensions',
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [0, 1, 0] },
        ],
      },
    ],
    [
      'non-finite component',
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [0, null] },
        ],
      },
    ],
    [
      'empty embedding',
      {
        data: [
          { index: 0, embedding: [] },
          { index: 1, embedding: [] },
        ],
      },
    ],
  ];
  for (const [label, payload] of malformed) {
    it(`fails open (null) on a malformed response: ${label}`, async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload === undefined ? '<html>nope' : JSON.stringify(payload));
      });
      const client = new EmbedClient({ url: await listen(server) });
      expect(await client.embed(['a', 'b'], 'document')).toBeNull();
    });
  }

  it('healthy() is true against a 200 /health', async () => {
    server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200);
        res.end('{"status":"ok"}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const client = new EmbedClient({ url: await listen(server) });
    expect(await client.healthy()).toBe(true);
  });
});
