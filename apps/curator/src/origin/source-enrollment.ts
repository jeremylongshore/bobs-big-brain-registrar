import type Database from 'better-sqlite3';
import { SourceClassificationRegistry } from './source-classification-schema.js';

/** Stable refusal for legacy callers; no source content or registry details. */
export class SourceEnrollmentRequiredError extends Error {
  readonly code = 'SOURCE_ENROLLMENT_REQUIRED';
  constructor() {
    super('Source enrollment requires an evidence-capable admission path');
    this.name = 'SourceEnrollmentRequiredError';
  }
}

/**
 * Shared legacy-admission guard. Only an empty or valid optional registry permits
 * legacy behavior. Database/read/schema failures propagate; they never mean empty.
 * Any required enrollment for this tenant applies across every receiver/ingress:
 * an unsupported caller cannot pick another route to opt out. This milestone has
 * no evidence-capable exception, provisioning command or live enrollment.
 */
export function requireLegacySourceAdmission(db: Database.Database, tenantId: string): void {
  const rows = db
    .prepare('SELECT singleton, registry_json FROM source_classification_authority')
    .all();
  if (rows.length === 0) return;
  const row = rows[0] as { singleton: unknown; registry_json: unknown };
  if (rows.length !== 1 || row.singleton !== 1 || typeof row.registry_json !== 'string')
    throw new Error('Invalid stored source authority');
  let registry;
  try {
    registry = SourceClassificationRegistry.parse(JSON.parse(row.registry_json));
  } catch {
    // Do not surface rejected registry material in errors or logs.
    throw new Error('Invalid stored source authority');
  }
  if (registry.enrollments.some((entry) => entry.tenantId === tenantId && entry.required))
    throw new SourceEnrollmentRequiredError();
}
