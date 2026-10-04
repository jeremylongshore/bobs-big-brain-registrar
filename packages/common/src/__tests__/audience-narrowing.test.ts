import { describe, it, expect } from 'vitest';
import {
  AUDIENCE_RANK,
  isAudienceNarrowing,
  isAudienceVisibleToRole,
  validateAudienceNarrowing,
} from '../audience.js';

/**
 * Governed audience narrowing (Epic K bead K3): the one legal move is toward a
 * STRICTLY narrower tier. Tiers widest -> narrowest: tenant, admins, owner.
 */
const TIERS = ['tenant', 'admins', 'owner'] as const;
const ROLES = ['member', 'admin', 'owner'] as const;
const UNKNOWN = ['board', '', 'TENANT', 'Owner', ' admins'] as const;

describe('validateAudienceNarrowing — truth table', () => {
  it.each([
    ['tenant', 'admins'],
    ['tenant', 'owner'],
    ['admins', 'owner'],
    [undefined, 'admins'],
    [undefined, 'owner'],
    [null, 'owner'],
  ] as const)('%j -> %j is a legal narrowing', (from, to) => {
    const result = validateAudienceNarrowing(from, to);
    expect(result).toEqual({ valid: true, from: from ?? 'tenant', to });
    expect(isAudienceNarrowing(from, to)).toBe(true);
  });

  it.each([
    ['admins', 'tenant'],
    ['owner', 'tenant'],
    ['owner', 'admins'],
  ] as const)('%j -> %j is refused as widening', (from, to) => {
    const result = validateAudienceNarrowing(from, to);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('widening');
      expect(result.error).toContain('Refusing to widen');
      expect(result.error).toContain('K4');
    }
    expect(isAudienceNarrowing(from, to)).toBe(false);
  });

  it.each([
    ['tenant', 'tenant'],
    ['admins', 'admins'],
    ['owner', 'owner'],
    [undefined, 'tenant'],
    [null, 'tenant'],
  ] as const)('%j -> %j is refused as the same tier', (from, to) => {
    const result = validateAudienceNarrowing(from, to);
    expect(result).toMatchObject({ valid: false, code: 'same' });
  });

  it.each(UNKNOWN)('an unknown target %j is refused, never treated as a tier', (to) => {
    for (const from of [undefined, ...TIERS]) {
      expect(validateAudienceNarrowing(from, to)).toMatchObject({
        valid: false,
        code: 'unknown_to',
      });
    }
  });

  it('a missing target is refused', () => {
    expect(validateAudienceNarrowing('tenant', undefined)).toMatchObject({ code: 'unknown_to' });
    expect(validateAudienceNarrowing('tenant', null)).toMatchObject({ code: 'unknown_to' });
  });

  it.each(UNKNOWN)('an unknown stored audience %j is refused before the target is read', (from) => {
    for (const to of [...TIERS, 'board']) {
      expect(validateAudienceNarrowing(from, to)).toMatchObject({
        valid: false,
        code: 'unknown_from',
      });
    }
  });

  it('does not treat an inherited property name as a tier', () => {
    expect(validateAudienceNarrowing('tenant', 'constructor')).toMatchObject({
      code: 'unknown_to',
    });
    expect(validateAudienceNarrowing('toString', 'owner')).toMatchObject({
      code: 'unknown_from',
    });
  });
});

describe('narrowing order — properties over every tier pair', () => {
  const pairs = TIERS.flatMap((from) => TIERS.map((to) => [from, to] as const));

  it('is exactly the strict rank order', () => {
    for (const [from, to] of pairs) {
      expect(isAudienceNarrowing(from, to)).toBe(AUDIENCE_RANK[to]! > AUDIENCE_RANK[from]!);
    }
  });

  it('is irreflexive: no tier narrows to itself', () => {
    for (const tier of TIERS) expect(isAudienceNarrowing(tier, tier)).toBe(false);
  });

  it('is asymmetric: a legal narrowing can never be undone by another narrowing', () => {
    for (const [from, to] of pairs) {
      if (isAudienceNarrowing(from, to)) expect(isAudienceNarrowing(to, from)).toBe(false);
    }
  });

  it('is transitive: narrowing twice equals one legal narrowing', () => {
    for (const a of TIERS) {
      for (const b of TIERS) {
        for (const c of TIERS) {
          if (isAudienceNarrowing(a, b) && isAudienceNarrowing(b, c)) {
            expect(isAudienceNarrowing(a, c)).toBe(true);
          }
        }
      }
    }
  });

  it('is total on distinct tiers: exactly one direction is a narrowing', () => {
    for (const [from, to] of pairs) {
      if (from === to) continue;
      expect(isAudienceNarrowing(from, to) !== isAudienceNarrowing(to, from)).toBe(true);
    }
  });

  it('terminates: any chain of narrowings is shorter than the number of tiers', () => {
    for (const start of TIERS) {
      let current: string = start;
      let steps = 0;
      for (;;) {
        const next = TIERS.find((t) => isAudienceNarrowing(current, t));
        if (next === undefined) break;
        current = next;
        steps += 1;
      }
      expect(current).toBe('owner');
      expect(steps).toBeLessThan(TIERS.length);
    }
  });

  it('never reveals a memory to a role that could not already read it', () => {
    for (const [from, to] of pairs) {
      if (!isAudienceNarrowing(from, to)) continue;
      for (const role of ROLES) {
        if (isAudienceVisibleToRole(to, role)) {
          expect(isAudienceVisibleToRole(from, role)).toBe(true);
        }
      }
    }
  });

  it('always hides the memory from at least one role that could read it', () => {
    for (const [from, to] of pairs) {
      if (!isAudienceNarrowing(from, to)) continue;
      const lost = ROLES.filter(
        (role) => isAudienceVisibleToRole(from, role) && !isAudienceVisibleToRole(to, role),
      );
      expect(lost.length).toBeGreaterThan(0);
    }
  });

  it('a refused change never reports a from/to pair', () => {
    for (const from of [undefined, ...TIERS, ...UNKNOWN]) {
      for (const to of [...TIERS, ...UNKNOWN]) {
        const result = validateAudienceNarrowing(from, to);
        if (!result.valid) {
          expect(result).not.toHaveProperty('from');
          expect(result.error.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
