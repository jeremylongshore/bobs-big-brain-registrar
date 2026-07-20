import { describe, it, expect } from 'vitest';
import { CandidateOrigin, MemoryCandidate, PrePolicyFlags } from '../memory-candidate.js';
import { makeMemoryCandidate } from './fixtures.js';

describe('PrePolicyFlags', () => {
  it('defaults all flags to false', () => {
    const flags = PrePolicyFlags.parse({});
    expect(flags.potentialSecret).toBe(false);
    expect(flags.lowConfidence).toBe(false);
    expect(flags.duplicateSuspect).toBe(false);
  });

  it('accepts explicit flag values', () => {
    const flags = PrePolicyFlags.parse({ potentialSecret: true, lowConfidence: true });
    expect(flags.potentialSecret).toBe(true);
    expect(flags.lowConfidence).toBe(true);
    expect(flags.duplicateSuspect).toBe(false);
  });
});

describe('MemoryCandidate', () => {
  it('parses a valid candidate', () => {
    const input = makeMemoryCandidate();
    const result = MemoryCandidate.parse(input);
    expect(result.status).toBe('inbox');
    expect(result.source).toBe('claude_session');
    expect(result.category).toBe('convention');
  });

  it('defaults trustLevel to medium', () => {
    const { trustLevel: _removed, ...input } = makeMemoryCandidate();
    const result = MemoryCandidate.parse(input);
    expect(result.trustLevel).toBe('medium');
  });

  it('defaults metadata to empty', () => {
    const { metadata: _removed, ...input } = makeMemoryCandidate();
    const result = MemoryCandidate.parse(input);
    expect(result.metadata.filePaths).toEqual([]);
    expect(result.metadata.tags).toEqual([]);
  });

  it('defaults prePolicyFlags to all false', () => {
    const { prePolicyFlags: _removed, ...input } = makeMemoryCandidate();
    const result = MemoryCandidate.parse(input);
    expect(result.prePolicyFlags.potentialSecret).toBe(false);
  });

  it('rejects missing required id', () => {
    const { id: _removed, ...input } = makeMemoryCandidate();
    expect(() => MemoryCandidate.parse(input)).toThrow();
  });

  it('rejects missing required content', () => {
    const { content: _removed, ...input } = makeMemoryCandidate();
    expect(() => MemoryCandidate.parse(input)).toThrow();
  });

  it('rejects empty content', () => {
    expect(() => MemoryCandidate.parse(makeMemoryCandidate({ content: '' }))).toThrow();
  });

  it('rejects empty title', () => {
    expect(() => MemoryCandidate.parse(makeMemoryCandidate({ title: '' }))).toThrow();
  });

  it('rejects invalid source', () => {
    expect(() =>
      MemoryCandidate.parse(makeMemoryCandidate({ source: 'email' as 'manual' })),
    ).toThrow();
  });

  it('rejects invalid category', () => {
    expect(() =>
      MemoryCandidate.parse(makeMemoryCandidate({ category: 'other' as 'pattern' })),
    ).toThrow();
  });

  it('rejects non-inbox status', () => {
    expect(() =>
      MemoryCandidate.parse(makeMemoryCandidate({ status: 'review' as 'inbox' })),
    ).toThrow();
  });

  it('rejects invalid UUID for id', () => {
    expect(() => MemoryCandidate.parse(makeMemoryCandidate({ id: 'not-a-uuid' }))).toThrow();
  });

  it('accepts all valid sources', () => {
    for (const source of ['claude_session', 'manual', 'import', 'mcp'] as const) {
      expect(MemoryCandidate.parse(makeMemoryCandidate({ source })).source).toBe(source);
    }
  });

  // 5bm.8 — the low-trust stamp on bulk digestions is a schema-boundary
  // invariant, not an emitter convention: a bulk_import candidate can never
  // claim curated-grade trust past this parse.
  describe('bulk_import low-trust stamp (5bm.8)', () => {
    it("accepts bulk_import with trustLevel 'low'", () => {
      const c = MemoryCandidate.parse(
        makeMemoryCandidate({ source: 'bulk_import', trustLevel: 'low' }),
      );
      expect(c.source).toBe('bulk_import');
      expect(c.trustLevel).toBe('low');
    });

    it("accepts bulk_import with trustLevel 'untrusted'", () => {
      const c = MemoryCandidate.parse(
        makeMemoryCandidate({ source: 'bulk_import', trustLevel: 'untrusted' }),
      );
      expect(c.trustLevel).toBe('untrusted');
    });

    it.each(['medium', 'high'] as const)('rejects bulk_import claiming trustLevel %s', (trust) => {
      const result = MemoryCandidate.safeParse(
        makeMemoryCandidate({ source: 'bulk_import', trustLevel: trust }),
      );
      expect(result.success).toBe(false);
    });

    it('rejects a bulk_import line that omits trustLevel (default medium is not a valid stamp)', () => {
      const input = makeMemoryCandidate({ source: 'bulk_import' }) as Record<string, unknown>;
      delete input['trustLevel'];
      const result = MemoryCandidate.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('leaves non-bulk sources free to carry medium/high trust', () => {
      const c = MemoryCandidate.parse(
        makeMemoryCandidate({ source: 'import', trustLevel: 'high' }),
      );
      expect(c.trustLevel).toBe('high');
    });
  });

  it('accepts all valid categories', () => {
    const categories = [
      'decision',
      'pattern',
      'convention',
      'architecture',
      'troubleshooting',
      'onboarding',
      'reference',
    ] as const;
    for (const category of categories) {
      expect(MemoryCandidate.parse(makeMemoryCandidate({ category })).category).toBe(category);
    }
  });

  it('preserves metadata fields', () => {
    const result = MemoryCandidate.parse(
      makeMemoryCandidate({
        metadata: {
          filePaths: ['src/main.ts'],
          language: 'typescript',
          tags: ['api'],
        },
      }),
    );
    expect(result.metadata.filePaths).toEqual(['src/main.ts']);
    expect(result.metadata.language).toBe('typescript');
  });
});

describe('CandidateOrigin (GSB Wave-2 H1 — write-time provenance)', () => {
  const validOrigin = {
    tokenHmac: 'ab'.repeat(32),
    channel: 'local-mcp',
    mintedAt: '2026-01-15T10:00:00.000Z',
  };

  it('origin is OPTIONAL — a candidate without it parses (backward compatibility)', () => {
    const result = MemoryCandidate.parse(makeMemoryCandidate());
    expect(result.origin).toBeUndefined();
  });

  it('parses a candidate WITH a well-formed origin, without touching id derivation inputs', () => {
    const input = makeMemoryCandidate({ origin: validOrigin });
    const result = MemoryCandidate.parse(input);
    expect(result.origin).toEqual(validOrigin);
    // The identity fields the spool id derives from are unchanged by origin.
    expect(result.id).toBe((input as { id: string }).id);
  });

  it('rejects a tokenHmac that is not 64 lowercase hex chars', () => {
    for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32), '']) {
      expect(() => CandidateOrigin.parse({ ...validOrigin, tokenHmac: bad })).toThrow();
    }
  });

  it('rejects channels that are not bounded kebab tags', () => {
    for (const bad of ['Team MCP', '-leading-dash', 'UPPER', 'a'.repeat(65), '']) {
      expect(() => CandidateOrigin.parse({ ...validOrigin, channel: bad })).toThrow();
    }
  });

  it('rejects a non-ISO mintedAt', () => {
    expect(() => CandidateOrigin.parse({ ...validOrigin, mintedAt: 'yesterday' })).toThrow();
  });
});

describe("CandidateOrigin — 'unattested' is reserved receipt vocabulary (schema-enforced)", () => {
  const origin = {
    tokenHmac: 'ab'.repeat(32),
    channel: 'unattested',
    mintedAt: '2026-01-15T10:00:00.000Z',
  };

  it("rejects a client-claimed channel 'unattested' at parse time", () => {
    const res = CandidateOrigin.safeParse(origin);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toMatch(/reserved receipt vocabulary/);
      expect(res.error.issues[0]?.path).toEqual(['channel']);
    }
  });

  it("rejects a full MemoryCandidate claiming channel 'unattested'", () => {
    const input = makeMemoryCandidate({ origin });
    expect(MemoryCandidate.safeParse(input).success).toBe(false);
  });
});
