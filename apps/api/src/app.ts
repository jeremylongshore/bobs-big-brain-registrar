import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  ImportBatchRepository,
  MemoryLinksRepository,
} from '@qmd-team-intent-kb/store';
import { CandidateService } from './services/candidate-service.js';
import { PromotionService } from './services/promotion-service.js';
import { MemoryService } from './services/memory-service.js';
import { PolicyService } from './services/policy-service.js';
import { HealthService } from './services/health-service.js';
import { SearchService } from './services/search-service.js';
import type { QmdQueryPort } from './services/search-service.js';
import { registerCandidateRoutes } from './routes/candidates.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerImportRoutes } from './routes/import.js';
import { ImportService } from './services/import-service.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerRateLimiter } from './middleware/rate-limiter.js';
import { registerApiKeyAuth } from './middleware/api-key-auth.js';
import { registerWriteGate } from './middleware/write-gate.js';
import { registerInputSanitizer } from './middleware/input-sanitizer.js';
import { InMemoryTokenRegistry, loadTokenRecords } from './auth/token-registry.js';
import type { TokenRecord } from './auth/token-registry.js';
import { registerOpenApi } from './openapi.js';

/** External dependencies injected into the application factory. */
export interface AppDependencies {
  /** An open better-sqlite3 database connection (real or in-memory). */
  db: Database.Database;
  /** Suppress Fastify's built-in logger — useful in tests. Default: false. */
  silent?: boolean;
  /**
   * Optional single shared key for bearer auth — back-compat. Promoted to one
   * admin token (actor "shared"). If both this and `tokens` are unset, auth is
   * skipped (dev mode).
   */
  apiKey?: string;
  /**
   * Per-user token records (token → actor + role). Takes precedence over
   * `apiKey`. This is the per-user identity + revocation path: drop a record
   * to cut off one person.
   */
  tokens?: TokenRecord[];
  /** Max requests per rate limit window (default 100) */
  rateLimitMax?: number;
  /** Rate limit window in ms (default 60000) */
  rateLimitWindowMs?: number;
  /** Max body size in bytes (default 1MB) */
  maxBodySize?: number;
  /**
   * Optional qmd query port. When provided, search runs through qmd so every
   * hit carries a `qmd://` citation. When omitted, search falls back to SQLite
   * text-match over the curated store.
   */
  qmdAdapter?: QmdQueryPort;
}

/**
 * Build and configure the Fastify application.
 *
 * Repositories and services are constructed here and wired into route
 * handlers. No `.listen()` is called — callers are responsible for
 * starting the server or using `inject()` for testing.
 */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const bodyLimit = deps.maxBodySize ?? 1_048_576;
  const app = Fastify({ logger: !deps.silent, bodyLimit });

  registerRateLimiter(app, deps.rateLimitMax ?? 100, deps.rateLimitWindowMs ?? 60000);
  const tokenRegistry = new InMemoryTokenRegistry(
    loadTokenRecords({
      records: deps.tokens,
      apiKey: deps.apiKey,
      tokensJson: process.env['TEAMKB_TOKENS'],
      tokensFile: process.env['TEAMKB_TOKENS_FILE'],
    }),
  );
  registerApiKeyAuth(app, tokenRegistry);
  // Must follow auth so `request.role` is set before the gate inspects it.
  registerWriteGate(app);
  registerInputSanitizer(app, deps.maxBodySize ?? 1_048_576);

  // OpenAPI must be registered BEFORE routes so their schema metadata
  // is collected into the generated document.
  registerOpenApi(app);

  const candidateRepo = new CandidateRepository(deps.db);
  const memoryRepo = new MemoryRepository(deps.db);
  const policyRepo = new PolicyRepository(deps.db);
  const auditRepo = new AuditRepository(deps.db);
  const batchRepo = new ImportBatchRepository(deps.db);
  const linksRepo = new MemoryLinksRepository(deps.db);

  const candidateService = new CandidateService(candidateRepo);
  const memoryService = new MemoryService(memoryRepo, auditRepo);
  const policyService = new PolicyService(policyRepo);
  const healthService = new HealthService(deps.db);
  const searchService = new SearchService(memoryRepo, deps.qmdAdapter);
  const importService = new ImportService(candidateRepo, memoryRepo, batchRepo, linksRepo);
  const promotionService = new PromotionService(
    candidateRepo,
    memoryRepo,
    policyRepo,
    auditRepo,
    linksRepo,
  );

  // Routes are wrapped in an inner register() so they load AFTER the
  // @fastify/swagger plugin. The swagger plugin installs an `onRoute`
  // hook during its async load; routes added synchronously before the
  // hook is active would be missing from the generated spec.
  void app.register(async (scope) => {
    registerHealthRoutes(scope, healthService);
    registerCandidateRoutes(scope, candidateService, promotionService);
    registerMemoryRoutes(scope, memoryService, memoryRepo);
    registerPolicyRoutes(scope, policyService);
    registerAuditRoutes(scope, auditRepo);
    registerSearchRoutes(scope, searchService);
    registerImportRoutes(scope, importService);
    registerGraphRoutes(scope, linksRepo, memoryRepo);
  });

  return app;
}
