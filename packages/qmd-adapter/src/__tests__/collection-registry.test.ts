import { describe, it, expect } from 'vitest';
import {
  KNOWN_COLLECTIONS,
  getDefaultSearchCollections,
  getAllCollectionNames,
  isKnownCollection,
  isDefaultSearchCollection,
} from '../collections/collection-registry.js';

describe('KNOWN_COLLECTIONS', () => {
  it('has 6 collections', () => {
    expect(KNOWN_COLLECTIONS).toHaveLength(6);
  });

  it('all have required fields', () => {
    for (const c of KNOWN_COLLECTIONS) {
      expect(c.name).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(typeof c.includeInDefaultSearch).toBe('boolean');
    }
  });
});

describe('getDefaultSearchCollections', () => {
  it('includes kb-curated, kb-decisions, kb-guides', () => {
    const defaults = getDefaultSearchCollections();
    expect(defaults).toContain('kb-curated');
    expect(defaults).toContain('kb-decisions');
    expect(defaults).toContain('kb-guides');
  });

  it('excludes kb-inbox, kb-archive, and kb-bulk', () => {
    const defaults = getDefaultSearchCollections();
    expect(defaults).not.toContain('kb-inbox');
    expect(defaults).not.toContain('kb-archive');
    // 5bm.8: the bulk-digestion corpus never rides the default surface.
    expect(defaults).not.toContain('kb-bulk');
  });

  it('returns 3 collections', () => {
    expect(getDefaultSearchCollections()).toHaveLength(3);
  });
});

describe('getAllCollectionNames', () => {
  it('returns all 6 names', () => {
    const names = getAllCollectionNames();
    expect(names).toHaveLength(6);
    expect(names).toContain('kb-inbox');
    expect(names).toContain('kb-archive');
    expect(names).toContain('kb-bulk');
  });
});

describe('isKnownCollection', () => {
  it('returns true for known collections', () => {
    expect(isKnownCollection('kb-curated')).toBe(true);
    expect(isKnownCollection('kb-inbox')).toBe(true);
  });

  it('returns false for unknown collections', () => {
    expect(isKnownCollection('kb-unknown')).toBe(false);
    expect(isKnownCollection('')).toBe(false);
  });
});

describe('isDefaultSearchCollection', () => {
  it('returns true for default search collections', () => {
    expect(isDefaultSearchCollection('kb-curated')).toBe(true);
    expect(isDefaultSearchCollection('kb-guides')).toBe(true);
  });

  it('returns false for non-default collections', () => {
    expect(isDefaultSearchCollection('kb-inbox')).toBe(false);
    expect(isDefaultSearchCollection('kb-archive')).toBe(false);
    expect(isDefaultSearchCollection('kb-bulk')).toBe(false);
  });
});
