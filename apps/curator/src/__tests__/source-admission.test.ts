import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, AuditRepository } from '@qmd-team-intent-kb/store';
import { makeSourceGovernanceFixture } from './source-governance-fixtures.js';
import { signSourceClassification } from '../origin/source-classification-codec.js';
import { recordProvenanceFloorInTransaction } from '../origin/source-floor-writer.js';
import { requireSourceAdmission, withVerifiedSourceAdmission } from '../origin/source-admission.js';
import { SourceEnrollmentRequiredError } from '../origin/source-enrollment.js';

let db: ReturnType<typeof createTestDatabase>;
let f: ReturnType<typeof makeSourceGovernanceFixture>;
let wire: string;
beforeEach(() => {
  db = createTestDatabase();
  f = makeSourceGovernanceFixture();
  wire = signSourceClassification(f.payload, f.keys.privateKey);
  save();
});
afterEach(() => db.close());
function save() {
  db.prepare('INSERT OR REPLACE INTO source_classification_authority VALUES (1, ?)').run(
    JSON.stringify(f.registry),
  );
}
function scope<T>(operation: () => T, assertion = wire) {
  return withVerifiedSourceAdmission(f.candidate, assertion, db, () => f.receiver, operation);
}
function floor() {
  recordProvenanceFloorInTransaction(
    f.candidate,
    wire,
    f.registry,
    f.receiver,
    new AuditRepository(db),
  );
}
function transaction<T>(operation: () => T) {
  return db
    .transaction(() => {
      floor();
      return operation();
    })
    .immediate();
}

describe('candidate-scoped source admission', () => {
  it('accepts matching current evidence only within the owning transaction and scope', () => {
    transaction(() => {
      expect(() => requireSourceAdmission(db, f.candidate)).toThrow(SourceEnrollmentRequiredError);
      scope(() => expect(() => requireSourceAdmission(db, f.candidate)).not.toThrow());
      expect(() => requireSourceAdmission(db, f.candidate)).toThrow(SourceEnrollmentRequiredError);
    });
    expect(() => requireSourceAdmission(db, f.candidate)).toThrow(SourceEnrollmentRequiredError);
    db.transaction(() =>
      expect(() => requireSourceAdmission(db, f.candidate)).toThrow(SourceEnrollmentRequiredError),
    ).immediate();
  });
  it('refuses a scope outside a transaction', () => {
    expect(() => scope(() => null)).toThrow('Invalid source admission scope');
  });
  it('refuses a valid assertion without its durable floor', () => {
    expect(() => db.transaction(() => scope(() => null)).immediate()).toThrow('durable floor');
  });
  it('cleans up when the operation throws and its transaction rolls back', () => {
    expect(() =>
      transaction(() =>
        scope(() => {
          throw new Error('Synthetic fault');
        }),
      ),
    ).toThrow('Synthetic fault');
    expect(new AuditRepository(db).findAllChronological()).toEqual([]);
    expect(() => requireSourceAdmission(db, f.candidate)).toThrow(SourceEnrollmentRequiredError);
  });
  it('refuses nested admission without replacing the enclosing capability', () => {
    transaction(() =>
      scope(() => {
        expect(() => scope(() => null)).toThrow('Invalid source admission scope');
        expect(() => requireSourceAdmission(db, f.candidate)).not.toThrow();
      }),
    );
  });
  it.each(['id', 'content', 'title', 'metadata', 'tenantId'] as const)(
    'cannot authorize a candidate with different %s',
    (field) => {
      transaction(() =>
        scope(() => {
          const other = structuredClone(f.candidate);
          if (field === 'id') other.id = randomUUID();
          if (field === 'content') other.content += ' changed';
          if (field === 'title') other.title += ' changed';
          if (field === 'metadata') other.metadata.tags.push('forged-permission');
          if (field === 'tenantId') other.tenantId = 'another-tenant';
          expect(() => requireSourceAdmission(db, other)).toThrow('exact candidate');
        }),
      );
    },
  );
  it('does not carry permission to a second database connection', () => {
    const other = createTestDatabase();
    try {
      other
        .prepare('INSERT INTO source_classification_authority VALUES (1, ?)')
        .run(JSON.stringify(f.registry));
      transaction(() =>
        scope(() => {
          expect(() => requireSourceAdmission(other, f.candidate)).toThrow(
            SourceEnrollmentRequiredError,
          );
        }),
      );
    } finally {
      other.close();
    }
  });
  it.each(['missing', 'forged', 'noncanonical'] as const)(
    'refuses %s wire even with a previously recorded valid floor',
    (kind) => {
      const invalid =
        kind === 'missing'
          ? ''
          : kind === 'noncanonical'
            ? wire + ' '
            : wire.replace(/"signature":"./, '"signature":"z');
      expect(() => transaction(() => scope(() => null, invalid))).toThrow(
        'current stored authority',
      );
      expect(new AuditRepository(db).findAllChronological()).toEqual([]);
    },
  );
  it.each([
    'deleted',
    'optional',
    'revision',
    'profile',
    'revoked',
    'expiry',
    'receiver',
    'ingress',
  ] as const)('rechecks %s changes within a scope and rolls back', (kind) => {
    const before = db.serialize().toString('base64');
    expect(() =>
      transaction(() =>
        scope(() => {
          if (kind === 'deleted') db.exec('DELETE FROM source_classification_authority');
          if (kind === 'optional') {
            f.registry.enrollments[0]!.required = false;
            save();
          }
          if (kind === 'revision') {
            f.registry.revision++;
            save();
          }
          if (kind === 'profile') {
            f.registry.profiles[0]!.minimumSensitivity = 'public';
            save();
          }
          if (kind === 'revoked') {
            f.registry.keys[0]!.revoked = true;
            save();
          }
          if (kind === 'expiry') f.receiver.now = f.payload.expiresAt;
          if (kind === 'receiver') f.receiver.receiverId = 'forged';
          if (kind === 'ingress') f.receiver.ingressId = 'forged';
          requireSourceAdmission(db, f.candidate);
        }),
      ),
    ).toThrow();
    expect(db.serialize().toString('base64')).toBe(before);
    expect(() => requireSourceAdmission(db, f.candidate)).toThrow(SourceEnrollmentRequiredError);
  });
  it('does not grant asynchronous continuation permission', async () => {
    let continuation = Promise.resolve();
    expect(() =>
      transaction(() => {
        continuation = scope(() =>
          Promise.resolve().then(() => {
            expect(() => requireSourceAdmission(db, f.candidate)).toThrow(
              SourceEnrollmentRequiredError,
            );
          }),
        );
        return continuation;
      }),
    ).toThrow('cannot return a promise');
    await continuation;
    expect(new AuditRepository(db).findAllChronological()).toEqual([]);
  });
  it('refuses metadata mutation by the receiver provider during an admission check', () => {
    let reads = 0;
    expect(() =>
      transaction(() =>
        withVerifiedSourceAdmission(
          f.candidate,
          wire,
          db,
          () => {
            if (++reads === 3) f.candidate.metadata.tags.push('changed-during-read');
            return f.receiver;
          },
          () => requireSourceAdmission(db, f.candidate),
        ),
      ),
    ).toThrow('candidate changed during authority read');
    expect(new AuditRepository(db).findAllChronological()).toEqual([]);
    expect(() => requireSourceAdmission(db, f.candidate)).toThrow(SourceEnrollmentRequiredError);
  });
  it('reverifies with an advancing clock while the assertion remains valid', () => {
    transaction(() =>
      scope(() => {
        f.receiver.now = '2026-11-22T09:03:00.000Z';
        expect(() => requireSourceAdmission(db, f.candidate)).not.toThrow();
        f.receiver.now = '2026-11-22T09:04:00.000Z';
        expect(() => requireSourceAdmission(db, f.candidate)).not.toThrow();
      }),
    );
  });
});
