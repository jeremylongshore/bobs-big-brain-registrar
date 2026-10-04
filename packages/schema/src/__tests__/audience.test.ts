import { describe, it, expect } from 'vitest';
import { Audience } from '../enums.js';
import { ContentMetadata } from '../common.js';
import { CuratedMemory } from '../curated-memory.js';
import { MemoryCandidate } from '../memory-candidate.js';
import { makeCuratedMemory, makeMemoryCandidate } from './fixtures.js';

/**
 * Claim-level audience (Epic K bead K2). The field is an OPTIONAL closed enum on
 * `ContentMetadata`, shared by `MemoryCandidate` and `CuratedMemory`.
 */
describe('Audience enum', () => {
  it('is exactly the three tiers, widest first', () => {
    expect(Audience.options).toEqual(['tenant', 'admins', 'owner']);
  });

  it.each(['tenant', 'admins', 'owner'])('accepts %s', (value) => {
    expect(Audience.parse(value)).toBe(value);
  });

  it.each([
    'team',
    'admin',
    'owners',
    'Tenant',
    'OWNER',
    ' tenant',
    'tenant ',
    '',
    'public',
    '*',
    0,
    null,
    true,
    ['tenant'],
    { tier: 'owner' },
  ])('rejects %j', (value) => {
    expect(Audience.safeParse(value).success).toBe(false);
  });
});

describe('ContentMetadata.audience', () => {
  it('is absent by default — no value is invented for a record that declares none', () => {
    const parsed = ContentMetadata.parse({});
    expect(parsed.audience).toBeUndefined();
    expect(Object.hasOwn(parsed, 'audience')).toBe(false);
  });

  it('round-trips a legacy metadata object without adding an audience key', () => {
    const legacy = { filePaths: ['a.ts'], tags: ['x'], proposedByRole: 'member' };
    expect(JSON.stringify(ContentMetadata.parse(legacy))).toBe(JSON.stringify(legacy));
  });

  it.each(Audience.options)('keeps a declared audience of %s', (value) => {
    expect(ContentMetadata.parse({ audience: value }).audience).toBe(value);
  });

  it('rejects an off-vocabulary audience rather than dropping or coercing it', () => {
    const result = ContentMetadata.safeParse({ audience: 'everyone' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['audience']);
    }
  });

  it('rejects an explicit null (absent and null are not the same thing)', () => {
    expect(ContentMetadata.safeParse({ audience: null }).success).toBe(false);
  });
});

describe('CuratedMemory / MemoryCandidate carry audience in metadata', () => {
  it('a curated memory without audience parses and stays without it', () => {
    const memory = CuratedMemory.parse(makeCuratedMemory());
    expect(memory.metadata.audience).toBeUndefined();
  });

  it.each(Audience.options)('a curated memory accepts audience %s', (value) => {
    const memory = CuratedMemory.parse(makeCuratedMemory({ metadata: { audience: value } }));
    expect(memory.metadata.audience).toBe(value);
  });

  it('a curated memory with an unknown audience fails validation', () => {
    const result = CuratedMemory.safeParse(makeCuratedMemory({ metadata: { audience: 'board' } }));
    expect(result.success).toBe(false);
  });

  it.each(Audience.options)('a candidate can declare audience %s at capture', (value) => {
    const candidate = MemoryCandidate.parse(makeMemoryCandidate({ metadata: { audience: value } }));
    expect(candidate.metadata.audience).toBe(value);
  });

  it('a candidate with an unknown audience fails validation', () => {
    const result = MemoryCandidate.safeParse(
      makeMemoryCandidate({ metadata: { audience: 'admins,owner' } }),
    );
    expect(result.success).toBe(false);
  });

  it('audience is not a top-level field: a stray top-level value is stripped, not honored', () => {
    const memory = CuratedMemory.parse(makeCuratedMemory({ audience: 'owner' }));
    expect(Object.hasOwn(memory, 'audience')).toBe(false);
    expect(memory.metadata.audience).toBeUndefined();
  });
});
