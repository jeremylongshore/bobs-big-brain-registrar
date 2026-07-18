import { describe, it, expect } from 'vitest';
import {
  getDirectory,
  getCategoryDirectory,
  getRelativePath,
  UnknownCategoryError,
} from '../formatter/directory-mapper.js';
import { makeCuratedMemory, NOW } from './fixtures.js';
import { MemoryCategory } from '@qmd-team-intent-kb/schema';
import { randomUUID } from 'node:crypto';

describe('getCategoryDirectory', () => {
  it('maps decision → decisions', () => {
    expect(getCategoryDirectory('decision')).toBe('decisions');
  });

  it('maps pattern → curated', () => {
    expect(getCategoryDirectory('pattern')).toBe('curated');
  });

  it('maps convention → curated', () => {
    expect(getCategoryDirectory('convention')).toBe('curated');
  });

  it('maps architecture → curated', () => {
    expect(getCategoryDirectory('architecture')).toBe('curated');
  });

  it('maps troubleshooting → guides', () => {
    expect(getCategoryDirectory('troubleshooting')).toBe('guides');
  });

  it('maps reference → guides', () => {
    expect(getCategoryDirectory('reference')).toBe('guides');
  });

  it('maps onboarding → guides', () => {
    expect(getCategoryDirectory('onboarding')).toBe('guides');
  });

  it('throws UnknownCategoryError on an unmapped category (fail-closed, 5bm.5)', () => {
    // Previously an unknown category silently landed in curated/ — the
    // governance-approved, default-searched bucket. It must now fail loud, and
    // the error carries the offending category for diagnosis.
    expect(() => getCategoryDirectory('unknown-category')).toThrow(UnknownCategoryError);
    expect(() => getCategoryDirectory('made-up')).toThrow(new UnknownCategoryError('made-up'));
  });
});

describe('getDirectory', () => {
  it('archived lifecycle → archive regardless of category', () => {
    const memory = makeCuratedMemory({ category: 'decision', lifecycle: 'archived' });
    expect(getDirectory(memory)).toBe('archive');
  });

  it('superseded lifecycle → archive regardless of category', () => {
    const supersededById = randomUUID();
    const memory = makeCuratedMemory({
      category: 'pattern',
      lifecycle: 'superseded',
      supersession: { supersededBy: supersededById, reason: 'Updated', linkedAt: NOW },
    });
    expect(getDirectory(memory)).toBe('archive');
  });

  it('active lifecycle uses category mapping', () => {
    const memory = makeCuratedMemory({ category: 'decision', lifecycle: 'active' });
    expect(getDirectory(memory)).toBe('decisions');
  });

  it('deprecated lifecycle uses category mapping', () => {
    const memory = makeCuratedMemory({ category: 'pattern', lifecycle: 'deprecated' });
    expect(getDirectory(memory)).toBe('curated');
  });

  it('active architecture → curated', () => {
    const memory = makeCuratedMemory({ category: 'architecture', lifecycle: 'active' });
    expect(getDirectory(memory)).toBe('curated');
  });

  it('active reference → guides', () => {
    const memory = makeCuratedMemory({ category: 'reference', lifecycle: 'active' });
    expect(getDirectory(memory)).toBe('guides');
  });
});

describe('getRelativePath', () => {
  it('combines directory with {id}.md', () => {
    const memory = makeCuratedMemory({ category: 'decision', lifecycle: 'active' });
    expect(getRelativePath(memory)).toBe(`decisions/${memory.id}.md`);
  });

  it('archived memory path uses archive/', () => {
    const memory = makeCuratedMemory({ category: 'pattern', lifecycle: 'archived' });
    expect(getRelativePath(memory)).toBe(`archive/${memory.id}.md`);
  });

  it('pattern memory path uses curated/', () => {
    const memory = makeCuratedMemory({ category: 'pattern', lifecycle: 'active' });
    expect(getRelativePath(memory)).toBe(`curated/${memory.id}.md`);
  });

  it('guides memory path uses guides/', () => {
    const memory = makeCuratedMemory({ category: 'onboarding', lifecycle: 'active' });
    expect(getRelativePath(memory)).toBe(`guides/${memory.id}.md`);
  });
});

describe('getCategoryDirectory ↔ schema enum lock-step (5bm.5 follow-up)', () => {
  it('maps every MemoryCategory the schema defines without throwing', () => {
    // Drift guard: if the schema enum grows, this fails until the mapper adds
    // the new category — so a schema-valid memory can never hit the fail-closed
    // default at export time (the operational regression the reviewer flagged).
    for (const category of MemoryCategory.options) {
      expect(() => getCategoryDirectory(category)).not.toThrow();
      expect(['decisions', 'curated', 'guides']).toContain(getCategoryDirectory(category));
    }
  });
});
