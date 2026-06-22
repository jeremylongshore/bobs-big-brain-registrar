import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { SPOOL_UUID_NAMESPACE, uuidV5, deriveCandidateId, deriveMemoryId } from '../uuid-v5.js';

/**
 * These tests pin the INTKB side of the content-derived id contract (bead
 * `8da.5`). The derivation MUST stay byte-identical to ICO's spool emitter, so
 * the assertions below double as a cross-repo conformance fixture: if any of
 * the golden vectors change, the compile/govern id lineage has diverged.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('SPOOL_UUID_NAMESPACE', () => {
  it('equals the value ICO locks in @ico/types (2026-05-24)', () => {
    // Reassembled from halves so this assertion does not duplicate the split
    // literal verbatim while still pinning the exact bytes.
    const expected = ['6c6f6e67', '7368', '6f72', '6500', '69636f73706c'].join('-');
    expect(SPOOL_UUID_NAMESPACE).toBe(expected);
  });

  it('is itself a syntactically valid UUID', () => {
    expect(SPOOL_UUID_NAMESPACE).toMatch(UUID_RE);
  });
});

describe('uuidV5', () => {
  it('returns a canonical UUID with the version nibble set to 5', () => {
    const id = uuidV5(SPOOL_UUID_NAMESPACE, 'anything');
    expect(id).toMatch(UUID_RE);
    // 15th hex char (index 14, first nibble of byte 6) is the version.
    expect(id.replace(/-/g, '')[12]).toBe('5');
  });

  it('sets the RFC 4122 variant bits (8, 9, a, or b)', () => {
    const id = uuidV5(SPOOL_UUID_NAMESPACE, 'variant-probe');
    // First nibble of byte 8 (index 16 of the de-hyphenated hex).
    expect('89ab').toContain(id.replace(/-/g, '')[16]);
  });

  it('is deterministic: same (namespace, name) yields the same id', () => {
    const a = uuidV5(SPOOL_UUID_NAMESPACE, 'stable-name');
    const b = uuidV5(SPOOL_UUID_NAMESPACE, 'stable-name');
    expect(a).toBe(b);
  });

  it('is sensitive to the name', () => {
    const a = uuidV5(SPOOL_UUID_NAMESPACE, 'name-one');
    const b = uuidV5(SPOOL_UUID_NAMESPACE, 'name-two');
    expect(a).not.toBe(b);
  });

  it('is sensitive to the namespace', () => {
    const otherNs = '00000000-0000-0000-0000-000000000000';
    expect(uuidV5(SPOOL_UUID_NAMESPACE, 'x')).not.toBe(uuidV5(otherNs, 'x'));
  });

  it('matches a hand-rolled RFC 4122 4.3 reference computation', () => {
    const name = 'reference-vector';
    const nsHex = SPOOL_UUID_NAMESPACE.replace(/-/g, '');
    const nsBytes = Buffer.from(nsHex, 'hex');
    const hash = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest();
    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    const expected = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
    expect(uuidV5(SPOOL_UUID_NAMESPACE, name)).toBe(expected);
  });
});

describe('deriveCandidateId', () => {
  const workspaceId = 'my-workspace';
  const relPath = 'wiki/concepts/foo.md';
  const bodySha256 = 'a'.repeat(64);

  it('is deterministic for the same (workspaceId, relPath, bodySha256)', () => {
    const a = deriveCandidateId(workspaceId, relPath, bodySha256);
    const b = deriveCandidateId(workspaceId, relPath, bodySha256);
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
  });

  it("matches ICO's locked golden vector (cross-repo drift guard, bead 8da.10)", () => {
    // The SAME (workspaceId, relPath, bodySha256) triple ICO pins in its own
    // packages/kernel/src/uuid.test.ts must derive the SAME id here. ICO uses
    // SHA_A = '0123456789abcdef' repeated 4x (64 hex chars). If either repo's
    // namespace or NUL-delimited name composition drifts, this assertion fails:
    // the cross-repo dedup key and the audit-chain candidateId link would
    // otherwise diverge silently. This is the INTKB half of the drift guard;
    // ICO pins the same vector independently, so a drift in either repo is caught.
    const SHA_A = '0123456789abcdef'.repeat(4);
    expect(deriveCandidateId('my-workspace', 'wiki/concepts/foo.md', SHA_A)).toBe(
      'e0e430cb-ede6-53ae-8bd0-1edc3b945c6f',
    );
  });

  it('uses a NUL-delimited name tuple byte-identical to ICO buildCandidate', () => {
    // ICO composes `${workspaceId}\x00${relPath}\x00${bodySha256}`.
    const nul = String.fromCharCode(0);
    const expected = uuidV5(
      SPOOL_UUID_NAMESPACE,
      `${workspaceId}${nul}${relPath}${nul}${bodySha256}`,
    );
    expect(deriveCandidateId(workspaceId, relPath, bodySha256)).toBe(expected);
  });

  it('changes when any field changes', () => {
    const base = deriveCandidateId(workspaceId, relPath, bodySha256);
    expect(deriveCandidateId('other-workspace', relPath, bodySha256)).not.toBe(base);
    expect(deriveCandidateId(workspaceId, 'wiki/concepts/bar.md', bodySha256)).not.toBe(base);
    expect(deriveCandidateId(workspaceId, relPath, 'b'.repeat(64))).not.toBe(base);
  });

  it('does not let field-boundary shifts collide (injective composition)', () => {
    // Without the NUL delimiter, ('ab','c',...) and ('a','bc',...) could collide.
    const left = deriveCandidateId('ab', 'c/foo.md', bodySha256);
    const right = deriveCandidateId('a', 'bc/foo.md', bodySha256);
    expect(left).not.toBe(right);
  });
});

describe('deriveMemoryId', () => {
  const candidateId = '11111111-2222-5333-8444-555555555555';
  const contentHash = 'c'.repeat(64);

  it('is deterministic for the same (candidateId, contentHash)', () => {
    const a = deriveMemoryId(candidateId, contentHash);
    const b = deriveMemoryId(candidateId, contentHash);
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
  });

  it('is distinct from the candidate id it derives from', () => {
    expect(deriveMemoryId(candidateId, contentHash)).not.toBe(candidateId);
  });

  it('changes when the candidate id or content hash changes', () => {
    const base = deriveMemoryId(candidateId, contentHash);
    expect(deriveMemoryId('99999999-2222-5333-8444-555555555555', contentHash)).not.toBe(base);
    expect(deriveMemoryId(candidateId, 'd'.repeat(64))).not.toBe(base);
  });
});
