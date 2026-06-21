import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Tenant-isolation guard — binds every tenant-scoped read/write to the bearer
 * token's tenant allowlist, server-side.
 *
 * EPIC 0 hardening (compile-then-govern-c5k). Before this guard the `tenantId`
 * was caller-controlled: any valid token could read or write any tenant's data
 * by naming a different tenant in the request body or query. That is the core
 * cross-tenant leak/inject break. The fix is a single rule:
 *
 *   the request-supplied tenantId MUST be a member of the token's allowlist.
 *
 * The allowlist lives on the resolved identity (`request.tenants`), never on
 * the request — a caller can never widen their own scope by editing the body.
 *
 * Two enforcement points:
 *
 * 1. **Tenant binding (`preHandler`)** — runs after body parsing so both the
 *    parsed body and the query string are available. The binding is a single
 *    server-side rule with two halves:
 *
 *    a. **Mismatch is rejected.** Any tenantId present in body or query that is
 *       not in the token's allowlist is rejected 403.
 *    b. **Omission is resolved server-side, never trusted to fall through.** A
 *       scoped token that omits tenantId must NOT reach an unfiltered all-tenant
 *       query (the c5k.2 cross-tenant leak: `SearchQuery.tenantId` is
 *       `.optional()`, so an omitted field parsed clean and `searchByText`
 *       /qmd then ran with no tenant filter). When the token is scoped to
 *       exactly one tenant we INJECT that tenant onto the request (body for
 *       POST /api/search, query for GET /api/memories) so the downstream
 *       handler is always tenant-filtered. When the token is scoped to multiple
 *       tenants we cannot guess which one is meant, so we reject 400 and require
 *       the caller to name one (which half (a) then verifies).
 *
 *    Unscoped tokens (empty allowlist — the single-tenant team default and
 *    cross-tenant admin tokens) are unaffected.
 *
 * 2. **Raw-inbox read restriction (`onRequest`)** — `GET /api/candidates*` is
 *    the pre-governance inbox (raw, un-curated proposals that may carry content
 *    that has not yet crossed the disclosure filter). It is admin-only; the
 *    mutation-only write gate never covered GET, so any bearer token could read
 *    it. This closes that gap.
 *
 * Both hooks are skipped for the always-public health / docs endpoints (auth is
 * also skipped there, so `request.tenants` is never set).
 */

/** The raw pre-governance inbox — admin-only on every method, including reads. */
const CANDIDATES_PREFIX = '/api/candidates';

/** Paths that never carry a token identity (auth-exempt) — skip the guard. */
function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return (
    path === '/api/health' ||
    path === '/api/health/' ||
    path === '/openapi.json' ||
    path === '/docs' ||
    path.startsWith('/docs/')
  );
}

/** Pull a `tenantId` from the query string, if present and non-empty. */
function queryTenantId(request: FastifyRequest): string | undefined {
  const q = request.query as { tenantId?: unknown } | undefined;
  const t = q?.tenantId;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

/** Pull a `tenantId` from a parsed JSON body, if present and non-empty. */
function bodyTenantId(request: FastifyRequest): string | undefined {
  const b = request.body as { tenantId?: unknown } | undefined;
  const t = b?.tenantId;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

/**
 * Inject the token's sole tenant onto the request so a scoped token that omits
 * tenantId is resolved server-side instead of falling through to an unfiltered
 * all-tenant query (c5k.2). Writes to BOTH the parsed body (POST /api/search
 * reads `request.body.tenantId`) and the query object (GET /api/memories reads
 * `request.query.tenantId`); only the field the downstream handler actually
 * reads matters, writing both keeps this route-agnostic. Existing non-empty
 * values are never overwritten — half (a) already validated those.
 */
function injectEffectiveTenant(request: FastifyRequest, tenantId: string): void {
  if (request.body !== null && typeof request.body === 'object') {
    const body = request.body as Record<string, unknown>;
    if (bodyTenantId(request) === undefined) body['tenantId'] = tenantId;
  }
  if (request.query !== null && typeof request.query === 'object') {
    const query = request.query as Record<string, unknown>;
    if (queryTenantId(request) === undefined) query['tenantId'] = tenantId;
  }
}

export function registerTenancyGuard(app: FastifyInstance): void {
  // (2) Raw-inbox reads are admin-only. Runs at onRequest (query available),
  // before the handler. POST /api/candidates (propose) stays member-allowed;
  // only the GET reads of the raw inbox are locked to admin.
  app.addHook('onRequest', async (request, reply) => {
    if (isPublicPath(request.url)) return;
    if (request.method !== 'GET') return;

    const path = request.url.split('?')[0] ?? request.url;
    const isCandidatesRead = path === CANDIDATES_PREFIX || path.startsWith(`${CANDIDATES_PREFIX}/`);
    if (!isCandidatesRead) return;

    // Dev no-auth runs as admin (request.role === 'admin'); only a non-admin
    // authenticated token is refused.
    if (request.role !== 'admin') {
      reply.status(403);
      throw new Error(
        'The raw candidate inbox is admin-only. It holds pre-governance proposals; ' +
          'members may propose and read the governed corpus, not the raw inbox.',
      );
    }
  });

  // (1) Tenant binding. Runs at preHandler so request.body is parsed and both
  // body + query tenantId are visible. Enforced for every route.
  app.addHook('preHandler', async (request, reply) => {
    if (isPublicPath(request.url)) return;

    const allowed = request.tenants;
    // Unscoped token (no allowlist) or dev no-auth → no tenant restriction.
    if (allowed === undefined || allowed.length === 0) return;

    const requested = [queryTenantId(request), bodyTenantId(request)].filter(
      (t): t is string => t !== undefined,
    );

    // (a) Mismatch is rejected — a supplied tenantId must be in the allowlist.
    for (const tenantId of requested) {
      if (!allowed.includes(tenantId)) {
        reply.status(403);
        throw new Error(
          'This token is not authorized for the requested tenant. ' +
            'tenantId must match the tenant bound to your token.',
        );
      }
    }

    // (b) Omission is resolved server-side, never trusted to fall through.
    // A scoped token that named NO tenant must not reach an unfiltered
    // all-tenant query (c5k.2). Single-tenant scope → inject it; multi-tenant
    // scope → require the caller to pick one.
    if (requested.length === 0) {
      if (allowed.length === 1) {
        injectEffectiveTenant(request, allowed[0]!);
      } else {
        reply.status(400);
        throw new Error(
          'tenantId is required when your token is scoped to multiple tenants. ' +
            'Name one of your authorized tenants explicitly.',
        );
      }
    }
  });
}
