import type { FastifyInstance } from 'fastify';

/**
 * Governance write gate — "Jeremy-only promote".
 *
 * The governed corpus is mutated only by admin tokens. Members may read
 * (search, GET) and *propose* (POST /api/candidates queues for review), but the
 * acts that change governed state — promoting/transitioning a memory, editing
 * policy, bulk-importing or rolling back — require an admin role.
 *
 * Enforced server-side as an onRequest hook that runs after auth has stamped
 * `request.role`. Client-side tool gating (the MCP server hiding write tools
 * from members) is a UX nicety; this is the real boundary.
 */
const ADMIN_WRITE_PREFIXES = ['/api/memories', '/api/policies', '/api/import'];
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerWriteGate(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATION_METHODS.has(request.method)) {
      return;
    }

    const path = request.url.split('?')[0] ?? request.url;
    const isAdminWrite = ADMIN_WRITE_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
    if (!isAdminWrite) {
      return;
    }

    if (request.role !== 'admin') {
      reply.status(403);
      throw new Error(
        'This action requires an admin token. Members may read and propose; promoting, policy edits, and imports are admin-only.',
      );
    }
  });
}
