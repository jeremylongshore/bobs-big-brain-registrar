#!/usr/bin/env node
/**
 * TeamKB MCP Server entry point.
 *
 * Reads configuration from environment variables, creates the McpServer,
 * connects via StdioServerTransport, and handles graceful shutdown on
 * SIGINT / SIGTERM.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveConfig } from './config.js';
import { createServer, isQmdAvailable } from './server.js';

async function main(): Promise<void> {
  const config = resolveConfig();
  const withSync = await isQmdAvailable();
  const canWrite = config.role === 'admin';

  const server = createServer(config, { withSync, canWrite });
  const transport = new StdioServerTransport();

  // Graceful shutdown — close the transport cleanly before exiting
  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[teamkb-mcp] Received ${signal}, shutting down\n`);
    try {
      await server.close();
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[teamkb-mcp] Error during shutdown: ${msg}\n`);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.connect(transport);
  process.stderr.write(
    `[teamkb-mcp] Started — tenant=${config.tenantId} role=${config.role ?? 'member'} write=${canWrite} sync=${withSync}\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[teamkb-mcp] Fatal: ${msg}\n`);
  process.exit(1);
});
