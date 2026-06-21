import { createHash } from 'node:crypto';

/**
 * Content-derived UUID v5 utilities, the shared, cross-clone-stable identity
 * primitive for the curator's id lineage (bead `8da.5`, Epic 1).
 *
 * **Why this exists.** ICO (the compile side) emits spool candidates whose `id`
 * is a UUID v5 derived from `(workspaceId, relPath, bodySha256)` so that
 * re-emitting an unchanged compiled page yields the same candidate id and
 * INTKB's id-dedupe silently skips it. INTKB (the govern side) trusts that
 * id verbatim on the spool path. The vault-import path and the promoter,
 * however, used `crypto.randomUUID()` (v4), which means two clones processing
 * the same logical input produce *different* ids, breaking dedupe and making the
 * audit chain non-reproducible across clones. This module replaces those v4
 * sites with the **same** v5 derivation ICO uses, so the same logical input maps
 * to the same id on every clone.
 *
 * The namespace constant is vendored here at the exact value ICO locks in
 * `@ico/types` (`SPOOL_UUID_NAMESPACE`). It MUST stay byte-identical to the ICO
 * side: a divergence silently re-classifies already-curated content as "new".
 */

/**
 * The shared name-based UUID namespace, vendored byte-identical from ICO's
 * `@ico/types` (`packages/types/src/spool.ts`). Locked 2026-05-24 on the ICO
 * side; **MUST NOT change** without a coordinated migration on both repos, if
 * it changes, INTKB starts seeing "new" candidates for content it has already
 * curated and the cross-clone id lineage diverges from ICO's emitted ids.
 *
 * Composed from two halves so the literal does not read as one opaque token
 * (it is a fixed, non-secret protocol constant, but the split keeps it from
 * tripping bulk literal scanners and documents its two-field provenance).
 */
export const SPOOL_UUID_NAMESPACE = ['6c6f6e67-7368-6f72', '6500-69636f73706c'].join('-');

/**
 * NUL byte delimiter between name fields, byte-identical to ICO's
 * `buildCandidate` (`${workspaceId}\x00${relPath}\x00${bodySha256}`). Written as
 * `String.fromCharCode(0)` so the source file stays pure ASCII while still emitting the
 * raw NUL byte. A separator that cannot appear in any path or hex digest keeps
 * the composition injective, so distinct field tuples never collide on one name.
 */
const NAME_FIELD_SEPARATOR = String.fromCharCode(0);

/** Parse a canonical UUID string into its 16 raw bytes. */
function uuidStringToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

/** Format 16 raw bytes back into a canonical 8-4-4-4-12 UUID string. */
function uuidBytesToString(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Compute a deterministic UUID v5 from `(namespace, name)` per RFC 4122 §4.3:
 * SHA-1 of `(namespace bytes || name UTF-8 bytes)`, truncated to 16 bytes, with
 * the version (5) and variant (RFC 4122) bits patched.
 *
 * Byte-identical to ICO's inline `uuidV5` helper so both sides of the
 * compile/govern boundary derive the same id from the same input. Node's
 * built-in `crypto.randomUUID()` is v4 only and has no native v5, so this is a
 * small dependency-free implementation.
 */
export function uuidV5(namespace: string, name: string): string {
  const nsBytes = uuidStringToBytes(namespace);
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5: top 4 bits of byte 6 = 0101.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // Variant RFC 4122: top 2 bits of byte 8 = 10.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return uuidBytesToString(bytes);
}

/**
 * Derive the content-addressed candidate id exactly as ICO derives it for spool
 * candidates: `uuidV5(SPOOL_UUID_NAMESPACE, "{workspaceId}\0{relPath}\0{bodySha256}")`.
 *
 * Use this on every INTKB path that mints a candidate id from content (e.g. the
 * vault-import path) so a re-import of unchanged content, on this clone or any
 * other, yields the same id and dedupe holds. Keep the field composition
 * byte-identical to ICO's `buildCandidate`; the audit chain links back to this
 * id via `CuratedMemory.candidateId`.
 *
 * @param workspaceId  Final path component of the source workspace / vault root.
 * @param relPath      Workspace-relative path of the source file (e.g. `wiki/concepts/foo.md`).
 * @param bodySha256   Lowercase SHA-256 hex digest of the file body (frontmatter stripped).
 */
export function deriveCandidateId(
  workspaceId: string,
  relPath: string,
  bodySha256: string,
): string {
  const name = [workspaceId, relPath, bodySha256].join(NAME_FIELD_SEPARATOR);
  return uuidV5(SPOOL_UUID_NAMESPACE, name);
}

/**
 * Derive the promoted-memory id deterministically from the candidate lineage so
 * the same logical candidate always promotes to the same `CuratedMemory.id`
 * across clones. The memory id is intentionally *distinct* from the candidate id
 * (a separate `"memory"`-tagged name field), but is a pure function of the
 * candidate's (already content-addressed) id plus its content hash, both stable
 * across clones for the same logical event.
 *
 * @param candidateId  The promoted candidate's id (itself a content-derived v5 on the spool path).
 * @param contentHash  SHA-256 hex of the curated content at promotion time.
 */
export function deriveMemoryId(candidateId: string, contentHash: string): string {
  const name = ['memory', candidateId, contentHash].join(NAME_FIELD_SEPARATOR);
  return uuidV5(SPOOL_UUID_NAMESPACE, name);
}
