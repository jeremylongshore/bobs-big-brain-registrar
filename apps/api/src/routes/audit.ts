import type { FastifyInstance } from 'fastify';
import type { AuditRepository } from '@qmd-team-intent-kb/store';

/**
 * Register audit event query routes.
 * The audit log is append-only; this endpoint only supports reads.
 *
 * GET /api/audit — query the tenant's audit events (query params)
 *
 * TENANT SCOPING (bead tr08.21): `tenantId` is REQUIRED. Every result is scoped
 * to that tenant. `memoryId` and `action` further narrow WITHIN the tenant —
 * they never widen across tenants. Without `tenantId` the endpoint returns 400,
 * not a global cross-tenant dump. This closes the prior leak where a bare
 * `memoryId` / `action` query returned rows regardless of ownership.
 */
export function registerAuditRoutes(app: FastifyInstance, repo: AuditRepository): void {
  app.get(
    '/api/audit',
    {
      schema: {
        tags: ['audit'],
        summary: 'Query the immutable audit event log (tenant-scoped)',
        description:
          '`tenantId` is REQUIRED. `memoryId` or `action` narrow within that tenant. ' +
          'Omitting `tenantId` returns 400 — this endpoint never serves cross-tenant rows.',
      },
    },
    async (request, reply) => {
      const { tenantId, memoryId, action } = request.query as {
        tenantId?: string;
        memoryId?: string;
        action?: string;
      };

      // Tenant scope is mandatory — refuse rather than leak across tenants.
      if (tenantId === undefined || tenantId.length === 0) {
        return reply.code(400).send({
          error: 'tenantId is required',
          message: 'Audit queries are tenant-scoped; supply a tenantId query parameter.',
        });
      }

      // memoryId / action narrow WITHIN the tenant via tenant-scoped lookups.
      if (memoryId !== undefined && memoryId.length > 0) {
        return reply.send(repo.findByMemoryAndTenant(memoryId, tenantId));
      }

      if (action !== undefined && action.length > 0) {
        return reply.send(repo.findByTenantAndAction(tenantId, action));
      }

      return reply.send(repo.findByTenant(tenantId));
    },
  );
}
