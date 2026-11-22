import { effectiveSensitivity } from '@qmd-team-intent-kb/policy-engine';
import type { SourceClassificationRegistry } from './source-classification-schema.js';
import { classificationCanonicalJson } from './source-classification-codec.js';

const same = (a: unknown, b: unknown) =>
  classificationCanonicalJson(a) === classificationCanonicalJson(b);
const enrollmentId = (e: SourceClassificationRegistry['enrollments'][number]) =>
  `${e.receiverId}/${e.tenantId}/${e.ingressId}`;

function requireReferences(next: SourceClassificationRegistry): void {
  for (const entry of [...next.enrollments, ...next.keys]) {
    for (const id of entry.profileIds) {
      const profile = next.profiles.find((p) => p.id === id);
      if (
        !profile ||
        profile.receiverId !== entry.receiverId ||
        profile.tenantId !== entry.tenantId ||
        ('producerId' in entry && profile.producerId !== entry.producerId)
      )
        throw new Error('Invalid source authority profile reference');
    }
  }
  if (next.keys.some((key) => key.validFrom >= key.validUntil))
    throw new Error('Invalid source authority key lifetime');
}

/** This initial configuration path cannot remove a required enrollment, lower an
 * existing profile, change its binding, or resurrect a revoked key. Broader
 * relaxation needs a separate reviewed operation, not an optional force flag.
 */
export function requireSourceAuthorityUpdate(
  previous: SourceClassificationRegistry | null,
  next: SourceClassificationRegistry,
): void {
  requireReferences(next);
  requireRevokedKeyMaterial(previous, next);
  if (next.revision !== (previous?.revision ?? 0) + 1)
    throw new Error('Source authority revision must advance by one');
  if (!previous) return;
  requireEnrollments(previous, next);
  requireProfiles(previous, next);
  requireBindingFloors(previous, next);
  requireKeys(previous, next);
}
function requireEnrollments(
  previous: SourceClassificationRegistry,
  next: SourceClassificationRegistry,
): void {
  for (const old of previous.enrollments) {
    const entry = next.enrollments.find((e) => enrollmentId(e) === enrollmentId(old));
    if (!entry || (old.required && !entry.required))
      throw new Error('Cannot remove source enrollment or disable its requirement');
    if (
      entry &&
      (entry.revision < old.revision || (!same(entry, old) && entry.revision <= old.revision))
    )
      throw new Error('Source enrollment revision did not advance');
  }
}
function requireProfiles(
  previous: SourceClassificationRegistry,
  next: SourceClassificationRegistry,
): void {
  for (const old of previous.profiles) {
    const profile = next.profiles.find((p) => p.id === old.id);
    if (!profile) throw new Error('Revoke source keys instead of deleting profiles');
    if (
      !same(
        { ...profile, revision: null, minimumSensitivity: null },
        { ...old, revision: null, minimumSensitivity: null },
      )
    )
      throw new Error('Cannot change an existing source profile binding');
    if (
      effectiveSensitivity(profile.minimumSensitivity, old.minimumSensitivity) !==
      profile.minimumSensitivity
    )
      throw new Error('Cannot lower an existing source profile');
    if (
      profile.revision < old.revision ||
      (!same(profile, old) && profile.revision <= old.revision)
    )
      throw new Error('Source profile revision did not advance');
  }
}
function requireKeys(
  previous: SourceClassificationRegistry,
  next: SourceClassificationRegistry,
): void {
  for (const old of previous.keys) {
    const key = next.keys.find((k) => k.id === old.id && k.producerId === old.producerId);
    if (!key) throw new Error('Revoke source keys instead of deleting identities');
    if (old.revoked && !key.revoked) throw new Error('Cannot resurrect a revoked source key');
    if (
      !same(
        { ...key, profileIds: null, revoked: null },
        { ...old, profileIds: null, revoked: null },
      )
    )
      throw new Error('Rotate source keys with a new identity');
  }
}

function requireBindingFloors(
  previous: SourceClassificationRegistry,
  next: SourceClassificationRegistry,
): void {
  for (const old of previous.profiles) {
    for (const profile of next.profiles) {
      if (
        old.receiverId === profile.receiverId &&
        old.tenantId === profile.tenantId &&
        same(old.context, profile.context) &&
        effectiveSensitivity(profile.minimumSensitivity, old.minimumSensitivity) !==
          profile.minimumSensitivity
      )
        throw new Error('Cannot lower a source binding through another profile identity');
    }
  }
}

/** Revocation follows the signing material, even across producer/key aliases. */
function requireRevokedKeyMaterial(
  previous: SourceClassificationRegistry | null,
  next: SourceClassificationRegistry,
): void {
  const revoked = new Set(
    [...(previous?.keys ?? []), ...next.keys]
      .filter((key) => key.revoked)
      .map((key) => key.publicKeyHex.toLowerCase()),
  );
  if (next.keys.some((key) => !key.revoked && revoked.has(key.publicKeyHex.toLowerCase())))
    throw new Error('Cannot resurrect revoked source key material under another identity');
}
