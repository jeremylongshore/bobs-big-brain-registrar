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
import type { BrainignoreRuleset } from '@qmd-team-intent-kb/curator';
import { CandidateService } from './services/candidate-service.js';
import { PromotionService } from './services/promotion-service.js';
import { MemoryService } from './services/memory-service.js';
import { PolicyService } from './services/policy-service.js';
import { HealthService } from './services/health-service.js';
import { SearchService } from './services/search-service.js';
import type { QmdQueryPort } from './services/search-service.js';
import type { IndexRefresher } from './services/index-refresher.js';
import { registerCandidateRoutes } from './routes/candidates.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerImportRoutes } from './routes/import.js';
import { ImportService } from './services/import-service.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerRateLimiter } from './middleware/rate-limiter.js';
import { registerCaptureQuota } from './middleware/capture-quota.js';
import { registerApiKeyAuth } from './middleware/api-key-auth.js';
import { registerWriteGate } from './middleware/write-gate.js';
import { registerTenancyGuard } from './middleware/tenancy-guard.js';
import { registerInputSanitizer } from './middleware/input-sanitizer.js';
import { buildTokenRegistry } from './auth/token-registry.js';
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
  /** Max candidate intakes ONE token may propose per window (jfv.10, default 60) */
  captureQuotaMax?: number;
  /** Per-actor capture quota window in ms (default 60000) */
  captureQuotaWindowMs?: number;
  /** Max body size in bytes (default 1MB) */
  maxBodySize?: number;
  /**
   * The interface the server will bind. The no-auth dev path is LOOPBACK-ONLY:
   * an empty token registry on a non-loopback host (tailnet 100.x, 0.0.0.0,
   * LAN) is refused at boot so an unauthenticated, admin-stamping brain is never
   * reachable off-host. Default: `127.0.0.1`.
   */
  bindHost?: string;
  /**
   * Path to the durable revocation list (default env `TEAMKB_REVOKED_FILE`,
   * else — set by `main.ts` — `~/.teamkb/revoked-actors.json`). Actors listed
   * here are revoked at boot, and `POST /api/auth/revoke-actor` appends to it so
   * a revoke-by-actor survives a restart. Left unset in tests → in-memory only,
   * no file is touched.
   */
  revokedFile?: string;
  /**
   * Optional qmd query port. When provided, search runs through qmd so every
   * hit carries a `qmd://` citation. When omitted, search falls back to SQLite
   * text-match over the curated store.
   */
  qmdAdapter?: QmdQueryPort;
  /**
   * Origin channels a capture may claim in `origin.channel` (GSB Wave-2 H3).
   * Defaults to the shipped capture surfaces (see
   * `DEFAULT_ALLOWED_ORIGIN_CHANNELS`); main.ts wires `TEAMKB_ALLOWED_CHANNELS`.
   * A capture claiming a channel outside this list is refused with a stable
   * 422 `unrecognized_channel`.
   */
  allowedChannels?: readonly string[];
  /**
   * Per-installation origin secret for verifying candidate `origin`
   * attestations at promotion time (GSB Wave-2 H1). main.ts resolves it via
   * `loadOrCreateOriginSecret()` (env `TEAMKB_ORIGIN_SECRET` overrides). Left
   * unset in tests → unattested candidates promote; origin-claiming candidates
   * are refused fail-closed.
   */
  originSecret?: string;
  /**
   * Optional post-promotion index refresher (D1). When provided, a successful
   * `POST /api/candidates/:id/promote` triggers the export→reindex chain AFTER
   * the promotion transaction commits, so the new memory is searchable
   * immediately instead of waiting for the next daemon cycle / nightly govern.
   * Omitted (tests / no-qmd deployments) → promotion behavior is unchanged and
   * the D2 staleness gauge reports the accumulating drift.
   */
  indexRefresher?: IndexRefresher;
  /**
   * Brainignore ruleset for the import exclusion gate (5kw.1) applied on the
   * single-candidate promote path. main.ts resolves it via
   * `loadBrainignoreRuleset()` so the API honors the per-brain override file
   * (`~/.teamkb/brainignore`); left unset in tests → the committed defaults.
   * The gate is on for import-source candidates regardless — this only wires
   * the operator override.
   */
  importExclusions?: BrainignoreRuleset;
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
  // The durable revocation list: actors banned here are revoked at boot, and
  // POST /api/auth/revoke-actor appends to it so a revoke survives a restart.
  const revokedFile = deps.revokedFile ?? process.env['TEAMKB_REVOKED_FILE'];
  const tokenRegistry = buildTokenRegistry({
    records: deps.tokens,
    apiKey: deps.apiKey,
    tokensJson: process.env['TEAMKB_TOKENS'],
    tokensFile: process.env['TEAMKB_TOKENS_FILE'],
    revokedFile,
  });
  // Pass the bind host so the no-auth dev path is refused off-loopback — an
  // unauthenticated admin-stamping brain must never be reachable off-host.
  registerApiKeyAuth(app, tokenRegistry, { bindHost: deps.bindHost ?? '127.0.0.1' });
  // Must follow auth so `request.role` is set before the gate inspects it.
  registerWriteGate(app);
  // Must follow auth so `request.role`/`request.tenants` are set. Binds every
  // tenant-scoped read/write to the token's tenant allowlist and locks the raw
  // candidate inbox to admin (EPIC 0 — compile-then-govern-c5k).
  registerTenancyGuard(app);
  // Must follow auth so `request.actor` is stamped: a per-actor cap on candidate
  // intake so one token/hook can't flood the inbox (jfv.10 — the IP limiter can't,
  // since every tailnet device is its own IP).
  registerCaptureQuota(app, deps.captureQuotaMax ?? 60, deps.captureQuotaWindowMs ?? 60000);
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

  // The candidate service takes the audit repo so every accepted intake writes a
  // `proposed` provenance receipt (R8, compile-then-govern-jfv.6.7).
  const candidateService = new CandidateService(candidateRepo, auditRepo, deps.allowedChannels);
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
    deps.originSecret,
    deps.importExclusions,
  );

  // Routes are wrapped in an inner register() so they load AFTER the
  // @fastify/swagger plugin. The swagger plugin installs an `onRoute`
  // hook during its async load; routes added synchronously before the
  // hook is active would be missing from the generated spec.
  void app.register(async (scope) => {
    registerHealthRoutes(scope, healthService);
    registerCandidateRoutes(scope, candidateService, promotionService, deps.indexRefresher);
    registerMemoryRoutes(scope, memoryService, memoryRepo);
    registerPolicyRoutes(scope, policyService);
    registerAuditRoutes(scope, auditRepo);
    registerSearchRoutes(scope, searchService);
    registerImportRoutes(scope, importService);
    registerGraphRoutes(scope, linksRepo, memoryRepo);
    // Live token revocation — admin-only, cuts a token off without a restart.
    // The revoked-file path lets revoke-by-actor persist durably.
    registerAuthRoutes(scope, tokenRegistry, revokedFile);
  });

  return app;
}
