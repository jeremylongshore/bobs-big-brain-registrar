import { readSourceControlInput } from './source-control-read.js';
import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AuditEvent, Author, Sha256Hash } from '@qmd-team-intent-kb/schema';
import { AuditRepository } from '@qmd-team-intent-kb/store';
import { deriveAuditEventId } from '@qmd-team-intent-kb/common';
import { SourceClassificationRegistry } from './source-classification-schema.js';
import { classificationCanonicalJson } from './source-classification-codec.js';
import { readStoredSourceRegistry } from './source-enrollment.js';
import { requireSourceAuthorityUpdate } from './source-authority-validation.js';
import {
  requireSourceGovernanceChain,
  sourceGovernanceDigest as digest,
} from './source-governance-prepare.js';

const NAMESPACE = 'b93d9b63-024b-4dfe-8f6b-0fce8dc0499c';
const TENANT = 'source-authority';
const Operator = z
  .object({ actor: Author, role: z.literal('owner'), now: z.string().datetime() })
  .strict();
export const SourceAuthorityPlan = z
  .object({
    version: z.literal(1),
    previousDigest: Sha256Hash.nullable(),
    nextDigest: Sha256Hash,
    nextRevision: z.number().int().positive(),
    chainTipDigest: Sha256Hash,
    operatorDigest: Sha256Hash,
  })
  .strict();
export type SourceAuthorityPlan = z.infer<typeof SourceAuthorityPlan>;
/** Trusted host-operator boundary, not a request-body or tenant-owner authorization
 * API. Integrating code must establish whole-store configuration authority before
 * supplying this callback. Declared identity alone does not authenticate a person.
 */
export interface SourceAuthorityOperator {
  readOperator(): unknown;
}
function operator(db: Database.Database, context: SourceAuthorityOperator) {
  const value = Operator.parse(readSourceControlInput(db, () => context.readOperator()));
  if (value.actor.type !== 'human')
    throw new Error('Source configuration requires a human operator');
  return value;
}
function prepare(nextInput: unknown, db: Database.Database, context: SourceAuthorityOperator) {
  const who = operator(db, context);
  const next = SourceClassificationRegistry.parse(nextInput);
  const audit = new AuditRepository(db);
  requireSourceGovernanceChain(audit);
  const previous = readStoredSourceRegistry(db);
  requireSourceAuthorityUpdate(previous, next);
  const plan = SourceAuthorityPlan.parse({
    version: 1,
    previousDigest: previous === null ? null : digest(previous),
    nextDigest: digest(next),
    nextRevision: next.revision,
    chainTipDigest: digest(audit.findChainTip()),
    operatorDigest: digest({ actor: who.actor, role: who.role }),
  });
  return { who, next, audit, plan };
}

/** Read-only preview. No caller, endpoint, provisioning command or rollout is activated. */
export function previewSourceAuthority(
  next: unknown,
  db: Database.Database,
  context: SourceAuthorityOperator,
): SourceAuthorityPlan {
  if (db.inTransaction) throw new Error('Source configuration requires its own transaction');
  return db.transaction(() => prepare(next, db, context).plan).deferred();
}
/** Apply an exactly reviewed plan. Stale/repeated plans refuse; after uncertain
 * completion reconcile the stored registry and change receipt before retrying.
 */
export function applySourceAuthority(
  planInput: SourceAuthorityPlan,
  nextInput: unknown,
  db: Database.Database,
  context: SourceAuthorityOperator,
): string {
  if (db.inTransaction) throw new Error('Source configuration requires its own transaction');
  const expected = SourceAuthorityPlan.parse(planInput);
  return db
    .transaction(() => {
      const { who, next, audit, plan } = prepare(nextInput, db, context);
      if (!isDeepStrictEqual(plan, expected)) throw new Error('Stale source configuration plan');
      const event = AuditEvent.parse({
        id: deriveAuditEventId(NAMESPACE, 'governed', digest(plan)),
        memoryId: NAMESPACE,
        tenantId: TENANT,
        action: 'governed',
        actor: who.actor,
        timestamp: who.now,
        reason: 'Apply reviewed source authority configuration',
        details: { kind: 'source-authority-change-v1', plan },
      });
      db.prepare(
        'INSERT INTO source_classification_authority VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET registry_json = excluded.registry_json',
      ).run(classificationCanonicalJson(next));
      audit.insert(event);
      const latest = operator(db, context);
      if (
        digest({ actor: latest.actor, role: latest.role }) !== expected.operatorDigest ||
        digest(readStoredSourceRegistry(db)) !== expected.nextDigest ||
        !isDeepStrictEqual(
          audit.findByMemoryAndTenant(NAMESPACE, TENANT).find((e) => e.id === event.id),
          event,
        )
      )
        throw new Error('Source configuration or receipt changed before commit');
      requireSourceGovernanceChain(audit);
      return event.id;
    })
    .immediate();
}
