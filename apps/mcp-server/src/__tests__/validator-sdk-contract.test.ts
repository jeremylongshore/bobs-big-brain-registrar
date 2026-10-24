import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContentMetadata } from '@qmd-team-intent-kb/schema';

/** Public SDK entrypoints, actual transports, and the parser selected by that installation. */
async function roundTrip(
  Parser: typeof z,
  Server = McpServer,
  Transport = InMemoryTransport,
  ClientConstructor = Client,
) {
  let visits = 0;
  let calls = 0;
  const element = Parser.string().refine(() => {
    visits++;
    return true;
  });
  const values = Parser.array(element).max(2);
  expect(values).toHaveProperty('_zod');
  const server = new Server({ name: 'validator-contract', version: '1' });
  server.registerTool(
    'bounded',
    {
      inputSchema: {
        values,
        mode: Parser.enum(['safe', 'inspect']).default('safe'),
        metadata: ContentMetadata.optional(),
      },
    },
    async (args) => {
      calls++;
      return { content: [{ type: 'text', text: JSON.stringify(args) }] };
    },
  );
  const client = new ClientConstructor({ name: 'fixture', version: '1' });
  const [clientTransport, serverTransport] = Transport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(await client.listTools()).toMatchObject({
      tools: [
        {
          name: 'bounded',
          inputSchema: {
            properties: {
              values: { type: 'array', maxItems: 2 },
              mode: { enum: ['safe', 'inspect'], default: 'safe' },
            },
          },
        },
      ],
    });
    expect(
      await client.callTool({
        name: 'bounded',
        arguments: { values: ['a', 'b'], metadata: { subjects: ['fixture.policy'] } },
      }),
    ).toMatchObject({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            values: ['a', 'b'],
            mode: 'safe',
            metadata: { filePaths: [], tags: [], subjects: ['fixture.policy'] },
          }),
        },
      ],
    });
    expect(calls).toBe(1);
    expect(visits).toBe(2);
    visits = 0;
    expect(
      await client.callTool({ name: 'bounded', arguments: { values: ['a', 'b', 'c'] } }),
    ).toMatchObject({ isError: true });
    expect(visits).toBe(0);
    expect(
      await client.callTool({ name: 'bounded', arguments: { values: [], mode: 'invalid' } }),
    ).toMatchObject({ isError: true });
    expect(calls).toBe(1);
    // Also cover the exact resolved parser's other fixed collection entrypoints.
    expect(
      Parser.set(element)
        .max(2)
        .safeParse(new Set(['a', 'b', 'c'])).success,
    ).toBe(false);
    expect(
      Parser.map(element, element)
        .max(2)
        .safeParse(
          new Map([
            ['a', 'one'],
            ['b', 'two'],
            ['c', 'three'],
          ]),
        ).success,
    ).toBe(false);
    expect(visits).toBe(0);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('actual MCP SDK and Zod4 contracts', () => {
  it('converts and validates application SDK schemas through the patched v4 path', async () => {
    await roundTrip(z);
  });

  it('converts and validates through qmd’s exact resolved parser and SDK peer instance', async () => {
    const requireQmd = createRequire(import.meta.resolve('@tobilu/qmd'));
    const zodRoot = dirname(requireQmd.resolve('zod'));
    const zodPackage = JSON.parse(readFileSync(join(zodRoot, 'package.json'), 'utf8'));
    const sdkRoot = resolve(
      dirname(requireQmd.resolve('@modelcontextprotocol/sdk/server/mcp.js')),
      '../../..',
    );
    const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
    expect(sdkPackage.version).toBe('1.32.2');
    // Follow the packages' declared import exports, not require's CJS copy.
    const Parser: { z: typeof z } = await import(
      pathToFileURL(join(zodRoot, zodPackage.exports['.'].import)).href
    );
    const sdkEntry = (name: string) =>
      pathToFileURL(join(sdkRoot, sdkPackage.exports['./*'].import.replace('*', name))).href;
    const Server: { McpServer: typeof McpServer } = await import(sdkEntry('server/mcp.js'));
    const Transport: { InMemoryTransport: typeof InMemoryTransport } = await import(
      sdkEntry('inMemory.js')
    );
    const QmdClient: { Client: typeof Client } = await import(sdkEntry('client/index.js'));
    await roundTrip(Parser.z, Server.McpServer, Transport.InMemoryTransport, QmdClient.Client);
  });
});
