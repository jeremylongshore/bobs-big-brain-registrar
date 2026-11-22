import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, AuditRepository, verifyAuditChain } from '@qmd-team-intent-kb/store';
import { makeSourceGovernanceFixture } from './source-governance-fixtures.js';
import { applySourceAuthority, previewSourceAuthority } from '../origin/source-authority.js';
import { readStoredSourceRegistry } from '../origin/source-enrollment.js';

let db: ReturnType<typeof createTestDatabase>;
let f: ReturnType<typeof makeSourceGovernanceFixture>;
const declaredOperator = {
  actor: { type: 'human', id: 'synthetic-owner' },
  role: 'owner',
  now: '2026-11-22T09:02:00.000Z',
};
const context = { readOperator: () => structuredClone(declaredOperator) };
beforeEach(() => {
  db = createTestDatabase();
  f = makeSourceGovernanceFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});
function preview() {
  return previewSourceAuthority(f.registry, db, context);
}
function apply() {
  return applySourceAuthority(preview(), f.registry, db, context);
}
function baseline() {
  apply();
  f.registry.revision++;
}

describe('reviewed source authority configuration primitive', () => {
  it('previews without writes and applies configuration with a content-safe receipt atomically', () => {
    const before = db.serialize().toString('base64');
    const plan = preview();
    expect(db.serialize().toString('base64')).toBe(before);
    const eventId = applySourceAuthority(plan, f.registry, db, context);
    expect(readStoredSourceRegistry(db)).toEqual(f.registry);
    const audit = new AuditRepository(db);
    const events = audit.findAllChronological();
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(eventId);
    expect(events[0]?.details_json).not.toContain(f.registry.keys[0]!.publicKeyHex);
    expect(events[0]?.details_json).not.toContain(f.registry.profiles[0]!.context.repository);
    expect(verifyAuditChain(audit).breaks).toEqual([]);
  });
  it('refuses repeated plans without rewriting an existing receipt', () => {
    const plan = preview();
    applySourceAuthority(plan, f.registry, db, context);
    const before = db.serialize().toString('base64');
    expect(() => applySourceAuthority(plan, f.registry, db, context)).toThrow();
    expect(db.serialize().toString('base64')).toBe(before);
  });
  it('allows a revisioned profile tightening and key revocation', () => {
    baseline();
    f.registry.profiles[0]!.minimumSensitivity = 'restricted';
    f.registry.profiles[0]!.revision++;
    f.registry.keys[0]!.revoked = true;
    apply();
    expect(readStoredSourceRegistry(db)).toEqual(f.registry);
    expect(new AuditRepository(db).findAllChronological()).toHaveLength(2);
  });
  it.each(['stored-revoked', 'same-update', 'initial'] as const)(
    'refuses active aliases of %s key material without writes',
    (kind) => {
      if (kind === 'stored-revoked') f.registry.keys[0]!.revoked = true;
      if (kind !== 'initial') baseline();
      f.registry.keys[0]!.revoked = true;
      f.registry.keys.push({ ...f.registry.keys[0]!, id: 'alias-key', revoked: false });
      const before = db.serialize().toString('base64');
      expect(() => apply()).toThrow('revoked source key material');
      expect(db.serialize().toString('base64')).toBe(before);
    },
  );
  it('allows fresh material under a new identity while retaining a revoked key', () => {
    f.registry.keys[0]!.revoked = true;
    baseline();
    const fresh = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('hex');
    f.registry.keys.push({
      ...f.registry.keys[0]!,
      id: 'fresh-key',
      publicKeyHex: fresh,
      revoked: false,
    });
    apply();
    expect(readStoredSourceRegistry(db)).toEqual(f.registry);
  });
  it.each([
    'required-removal',
    'required-optional',
    'profile-lower',
    'profile-binding',
    'profile-revision',
    'profile-deletion',
    'key-deletion',
    'key-replacement',
    'key-resurrection',
    'registry-revision',
    'enrollment-revision',
    'dangling-profile',
    'key-lifetime',
    'new-id-lower',
  ] as const)('refuses %s without writes', (kind) => {
    if (kind === 'key-resurrection') f.registry.keys[0]!.revoked = true;
    if (kind === 'profile-deletion')
      f.registry.profiles.push({ ...f.registry.profiles[0]!, id: 'unused' });
    baseline();
    if (kind === 'required-removal') f.registry.enrollments = [];
    if (kind === 'required-optional') {
      f.registry.enrollments[0]!.required = false;
      f.registry.enrollments[0]!.revision++;
    }
    if (kind === 'profile-lower') {
      f.registry.profiles[0]!.minimumSensitivity = 'public';
      f.registry.profiles[0]!.revision++;
    }
    if (kind === 'profile-binding') {
      f.registry.profiles[0]!.context.channel = 'different';
      f.registry.profiles[0]!.revision++;
    }
    if (kind === 'profile-revision') f.registry.profiles[0]!.minimumSensitivity = 'restricted';
    if (kind === 'profile-deletion') f.registry.profiles.pop();
    if (kind === 'key-deletion') f.registry.keys = [];
    if (kind === 'key-replacement') f.registry.keys[0]!.publicKeyHex = 'a'.repeat(64);
    if (kind === 'key-resurrection') f.registry.keys[0]!.revoked = false;
    if (kind === 'registry-revision') f.registry.revision++;
    if (kind === 'enrollment-revision') f.registry.enrollments[0]!.revision = 0;
    if (kind === 'dangling-profile') f.registry.enrollments[0]!.profileIds = ['missing'];
    if (kind === 'key-lifetime') f.registry.keys[0]!.validUntil = f.registry.keys[0]!.validFrom;
    if (kind === 'new-id-lower')
      f.registry.profiles.push({
        ...f.registry.profiles[0]!,
        id: 'weaker',
        minimumSensitivity: 'public',
      });
    const before = db.serialize().toString('base64');
    expect(() => apply()).toThrow();
    expect(db.serialize().toString('base64')).toBe(before);
  });
  it.each(['payload', 'stored', 'operator'] as const)(
    'refuses stale %s between preview and apply',
    (kind) => {
      const plan = preview();
      if (kind === 'payload') f.registry.keys[0]!.revoked = true;
      if (kind === 'stored') apply();
      const changed =
        kind === 'operator'
          ? {
              readOperator: () => ({
                ...declaredOperator,
                actor: { type: 'human', id: 'other-owner' },
              }),
            }
          : context;
      const before = db.serialize().toString('base64');
      expect(() => applySourceAuthority(plan, f.registry, db, changed)).toThrow();
      expect(db.serialize().toString('base64')).toBe(before);
    },
  );
  it.each(['ai', 'member'] as const)('refuses declared %s configuration authority', (kind) => {
    const wrong = {
      readOperator: () => ({
        ...declaredOperator,
        ...(kind === 'ai' ? { actor: { type: 'ai', id: 'model' } } : { role: 'member' }),
      }),
    };
    expect(() => previewSourceAuthority(f.registry, db, wrong)).toThrow();
    expect(readStoredSourceRegistry(db)).toBe(null);
  });
  it('rolls back the registry when the receipt write fails', () => {
    const plan = preview();
    vi.spyOn(AuditRepository.prototype, 'insert').mockImplementation(() => {
      throw new Error('synthetic receipt fault');
    });
    expect(() => applySourceAuthority(plan, f.registry, db, context)).toThrow(
      'synthetic receipt fault',
    );
    expect(readStoredSourceRegistry(db)).toBe(null);
    expect(new AuditRepository(db).findAllChronological()).toEqual([]);
  });
  it('detects a silently dropped receipt and rolls back', () => {
    const plan = preview();
    vi.spyOn(AuditRepository.prototype, 'insert').mockImplementation(() => {});
    expect(() => applySourceAuthority(plan, f.registry, db, context)).toThrow('receipt changed');
    expect(readStoredSourceRegistry(db)).toBe(null);
  });
  it.each(['registry', 'operator'] as const)('rolls back final %s drift', (kind) => {
    const plan = preview();
    let reads = 0;
    const changed = {
      readOperator: () => {
        reads++;
        if (reads === 2) {
          if (kind === 'registry') db.exec('DELETE FROM source_classification_authority');
          if (kind === 'operator')
            return { ...declaredOperator, actor: { type: 'human', id: 'different' } };
        }
        return declaredOperator;
      },
    };
    expect(() => applySourceAuthority(plan, f.registry, db, changed)).toThrow(
      kind === 'registry' ? 'provider wrote' : 'changed before commit',
    );
    expect(readStoredSourceRegistry(db)).toBe(null);
    expect(new AuditRepository(db).findAllChronological()).toEqual([]);
  });
  it('rolls back a provider that writes during supposedly read-only preview', () => {
    const bad = {
      readOperator: () => {
        db.prepare('INSERT INTO source_classification_authority VALUES (1, ?)').run(
          JSON.stringify(f.registry),
        );
        return declaredOperator;
      },
    };
    expect(() => previewSourceAuthority(f.registry, db, bad)).toThrow('provider wrote');
    expect(readStoredSourceRegistry(db)).toBe(null);
  });
  it('cannot remove an optional enrollment through the configuration primitive', () => {
    f.registry.enrollments[0]!.required = false;
    baseline();
    f.registry.enrollments = [];
    const before = db.serialize().toString('base64');
    expect(() => apply()).toThrow('Cannot remove source enrollment');
    expect(db.serialize().toString('base64')).toBe(before);
  });
  it('requires the global registry revision for a key-scope change', () => {
    const extra = {
      ...f.registry.profiles[0]!,
      id: 'other-profile',
      context: { ...f.registry.profiles[0]!.context, channel: 'other-private' },
    };
    f.registry.profiles.push(extra);
    apply();
    f.registry.keys[0]!.profileIds.push(extra.id);
    expect(() => preview()).toThrow('revision must advance');
    f.registry.revision++;
    apply();
    expect(readStoredSourceRegistry(db)?.keys[0]?.profileIds).toContain(extra.id);
    expect(new AuditRepository(db).findAllChronological()).toHaveLength(2);
  });
});
