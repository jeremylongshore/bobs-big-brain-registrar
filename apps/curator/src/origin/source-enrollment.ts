import type Database from 'better-sqlite3';
import { SourceClassificationRegistry } from './source-classification-schema.js';

/** Stable refusal for legacy callers; no source content or registry details. */
export class SourceEnrollmentRequiredError extends Error {
  readonly code = 'SOURCE_ENROLLMENT_REQUIRED';
  constructor() {
    super(
      'Source enrollment requires an evidence-capable admission path: use the configured Registrar source-governance v1 API; this legacy route cannot admit the candidate',
    );
    this.name = 'SourceEnrollmentRequiredError';
  }
}

/** Read receiver configuration from the same store used for admission.
 * Invalid/missing schema refuses; only an actually empty table returns null.
 */
export function readStoredSourceRegistry(
  db: Database.Database,
): SourceClassificationRegistry | null {
  const rows = db
    .prepare('SELECT singleton, registry_json FROM source_classification_authority')
    .all();
  if (rows.length === 0) return null;
  const row = rows[0] as { singleton: unknown; registry_json: unknown };
  if (rows.length !== 1 || row.singleton !== 1 || typeof row.registry_json !== 'string')
    throw new Error('Invalid stored source authority');
  try {
    return SourceClassificationRegistry.parse(JSON.parse(row.registry_json));
  } catch {
    throw new Error('Invalid stored source authority');
  }
}

/** Legacy callers cannot choose another receiver/route to waive a requirement. */
export function requireLegacySourceAdmission(db: Database.Database, tenantId: string): void {
  const registry = readStoredSourceRegistry(db);
  if (registry?.enrollments.some((entry) => entry.tenantId === tenantId && entry.required))
    throw new SourceEnrollmentRequiredError();
}

/** Capability discovery exposes only enrollment presence, never registry material. */
export function hasSourceIngressEnrollment(
  db: Database.Database,
  receiverId: string,
  tenantId: string,
  ingressId: string,
): boolean {
  return (
    readStoredSourceRegistry(db)?.enrollments.some(
      (entry) =>
        entry.receiverId === receiverId &&
        entry.tenantId === tenantId &&
        entry.ingressId === ingressId,
    ) ?? false
  );
}
