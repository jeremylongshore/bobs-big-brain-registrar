import type { FastifyInstance } from 'fastify';
import { appendRevokedActor, type TokenRegistry } from '../auth/token-registry.js';

/**
 * Token-revocation routes — EPIC 0 hardening (compile-then-govern-c5k) plus the
 * durable revoke-by-actor added for the R2 review gate (jfv.6.2).
 *
 * Two ways to cut a token off without editing `tokens.json` and restarting:
 *
 * 1. `POST /api/auth/revoke` — by VALUE. Body `{ "token": "<secret>" }`. The
 *    caller must hold the plaintext secret. In-memory only (lost on restart).
 * 2. `POST /api/auth/revoke-actor` — by IDENTITY. Body `{ "actor": "<actor>" }`.
 *    Needs NO secret, so it works after E1 hashed tokens at rest (an admin holds
 *    no plaintext to pass to route #1). This is the revoke path for the real
 *    incident — "Tim's laptop was stolen" — and it is DURABLE: the actor is
 *    appended to the revocation list (`TEAMKB_REVOKED_FILE`, default
 *    `~/.teamkb/revoked-actors.json`) so the boot loader re-applies it and the
 *    actor stays revoked across a restart.
 *
 * Both are admin-only, enforced by the write gate (which gates `/api/auth/*`
 * mutations) — no per-route role check needed here.
 *
 * Note on route #1: the request body carries the plaintext secret. That is
 * unavoidable for a revoke-by-value endpoint and is acceptable because (a) the
 * call itself is admin-authenticated over the same loopback/tailnet channel as
 * every other write, and (b) the registry compares it against the stored salted
 * hash and never persists it.
 *
 * @param registry     the token registry to revoke against (in-memory, immediate)
 * @param revokedFile  path to the durable revocation list; when set,
 *                     revoke-by-actor appends to it so the ban survives a
 *                     restart. When unset (dev/tests), revocation is in-memory
 *                     only and no file is touched.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  registry: TokenRegistry,
  revokedFile?: string,
): void {
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

  app.post(
    '/api/auth/revoke-actor',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke ALL of an actor’s tokens durably (by identity) — admin only',
        description:
          'Cuts off every live token belonging to `actor`, in-process and ' +
          'immediately, and appends the actor to the durable revocation list so ' +
          'the ban survives a restart. Needs no plaintext secret — the revoke ' +
          'path for hashed-at-rest tokens (a stolen laptop). Admin-only. Returns ' +
          '`{ revoked: <count> }` — the number of live records cut off.',
      },
    },
    async (request, reply) => {
      const body = request.body as { actor?: unknown; reason?: unknown } | undefined;
      const actor = body?.actor;
      if (typeof actor !== 'string' || actor.length === 0) {
        return reply.code(400).send({
          error: 'actor is required',
          message: 'Supply the actor to revoke in the request body: { "actor": "..." }.',
        });
      }
      const reason =
        typeof body?.reason === 'string' && body.reason.length > 0 ? body.reason : undefined;

      // In-memory first (immediate effect), then persist (durable across
      // restart). Persist even when the count is 0: a ban is on the identity,
      // so an actor with no CURRENTLY-loaded token still gets banned for any
      // future token — the whole point of a durable, identity-scoped list.
      const revoked = registry.revokeByActor(actor);
      if (revokedFile !== undefined && revokedFile !== '') {
        try {
          appendRevokedActor(revokedFile, actor, reason);
        } catch (err) {
          // The in-memory revocation already took effect; a failed persist must
          // not fail the request. Log so the operator knows the ban is not yet
          // durable and can retry / fix the path.
          const msg = err instanceof Error ? err.message : String(err);
          request.log.error(
            { err: msg, revokedFile },
            'revoke-actor: in-memory revoke succeeded but persisting to the revocation file failed',
          );
        }
      }
      return reply.send({ revoked });
    },
  );
}
