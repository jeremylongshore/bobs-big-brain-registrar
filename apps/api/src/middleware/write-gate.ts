import type { FastifyInstance } from 'fastify';

/**
 * Governance write gate — "Jeremy-only promote".
 *
 * The governed corpus is mutated only by admin tokens. Members may read
 * (search, GET) and *propose* (POST /api/candidates queues for review), but the
 * acts that change governed state — promoting/transitioning a memory, editing
 * policy, bulk-importing or rolling back — require an admin role. Live token
 * revocation (`POST /api/auth/revoke`) is likewise an admin act.
 *
 * Enforced server-side as an onRequest hook that runs after auth has stamped
 * `request.role`. Client-side tool gating (the MCP server hiding write tools
 * from members) is a UX nicety; this is the real boundary.
 */
const ADMIN_WRITE_PREFIXES = ['/api/memories', '/api/policies', '/api/import', '/api/auth'];
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Promoting a candidate is an admin act, but it lives under `/api/candidates`
 * (which is otherwise member-allowed for propose), so it needs its own match
 * rather than a prefix: `POST /api/candidates/:id/promote`.
 */
const PROMOTE_PATH = /^\/api\/candidates\/[^/]+\/promote$/;

export function registerWriteGate(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATION_METHODS.has(request.method)) {
      return;
    }

    const path = request.url.split('?')[0] ?? request.url;
    const isAdminWrite =
      PROMOTE_PATH.test(path) ||
      ADMIN_WRITE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
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
