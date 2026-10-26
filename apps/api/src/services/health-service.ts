import type Database from 'better-sqlite3';
import { PolicyRepository, IndexStateRepository } from '@qmd-team-intent-kb/store';
import { findUncoveredRuleTypes } from '@qmd-team-intent-kb/policy-engine';

/** One active policy that leaves registered rules unenforced (5bm.10). */
interface PolicyDormancy {
  policyId: string;
  policyName: string;
  tenantId: string;
  /** Registered rule types the policy does not actively enforce. */
  dormantRuleTypes: string[];
}

/** Minimal public liveness; contains no tenant or policy diagnostics. */
interface LivenessStatus {
  status: 'healthy' | 'degraded';
  uptime: number;
  dbConnected: boolean;
  version: string;
}

/** Global operational diagnostics, restricted to unscoped administrators. */
interface HealthStatus extends LivenessStatus {
  /**
   * Per-policy dormancy (5bm.10): any ENABLED policy that leaves registered
   * rules inert. Empty means every active policy enforces the full registry.
   * This does NOT affect liveness (`status`) — a dormant rule is a governance
   * config signal an operator should act on, not a process outage.
   */
  policyDormancy: PolicyDormancy[];
  /**
   * Index freshness (D2): worst-case seconds since a promotion that is NOT yet
   * reflected in the search index, across every tenant that has begun
   * measurement. `null` = unmeasured (no export→reindex chain has recorded
   * completion yet), `0` = fresh, `> 0` = promote→search latency in seconds.
   * Like dormancy, this never affects liveness — a stale index is an operator
   * signal (the nightly canary enforces the threshold), not a process outage.
   */
  indexStalenessSeconds: number | null;
}

/**
 * Reports the operational health of the API process.
 * Checks database connectivity with a lightweight probe query.
 */
export class HealthService {
  private readonly startTime = Date.now();

  constructor(private readonly db: Database.Database) {}

  /** Public probe: no policy/index scan or cross-tenant diagnostic payload. */
  checkLiveness(): LivenessStatus {
    let dbConnected = false;
    try {
      this.db.prepare('SELECT 1').get();
      dbConnected = true;
    } catch {
      // DB unavailable — status will be reported as degraded
    }

    return {
      status: dbConnected ? 'healthy' : 'degraded',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      dbConnected,
      version: '0.4.0',
    };
  }

  /** Full diagnostics; callers must enforce global administrative standing. */
  check(): HealthStatus {
    const liveness = this.checkLiveness();
    return {
      ...liveness,
      policyDormancy: liveness.dbConnected ? this.checkPolicyDormancy() : [],
      indexStalenessSeconds: liveness.dbConnected ? this.checkIndexStaleness() : null,
    };
  }

  /**
   * Worst-case index staleness across tenants (D2). Read-only; any failure
   * (e.g. a pre-migration DB without the index_state table) degrades to null
   * (unmeasured) rather than failing the health probe.
   */
  private checkIndexStaleness(): number | null {
    try {
      return new IndexStateRepository(this.db).worstStalenessSeconds();
    } catch {
      return null;
    }
  }

  /**
   * Inspect every ENABLED policy for registered rules it does not enforce
   * (5bm.10). Read-only; failure to read policies degrades to an empty result
   * rather than failing the health probe.
   */
  private checkPolicyDormancy(): PolicyDormancy[] {
    try {
      const policies = new PolicyRepository(this.db).list();
      const dormant: PolicyDormancy[] = [];
      for (const policy of policies) {
        if (!policy.enabled) continue;
        const dormantRuleTypes = findUncoveredRuleTypes(policy);
        if (dormantRuleTypes.length > 0) {
          dormant.push({
            policyId: policy.id,
            policyName: policy.name,
            tenantId: policy.tenantId,
            dormantRuleTypes,
          });
        }
      }
      return dormant;
    } catch {
      return [];
    }
  }
}
