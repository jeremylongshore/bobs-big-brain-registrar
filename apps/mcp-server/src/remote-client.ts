#!/usr/bin/env node
/**
 * intent-brain remote client — the self-contained MCP server shipped in the
 * marketplace plugin.
 *
 * Members install the plugin and this stdio server runs locally, proxying the
 * single read tool (`teamkb_search`) to the governed brain API over the tailnet.
 * Deliberately minimal: no database, no qmd-adapter, no native modules — so it
 * bundles (esbuild) to ONE self-contained file that runs from a marketplace
 * clone with zero install/build. Admin capture/govern stays on team-server.
 *
 * Env:
 *   TEAMKB_API_URL    — brain API base (e.g. http://dev:3847). Required for results.
 *   TEAMKB_API_TOKEN  — per-user bearer token (sent as Authorization: Bearer).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.4.0';
const API_URL = process.env['TEAMKB_API_URL'];
const API_TOKEN = process.env['TEAMKB_API_TOKEN'];

interface CitedHit {
  citation: string;
  snippet: string;
  score: number;
  title?: string;
  collection?: string;
}

async function search(
  query: string,
  scope: string,
  limit: number,
): Promise<{ source: string; query: string; scope: string; count: number; results: CitedHit[] }> {
  const empty = { source: 'brain-api', query, scope, count: 0, results: [] as CitedHit[] };
  if (API_URL === undefined || API_URL === '') {
    return { ...empty, source: 'unconfigured' };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (API_TOKEN !== undefined && API_TOKEN !== '') {
    headers['authorization'] = `Bearer ${API_TOKEN}`;
  }
  const url = `${API_URL.replace(/\/+$/, '')}/api/search`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, scope, pagination: { page: 1, pageSize: limit } }),
    });
    if (!res.ok) return empty;
    const body = (await res.json()) as {
      hits?: Array<{
        citation?: string;
        snippet?: string;
        score?: number;
        title?: string;
        collection?: string;
      }>;
    };
    const results: CitedHit[] = (body.hits ?? [])
      .filter((h) => typeof h.citation === 'string' && h.citation.length > 0)
      .map((h) => ({
        citation: h.citation as string,
        snippet: typeof h.snippet === 'string' ? h.snippet : '',
        score: typeof h.score === 'number' ? h.score : 0,
        title: h.title,
        collection: h.collection,
      }));
    return { source: 'brain-api', query, scope, count: results.length, results };
  } catch {
    return empty;
  }
}

const server = new McpServer({ name: 'teamkb', version: VERSION });

server.tool(
  'teamkb_search',
  'Search the governed team knowledge brain and return qmd:// citations. Every hit is anchored to a verifiable source — receipts, not recall. Read-only; curated scope by default. Proxies to the brain over the tailnet.',
  {
    query: z.string().min(1).describe('Natural-language search query'),
    scope: z
      .enum(['curated', 'all', 'inbox', 'archived'])
      .optional()
      .describe('Search scope: curated (default), all, inbox, or archived'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of cited hits to return (default 10)'),
  },
  async (params) => {
    const result = await search(params.query, params.scope ?? 'curated', params.limit ?? 10);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  const shutdown = async (sig: string): Promise<void> => {
    process.stderr.write(`[teamkb-remote] ${sig}, shutting down\n`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await server.connect(transport);
  process.stderr.write(
    `[teamkb-remote] started — brain=${API_URL ?? '(TEAMKB_API_URL unset)'} token=${API_TOKEN ? 'set' : 'none'}\n`,
  );
}

void main();
