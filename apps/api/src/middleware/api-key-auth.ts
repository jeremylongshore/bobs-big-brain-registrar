import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * Compare two strings in constant time to prevent timing attacks.
 * Pads the shorter string to match lengths before comparison.
 */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  // timingSafeEqual requires equal-length buffers.
  // If lengths differ, compare against a dummy buffer (constant-time rejection).
  if (bufA.length !== bufB.length) {
    // Still call timingSafeEqual so the timing profile stays constant
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * Bearer token authentication middleware.
 *
 * Security model:
 * - **Production (NODE_ENV=production)**: API key is REQUIRED. If not set,
 *   the server refuses to start (fail-closed).
 * - **Development**: If TEAMKB_API_KEY is not set, authentication is skipped.
 * - Token comparison uses `crypto.timingSafeEqual` to prevent timing attacks.
 * - The health endpoint is always exempt.
 */
export function registerApiKeyAuth(app: FastifyInstance, apiKey: string | undefined): void {
  const isProduction = process.env['NODE_ENV'] === 'production';

  if (apiKey === undefined || apiKey === '') {
    if (isProduction) {
      throw new Error(
        'TEAMKB_API_KEY must be set in production. Refusing to start without authentication.',
      );
    }
    return; // Dev mode — no auth required
  }

  app.addHook('onRequest', async (request, reply) => {
    // The health endpoint is always public so liveness probes (tailnet
    // monitoring, deploy smokes) can reach it without a token. The route is
    // registered at /api/health.
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

    if (scheme !== 'Bearer' || !timingSafeCompare(token, apiKey)) {
      reply.status(401);
      throw new Error('Invalid API key');
    }
  });
}
