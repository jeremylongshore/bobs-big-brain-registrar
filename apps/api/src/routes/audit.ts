import type { FastifyInstance } from 'fastify';
import { type AuditRepository, verifyAuditChain } from '@qmd-team-intent-kb/store';

const SHA256_HEX = /^[0-9a-f]{64}$/;

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
    '/api/audit/receipt-tip',
    {
      schema: {
        tags: ['audit'],
        summary: 'Read or resolve the global governance receipt-chain tip',
        description:
          'Authenticated, content-safe receipt pointer for AGP cross-chain correlation. ' +
          'Optional `hash` resolves a previously observed tip after the chain advances. ' +
          'This proves chain position, not which search results an agent read.',
      },
    },
    async (request, reply) => {
      const { hash } = request.query as { hash?: unknown };
      if (hash !== undefined && (typeof hash !== 'string' || !SHA256_HEX.test(hash))) {
        return reply.code(400).send({
          error: 'invalid_receipt_hash',
          message: 'hash must be a lowercase SHA-256 hex value',
        });
      }

      const verification = verifyAuditChain(repo);
      const tamperBreaks = verification.breaks.filter((finding) => finding.reason !== 'CHAIN_FORK');
      const orderingForks = verification.breaks.length - tamperBreaks.length;
      const integrity = {
        status:
          tamperBreaks.length === 0
            ? ('no_tamper_signatures' as const)
            : ('tamper_signatures_detected' as const),
        checkedRows: verification.cleanRows,
        unverifiedRows: verification.unverifiedRows,
        orderingForks,
        tamperBreaks: tamperBreaks.length,
      };

      // Fail closed: never give an agent a tip to sign into a new action when
      // the current receipt chain has a tamper signature.
      if (tamperBreaks.length > 0) {
        return reply.code(503).send({
          schemaVersion: 1,
          chain: 'audit_events',
          scope: 'global-governance-receipt-chain',
          hashAlgorithm: 'sha256',
          current: null,
          requested: null,
          integrity,
          error: 'audit_chain_tamper_detected',
        });
      }

      const currentPosition = repo.findChainTip();
      const current =
        currentPosition === null
          ? null
          : {
              hash: currentPosition.entryHash,
              sequence: currentPosition.sequence,
              hashVersion: currentPosition.hashVersion,
            };
      const requestedPosition = typeof hash === 'string' ? repo.findChainPosition(hash) : null;
      const requested =
        typeof hash !== 'string'
          ? null
          : {
              hash,
              present: requestedPosition !== null,
              sequence: requestedPosition?.sequence ?? null,
              isCurrent: current?.hash === hash,
            };

      return reply.send({
        schemaVersion: 1,
        chain: 'audit_events',
        scope: 'global-governance-receipt-chain',
        hashAlgorithm: 'sha256',
        current,
        requested,
        integrity,
      });
    },
  );

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
