import type { FastifyInstance } from 'fastify';
import type { TokenRegistry, TokenRole } from '../auth/token-registry.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Audit actor resolved from the bearer token (undefined in dev no-auth). */
    actor?: string;
    /** Role granted by the token. `admin` may write/promote. */
    role?: TokenRole;
  }
}

/**
 * Per-user bearer token authentication middleware.
 *
 * Security model:
 * - **Production (NODE_ENV=production)**: the registry must be non-empty, or
 *   the server refuses to start (fail-closed).
 * - **Development**: an empty registry means auth is skipped; requests run as
 *   actor `dev`.
 * - Each request's bearer token is resolved to an identity (actor + role) in
 *   constant time. Unknown/revoked tokens get 401.
 * - `/api/health` is always exempt so liveness probes work without a token.
 *
 * The resolved `actor`/`role` are decorated onto the request for downstream
 * audit logging and the admin-only write gate.
 */
export function registerApiKeyAuth(app: FastifyInstance, registry: TokenRegistry): void {
  const isProduction = process.env['NODE_ENV'] === 'production';

  app.decorateRequest('actor', undefined);
  app.decorateRequest('role', undefined);

  if (registry.isEmpty()) {
    if (isProduction) {
      throw new Error(
        'TEAMKB_API_KEY (or a token registry) must be set in production. Refusing to start without authentication.',
      );
    }
    // Dev mode — no auth, but stamp a known actor so audit logs are populated.
    app.addHook('onRequest', async (request) => {
      request.actor = 'dev';
      request.role = 'admin';
    });
    return;
  }

  app.addHook('onRequest', async (request, reply) => {
    // The health endpoint is always public so liveness probes (tailnet
    // monitoring, deploy smokes) can reach it without a token.
    if (request.url === '/api/health' || request.url === '/api/health/') {
      return;
    }

    // OpenAPI spec and docs UI are always public.
    if (
      request.url === '/openapi.json' ||
      request.url === '/docs' ||
      request.url.startsWith('/docs/')
    ) {
      return;
    }

    const authHeader = request.headers['authorization'];

    if (authHeader === undefined) {
      reply.status(401);
      throw new Error('Missing Authorization header');
    }

    const spaceIndex = authHeader.indexOf(' ');
    if (spaceIndex === -1) {
      reply.status(401);
      throw new Error('Invalid Authorization header format');
    }

    const scheme = authHeader.slice(0, spaceIndex);
    const token = authHeader.slice(spaceIndex + 1);

    if (scheme !== 'Bearer') {
      reply.status(401);
      throw new Error('Invalid API key');
    }

    const identity = registry.resolve(token);
    if (identity === undefined) {
      reply.status(401);
      throw new Error('Invalid API key');
    }

    request.actor = identity.actor;
    request.role = identity.role;
  });
}
