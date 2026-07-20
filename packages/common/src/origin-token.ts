import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getTeamKbBasePath } from './paths.js';

/**
 * Write-time provenance origin tokens (GSB Wave-2 H1/H2).
 *
 * A capture must carry a verifiable origin: an HMAC-SHA256 token minted at
 * capture time over the candidate's identity tuple `(id, tenantId, capturedAt)`
 * keyed by a per-installation secret. The govern/promotion path re-derives the
 * HMAC with the SAME secret and rejects a candidate whose token does not verify
 * — a receipted policy-style reject (`origin_token_invalid`), never a crash.
 *
 * ## What the token does — and does not — prove
 *
 * The token binds a capture to an INSTALLATION (whoever holds the secret) and
 * to a claimed identity tuple. It proves *where a capture came from*, not that
 * its content is true: an AUTHENTICATED insider holding the secret can still
 * mint valid tokens over poisoned content. The mitigations for that residual
 * are governance policy, human review, and supersession — not this token
 * (named honestly in the plugin repo's AGENTS.md, H5).
 *
 * ## Why HMAC over the identity tuple, not the content
 *
 * The spool candidate id is already content-derived
 * (`uuidV5(ns, workspaceId\0relPath\0bodySha256)` — see `uuid-v5.ts`), so
 * binding `(id, tenantId, capturedAt)` transitively covers content identity on
 * the spool path while keeping the token derivation INDEPENDENT of the id
 * derivation: adding `origin` to a candidate never changes its `id`.
 *
 * ## No verification oracle
 *
 * Verification results are only ever surfaced as governance outcomes on the
 * candidate's own promotion path (promote vs `origin_token_invalid` reject).
 * No API/tool exposes "verify this arbitrary token" — and receipts persist only
 * a SHA-256 *hash* of the token (see {@link hashOriginToken}), so surfaced
 * audit details are never enough to replay-mint.
 */

/** Filename of the per-installation origin secret under the TeamKB base dir. */
export const ORIGIN_SECRET_FILENAME = 'origin-secret';

/**
 * Env override for the origin secret (lowercase-hex string). Takes precedence
 * over the on-disk file. In TEAM mode this is the ONLY client-side source —
 * a team client must never auto-generate a secret of its own (it would mint
 * tokens the server's secret cannot verify).
 */
export const ORIGIN_SECRET_ENV = 'TEAMKB_ORIGIN_SECRET';

/**
 * The receipt channel recorded for a candidate that carries NO origin
 * attestation (pre-H1 spools, legacy captures, team clients without the
 * distributed secret). Reserved: it is a RECEIPT vocabulary word, never a
 * client-claimable `origin.channel` value (the schema's tag shape allows it,
 * but intake allowlists must not include it).
 */
export const UNATTESTED_CHANNEL = 'unattested';

/** NUL field separator — injective over ids/tenants/timestamps (mirrors uuid-v5.ts). */
const FIELD_SEPARATOR = String.fromCharCode(0);

/** The identity tuple an origin token binds. */
export interface OriginTokenIdentity {
  /** The candidate's id (UUID). */
  candidateId: string;
  /** The tenant the capture claims. */
  tenantId: string;
  /** The candidate's `capturedAt` ISO-8601 timestamp, byte-exact. */
  capturedAt: string;
}

/** Canonical HMAC input for an identity tuple — NUL-joined, byte-stable. */
export function buildOriginTokenPayload(identity: OriginTokenIdentity): string {
  return [identity.candidateId, identity.tenantId, identity.capturedAt].join(FIELD_SEPARATOR);
}

/**
 * Mint an origin token: HMAC-SHA256 (lowercase hex) over the identity tuple,
 * keyed by the installation secret.
 */
export function mintOriginToken(secret: string, identity: OriginTokenIdentity): string {
  return createHmac('sha256', secret)
    .update(buildOriginTokenPayload(identity), 'utf8')
    .digest('hex');
}

/**
 * Verify a presented origin token against the installation secret in constant
 * time. Returns false (never throws) for malformed tokens, so a garbage
 * `tokenHmac` degrades to the same receipted reject as a forged one.
 */
export function verifyOriginToken(
  secret: string,
  identity: OriginTokenIdentity,
  tokenHmac: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(tokenHmac)) return false;
  const expected = Buffer.from(mintOriginToken(secret, identity), 'hex');
  const presented = Buffer.from(tokenHmac, 'hex');
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

/**
 * SHA-256 hex of a token HMAC — what promotion receipts persist (H2). Receipts
 * must never carry the token itself: the stored/ surfaced value is a one-way
 * hash, truncated further at surfacing, so audit output can identify a token
 * without enabling replay-minting.
 */
export function hashOriginToken(tokenHmac: string): string {
  return createHash('sha256').update(tokenHmac, 'utf8').digest('hex');
}

/** Truncation applied when a receipt/detail surface shows a token hash (H2). */
export const ORIGIN_TOKEN_HASH_SURFACE_LEN = 16;

/**
 * Resolve the per-installation origin secret WITHOUT creating one:
 * `TEAMKB_ORIGIN_SECRET` env first, then `<base>/origin-secret`. Returns
 * undefined when neither exists. Team-mode clients use exactly this (never the
 * auto-creating variant): minting under a freshly-invented secret would
 * produce tokens the server rejects.
 */
export function loadOriginSecret(basePath?: string): string | undefined {
  const env = process.env[ORIGIN_SECRET_ENV]?.trim();
  if (env !== undefined && env.length > 0) return env;
  try {
    const secret = readFileSync(originSecretPath(basePath), 'utf8').trim();
    return secret.length > 0 ? secret : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the per-installation origin secret, CREATING it on first use (local
 * mode / the brain's own box): 32 random bytes, lowercase hex, written 0600.
 * The env override still wins. Throws only if the file can neither be read nor
 * created — callers on best-effort paths should contain that.
 */
export function loadOrCreateOriginSecret(basePath?: string): string {
  const existing = loadOriginSecret(basePath);
  if (existing !== undefined) return existing;
  const path = originSecretPath(basePath);
  const secret = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode only applies at creation; re-assert for pre-existing
  // empty files so the secret is never group/world readable.
  chmodSync(path, 0o600);
  return secret;
}

/** Absolute path of the origin-secret file for a given (or default) base dir. */
export function originSecretPath(basePath?: string): string {
  return join(basePath ?? getTeamKbBasePath(), ORIGIN_SECRET_FILENAME);
}
