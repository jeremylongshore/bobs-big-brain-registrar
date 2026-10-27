import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

describe('bundled Registrar remote client contradiction contract', () => {
  it.each(['available', 'unavailable', 'absent', 'malformed', 'duplicate'])(
    'forwards %s graph evidence over actual MCP stdio',
    async (kind) => {
      const reference = { memoryId: randomUUID(), title: 'fixture reference' };
      const metadata =
        kind === 'available'
          ? { status: 'available', references: [reference] }
          : kind === 'unavailable'
            ? { status: 'unavailable' }
            : kind === 'duplicate'
              ? { status: 'available', references: [reference, reference] }
              : kind === 'malformed'
                ? {
                    status: 'available',
                    references: [{ memoryId: 'invalid', title: 'do-not-forward' }],
                  }
                : undefined;
      const server = createServer((_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            hits: [
              {
                citation: 'qmd://kb-curated/a.md',
                snippet: 'fixture',
                score: 0.5,
                contradictions: metadata,
              },
            ],
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL('../../../../plugin-runtime/teamkb-remote.cjs', import.meta.url)),
        ],
        env: {
          ...getDefaultEnvironment(),
          TEAMKB_API_URL: `http://127.0.0.1:${address.port}`,
          TEAMKB_API_TOKEN: 'synthetic-token',
        },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'contradiction-fixture', version: '1' });
      try {
        await client.connect(transport);
        const result = await client.callTool({
          name: 'teamkb_search',
          arguments: { query: 'fixture' },
        });
        const content = result.content as { type: string; text: string }[];
        const output = JSON.parse(content[0]!.text) as {
          results: { citation: string; contradictions?: unknown }[];
        };
        expect(output.results[0]!.citation).toBe('qmd://kb-curated/a.md');
        expect(output.results[0]!.contradictions).toEqual(
          kind === 'available'
            ? metadata
            : kind === 'absent'
              ? undefined
              : { status: 'unavailable' },
        );
        expect(JSON.stringify(output)).not.toContain('do-not-forward');
      } finally {
        await client.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
