import type { FastifyInstance } from 'fastify';
import type { TokenRegistry } from '../auth/token-registry.js';

/**
 * Live token-revocation route — EPIC 0 hardening (compile-then-govern-c5k).
 *
 * Before this, the only way to revoke a bearer token was edit `tokens.json` and
 * restart the process. That is a slow, disruptive incident response: a leaked
 * token stays live until the next restart. This endpoint lets an admin cut a
 * token off IN-PROCESS, immediately, with no restart.
 *
 * `POST /api/auth/revoke` — body `{ "token": "<the-secret-to-revoke>" }`.
 * Admin-only (enforced by the write gate, which gates `/api/auth/*` mutations).
 * Returns `{ revoked: true }` if a live record matched, `{ revoked: false }`
 * otherwise. Revocation is permanent for the life of the process; the operator
 * should also drop the record from `tokens.json` so a restart does not revive it.
 *
 * Note: the request body carries the plaintext secret. That is unavoidable for a
 * revoke-by-value endpoint and is acceptable because (a) the call itself is
 * admin-authenticated over the same loopback/tailnet channel as every other
 * write, and (b) the registry compares it against the stored salted hash and
 * never persists it.
 */
export function registerAuthRoutes(app: FastifyInstance, registry: TokenRegistry): void {
  app.post(
    '/api/auth/revoke',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke a bearer token live (no restart) — admin only',
        description:
          'Cuts a token off in-process immediately. Admin-only. Returns ' +
          '`{ revoked: true }` when a live record matched. The operator should ' +
          'also drop the record from tokens.json so a restart does not revive it.',
      },
    },
    async (request, reply) => {
      const body = request.body as { token?: unknown } | undefined;
      const token = body?.token;
      if (typeof token !== 'string' || token.length === 0) {
        return reply.code(400).send({
          error: 'token is required',
          message: 'Supply the bearer token to revoke in the request body: { "token": "..." }.',
        });
      }
      const revoked = registry.revoke(token);
      return reply.send({ revoked });
    },
  );
}
