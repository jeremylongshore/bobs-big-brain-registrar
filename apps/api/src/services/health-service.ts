import type Database from 'better-sqlite3';
import { PolicyRepository } from '@qmd-team-intent-kb/store';
import { findUncoveredRuleTypes } from '@qmd-team-intent-kb/policy-engine';

/** One active policy that leaves registered rules unenforced (5bm.10). */
interface PolicyDormancy {
  policyId: string;
  policyName: string;
  tenantId: string;
  /** Registered rule types the policy does not actively enforce. */
  dormantRuleTypes: string[];
}

/** Payload returned by the health endpoint. */
interface HealthStatus {
  status: 'healthy' | 'degraded';
  uptime: number;
  dbConnected: boolean;
  version: string;
  /**
   * Per-policy dormancy (5bm.10): any ENABLED policy that leaves registered
   * rules inert. Empty means every active policy enforces the full registry.
   * This does NOT affect liveness (`status`) — a dormant rule is a governance
   * config signal an operator should act on, not a process outage.
   */
  policyDormancy: PolicyDormancy[];
}

/**
 * Reports the operational health of the API process.
 * Checks database connectivity with a lightweight probe query.
 */
export class HealthService {
  private readonly startTime = Date.now();

  constructor(private readonly db: Database.Database) {}

  /** Perform a health check and return the current status. */
  check(): HealthStatus {
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
      policyDormancy: dbConnected ? this.checkPolicyDormancy() : [],
    };
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
