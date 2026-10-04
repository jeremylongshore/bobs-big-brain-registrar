import { describe, it, expect } from 'vitest';
import {
  AUDIENCE_RANK,
  DEFAULT_AUDIENCE,
  READER_ROLE_CLEARANCE,
  isAudienceVisibleToRole,
  isExportableAudience,
  readerRoleFor,
  resolveAudience,
} from '../audience.js';
import { rerankCitedHits } from '../freshness.js';

const NOW = '2026-01-15T10:00:00.000Z';
const ROLES = ['member', 'admin', 'owner'] as const;
const AUDIENCES = ['tenant', 'admins', 'owner'] as const;

describe('resolveAudience', () => {
  it('defaults an absent audience to tenant', () => {
    expect(DEFAULT_AUDIENCE).toBe('tenant');
    expect(resolveAudience(undefined)).toBe('tenant');
    expect(resolveAudience(null)).toBe('tenant');
  });

  it('returns a declared value unchanged — including one it does not recognize', () => {
    expect(resolveAudience('admins')).toBe('admins');
    expect(resolveAudience('board')).toBe('board');
    // An empty string is a declared (bad) value, NOT "absent": it must not default.
    expect(resolveAudience('')).toBe('');
  });
});

describe('isAudienceVisibleToRole — truth table (every role x every audience)', () => {
  it.each([
    // audience, role, visible
    [undefined, 'member', true],
    [undefined, 'admin', true],
    [undefined, 'owner', true],
    ['tenant', 'member', true],
    ['tenant', 'admin', true],
    ['tenant', 'owner', true],
    ['admins', 'member', false],
    ['admins', 'admin', true],
    ['admins', 'owner', true],
    ['owner', 'member', false],
    ['owner', 'admin', false],
    ['owner', 'owner', true],
  ] as const)('audience=%s role=%s -> %s', (audience, role, visible) => {
    expect(isAudienceVisibleToRole(audience, role)).toBe(visible);
  });

  it('treats null audience like absent', () => {
    for (const role of ROLES) expect(isAudienceVisibleToRole(null, role)).toBe(true);
  });
});

describe('isAudienceVisibleToRole — fails closed', () => {
  it.each([
    'board',
    'TENANT',
    'Admins',
    ' tenant',
    'tenant ',
    '',
    'all',
    '*',
    'public',
    // Inherited Object.prototype keys must not be mistaken for a tier.
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
    'valueOf',
  ])('an unrecognized audience %j is hidden from every role, the owner included', (audience) => {
    for (const role of ROLES) expect(isAudienceVisibleToRole(audience, role)).toBe(false);
  });

  it.each([
    'superuser',
    'root',
    'ADMIN',
    'Owner',
    '',
    'constructor',
    'toString',
    '__proto__',
    undefined,
    null,
  ])('an unrecognized role %j sees nothing, not even tenant-wide memories', (role) => {
    for (const audience of [undefined, ...AUDIENCES]) {
      expect(isAudienceVisibleToRole(audience, role)).toBe(false);
    }
  });
});

describe('isAudienceVisibleToRole — structural properties', () => {
  it('is monotonic in role: whatever a role sees, every higher role sees too', () => {
    for (const audience of [undefined, ...AUDIENCES]) {
      for (let i = 0; i < ROLES.length; i++) {
        if (!isAudienceVisibleToRole(audience, ROLES[i])) continue;
        for (let j = i; j < ROLES.length; j++) {
          expect(isAudienceVisibleToRole(audience, ROLES[j])).toBe(true);
        }
      }
    }
  });

  it('is monotonic in audience: narrowing an audience never reveals it to a new role', () => {
    for (const role of ROLES) {
      for (let i = 0; i < AUDIENCES.length; i++) {
        if (isAudienceVisibleToRole(AUDIENCES[i], role)) continue;
        for (let j = i; j < AUDIENCES.length; j++) {
          expect(isAudienceVisibleToRole(AUDIENCES[j], role)).toBe(false);
        }
      }
    }
  });

  it('the owner sees every recognized audience; a member sees only the default', () => {
    expect(AUDIENCES.filter((a) => isAudienceVisibleToRole(a, 'owner'))).toEqual([...AUDIENCES]);
    expect(AUDIENCES.filter((a) => isAudienceVisibleToRole(a, 'admin'))).toEqual([
      'tenant',
      'admins',
    ]);
    expect(AUDIENCES.filter((a) => isAudienceVisibleToRole(a, 'member'))).toEqual(['tenant']);
  });

  it('ranks are distinct, dense from 0, and the tables are frozen', () => {
    expect(Object.keys(AUDIENCE_RANK)).toEqual([...AUDIENCES]);
    expect(Object.values(AUDIENCE_RANK)).toEqual([0, 1, 2]);
    expect(Object.keys(READER_ROLE_CLEARANCE)).toEqual([...ROLES]);
    expect(Object.values(READER_ROLE_CLEARANCE)).toEqual([0, 1, 2]);
    expect(Object.isFrozen(AUDIENCE_RANK)).toBe(true);
    expect(Object.isFrozen(READER_ROLE_CLEARANCE)).toBe(true);
  });
});

describe('isExportableAudience', () => {
  it.each([
    [undefined, true],
    [null, true],
    ['tenant', true],
    ['admins', false],
    ['owner', false],
    ['board', false],
    ['', false],
    ['TENANT', false],
  ] as const)('audience=%j -> exportable %s', (audience, exportable) => {
    expect(isExportableAudience(audience)).toBe(exportable);
  });

  it('agrees with the member predicate: exportable exactly when a member may read it', () => {
    for (const audience of [undefined, ...AUDIENCES, 'board', '']) {
      expect(isExportableAudience(audience)).toBe(isAudienceVisibleToRole(audience, 'member'));
    }
  });
});

describe('readerRoleFor', () => {
  it.each([
    ['admin', true, 'owner'],
    ['admin', false, 'admin'],
    ['member', false, 'member'],
    // An owner flag never raises a non-admin.
    ['member', true, 'member'],
    [undefined, true, 'member'],
    [undefined, false, 'member'],
    [null, true, 'member'],
    ['owner', true, 'member'],
    ['ADMIN', true, 'member'],
    ['', true, 'member'],
  ] as const)('role=%j owner=%s -> %s', (role, owner, expected) => {
    expect(readerRoleFor(role, owner)).toBe(expected);
  });
});

describe('rerankCitedHits threads audience (K2)', () => {
  const hits = [{ file: 'qmd://kb-curated/abc.md', score: 1 }];

  it('carries the resolved memory audience onto the hit', () => {
    const reranked = rerankCitedHits(
      hits,
      () => ({ category: 'reference', updatedAt: NOW, audience: 'owner' }),
      NOW,
    );
    expect(reranked[0]!.audience).toBe('owner');
  });

  it('defaults a resolved memory with no audience to tenant', () => {
    const reranked = rerankCitedHits(hits, () => ({ category: 'reference', updatedAt: NOW }), NOW);
    expect(reranked[0]!.audience).toBe('tenant');
  });

  it('defaults an unresolved hit to tenant', () => {
    const reranked = rerankCitedHits(hits, () => null, NOW);
    expect(reranked[0]!.audience).toBe('tenant');
    expect(reranked[0]!.memoryId).toBeNull();
  });
});
