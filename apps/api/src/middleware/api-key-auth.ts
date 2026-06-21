import type { FastifyInstance } from 'fastify';
import type { TokenRegistry, TokenRole } from '../auth/token-registry.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Audit actor resolved from the bearer token (undefined in dev no-auth). */
    actor?: string;
    /** Role granted by the token. `admin` may write/promote. */
    role?: TokenRole;
    /**
     * Tenant allowlist bound to the bearer token (undefined when the token is
     * unscoped / dev no-auth). The tenancy guard enforces that any
     * request-supplied tenantId is a member of this list — server-side, so a
     * caller cannot escape their tenant scope by changing the request body.
     */
    tenants?: readonly string[];
  }
}

/** Options that shape the auth/no-auth decision at boot. */
export interface ApiKeyAuthOptions {
  /**
   * The interface the server will bind. Used by the no-auth safety assertion:
   * the registry may be empty (dev no-auth) ONLY when the bind is loopback.
   * A non-loopback bind with no tokens is refused — an unauthenticated brain
   * must never be reachable off-host. Default: `127.0.0.1` (loopback).
   */
  bindHost?: string;
}

/**
 * Loopback hosts the no-auth dev path is allowed to bind. IPv4 loopback is the
 * whole 127/8 block; IPv6 loopback is `::1`. `localhost` resolves to one of
 * these. Anything else (a tailnet 100.x, a LAN 10.x/192.168.x, or 0.0.0.0) is
 * treated as off-host and may NOT run without authentication.
 *
 * An empty / whitespace-only host is explicitly NON-loopback. Node/libuv binds
 * an empty host to `::` (all interfaces), so classifying it as loopback would
 * let an unauthenticated brain be reachable off-host while still passing the
 * boot assertion. loadConfig() coerces '' to 127.0.0.1, but a caller that
 * constructs AppDependencies with bindHost:'' directly bypasses that — so we
 * fail closed here too: isLoopbackHost('') === false trips the boot refusal.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1' || h === '[::1]') return true;
  // IPv4 loopback block 127.0.0.0/8.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Per-user bearer token authentication middleware.
 *
 * ## Security model (EPIC 0 hardening — compile-then-govern-c5k)
 *
 * - **Authenticated**: each request's bearer token is hashed under the stored
 *   salt and compared (constant-time) to resolve `{ actor, role, tenants? }`.
 *   Unknown / expired / live-revoked tokens get 401.
 * - **Production (`NODE_ENV=production`)**: the registry MUST be non-empty or
 *   the server refuses to start (fail-closed). There is no no-auth path in prod.
 * - **No-auth dev path is LOOPBACK-ONLY and refuses to grant admin off-host.**
 *   When the registry is empty the server may run unauthenticated ONLY if BOTH:
 *   (a) `NODE_ENV !== production`, AND (b) the bind host is loopback. Any other
 *   combination throws at boot — an unauthenticated brain stamping `role=admin`
 *   on every request must never be reachable from another machine. This closes
 *   the prior silent-admin gap where an unset `NODE_ENV` + a tailnet/`0.0.0.0`
 *   bind ran fully open with admin.
 * - `/api/health`, `/openapi.json`, and `/docs*` are always exempt.
 *
 * The resolved `actor`/`role`/`tenants` are decorated onto the request for
 * downstream audit logging, the admin-only write gate, and the tenancy guard.
 */
export function registerApiKeyAuth(
  app: FastifyInstance,
  registry: TokenRegistry,
  options: ApiKeyAuthOptions = {},
): void {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const bindHost = options.bindHost ?? '127.0.0.1';
  const loopback = isLoopbackHost(bindHost);

  app.decorateRequest('actor', undefined);
  app.decorateRequest('role', undefined);
  app.decorateRequest('tenants', undefined);

  if (registry.isEmpty()) {
    // Fail-closed assertion 1: never run unauthenticated in production.
    if (isProduction) {
      throw new Error(
        'TEAMKB_API_KEY (or a token registry) must be set in production. ' +
          'Refusing to start without authentication.',
      );
    }
    // Fail-closed assertion 2: never run unauthenticated off-loopback. An empty
    // registry means every request would be stamped role=admin; that is only
    // acceptable when the socket is unreachable from other machines.
    if (!loopback) {
      throw new Error(
        `Refusing to start unauthenticated on a non-loopback interface (host=${bindHost}). ` +
          'No tokens are configured, so every request would run as role=admin. ' +
          'Either configure TEAMKB_API_KEY / TEAMKB_TOKENS(_FILE), or bind 127.0.0.1.',
      );
    }
    // Loopback dev mode — no auth, but stamp a known actor so audit logs are
    // populated. Safe because the socket is loopback-only.
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
    request.tenants = identity.tenants;
  });
}
