import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';

/**
 * Fixed envelope written by the Registrar's generic MCP proposal tool.
 * Identifies a capture surface, not an authenticated scout or physical human.
 * Deliberate operator captures on other surfaces retain their existing behavior.
 */
export function requiresRegistrarMcpReview(candidate: MemoryCandidate): boolean {
  return (
    candidate.source === 'mcp' &&
    candidate.author.type === 'ai' &&
    candidate.author.id === 'mcp-server'
  );
}
