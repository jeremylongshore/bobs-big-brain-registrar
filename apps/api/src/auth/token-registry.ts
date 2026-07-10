import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** What a token grants. `admin` may write/promote; `member` is read-only. */
export type TokenRole = 'admin' | 'member';

/** The identity a valid token resolves to. */
export interface TokenIdentity {
  /** Audit actor — the person/agent the token belongs to. */
  actor: string;
  role: TokenRole;
  /**
   * Tenant allowlist bound to this token. When present and non-empty, the token
   * may only read/write the listed tenants — the request-supplied `tenantId`
   * (body or query) must be a member, else the tenancy guard rejects with 403.
   *
   * Absent / empty = no tenant restriction (a cross-tenant admin token, or the
   * single-tenant team default where every token implicitly owns the one
   * tenant). The binding lives on the SERVER identity, never on the request —
   * a caller can never widen their own scope by changing the body.
   */
  tenants?: readonly string[];
}

/**
 * A token and the identity it grants.
 *
 * The on-disk `tokens.json` `token` field carries EITHER a plaintext bearer
 * secret (operator convenience — you write the secret you hand out) OR an
 * already-salted `scrypt$salt$hash` produced by {@link hashToken}. The
 * pre-hashed form is the at-rest default: it keeps **no plaintext bearer secret
 * on disk** (nor in any backup of `~/.teamkb`). Either way, at load the registry
 * ends up holding only a salted scrypt hash — a plaintext value is hashed and
 * discarded, a pre-hashed value is used verbatim — so the plaintext never lives
 * in process memory past construction and a heap dump cannot leak live tokens.
 * See {@link InMemoryTokenRegistry}.
 */
export interface TokenRecord extends TokenIdentity {
  token: string;
  /**
   * Optional hard expiry (ISO-8601, e.g. `2026-12-31T00:00:00Z`). After this
   * instant the token no longer resolves — a time-boxed credential that needs
   * no edit-file-and-restart to retire. A malformed value fails closed (the
   * record is dropped at load, never granting access).
   */
  expiresAt?: string;
}

/** Resolves bearer tokens to identities. */
export interface TokenRegistry {
  isEmpty(): boolean;
  /** Returns the identity for a token, or undefined if unknown/revoked/expired. */
  resolve(token: string): TokenIdentity | undefined;
  /**
   * Live revocation — cut a token off WITHOUT editing the file and restarting.
   * Returns true if a matching live record was revoked, false if no match.
   * Revocation is permanent for the life of the process (until the file is
   * re-read on next restart, where the operator should also drop the record).
   */
  revoke(token: string): boolean;
  /**
   * Durable-incident revocation by IDENTITY, not by secret. Marks EVERY live
   * record whose `identity.actor` matches as revoked, in-process and immediate.
   * Returns the number of records revoked.
   *
   * This is the revoke path that still works AFTER tokens are hashed at rest
   * (E1): an admin holds no plaintext bearer secret, so {@link revoke} by value
   * is impossible for the realistic "an actor's laptop was stolen" case.
   * Revoking by actor needs no secret — only the audit identity the token
   * already carries. Pair it with {@link appendRevokedActor} to make the
   * revocation survive a restart (the boot loader re-applies the list).
   */
  revokeByActor(actor: string): number;
}

/** Constant-time buffer compare (equal-length-safe). */
function timingSafeBufEq(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // Touch timingSafeEqual anyway so the length-mismatch branch costs the same.
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

/** scrypt cost — N=2^14 is OWASP-acceptable for short-lived bearer secrets. */
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;

/**
 * Derive a salted scrypt hash for a bearer secret. Format: `scrypt$<saltHex>$<hashHex>`.
 * A fresh random salt per token means two identical secrets hash differently and
 * the stored form is useless for an offline dictionary attack across records.
 */
export function hashToken(plaintext: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** A live, hashed credential. The plaintext is NOT retained. */
interface HashedRecord {
  /** scrypt salt (raw bytes). */
  readonly salt: Buffer;
  /** scrypt-derived hash (raw bytes) compared in constant time. */
  readonly hash: Buffer;
  readonly identity: TokenIdentity;
  /** Hard-expiry instant (ms epoch) or undefined for no expiry. */
  readonly expiresAtMs: number | undefined;
  /** Live-revoked this process. A revoked record never resolves again. */
  revoked: boolean;
}

function parseStoredHash(stored: string): { salt: Buffer; hash: Buffer } | undefined {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return undefined;
  try {
    const salt = Buffer.from(parts[1]!, 'hex');
    const hash = Buffer.from(parts[2]!, 'hex');
    if (salt.length === 0 || hash.length === 0) return undefined;
    return { salt, hash };
  } catch {
    return undefined;
  }
}

/**
 * In-memory per-user token registry — tokens are HASHED at rest.
 *
 * Each record's bearer secret is salted + scrypt-hashed at construction; the
 * plaintext is never retained. A request's bearer token is hashed under the
 * stored salt and compared (constant-time) against every live record so timing
 * does not leak which tokens exist. Per-user records give three things a single
 * shared key cannot: an audit `actor` per request, single-token revocation
 * (drop one record), and LIVE revocation via {@link revoke} (no restart).
 *
 * Resolve fails closed on: unknown token, expired token, live-revoked token.
 */
export class InMemoryTokenRegistry implements TokenRegistry {
  private readonly records: HashedRecord[];

  /**
   * @param records        Token records (the on-disk shape). Each `token` is
   *                        either a plaintext bearer secret or an already-salted
   *                        `scrypt$salt$hash`. The constructor keeps only a
   *                        salted hash and discards any plaintext immediately.
   * @param revokedActors  Actors from the durable revocation list. Any record
   *                        whose `actor` is listed starts life revoked, so a
   *                        revoked actor STAYS revoked across a restart (the
   *                        file is re-read every boot). Prefer the
   *                        {@link buildTokenRegistry} factory, which wires this
   *                        from the revocation file for you.
   */
  constructor(records: readonly TokenRecord[], revokedActors: readonly string[] = []) {
    this.records = records.map((rec) => {
      // A `token` may already be a salted `scrypt$salt$hash` (the at-rest form,
      // so no plaintext bearer secret sits on disk) — use it verbatim so the
      // stored salt verifies the presented plaintext. Otherwise treat it as a
      // plaintext secret and hash it now. `??` short-circuits, so a pre-hashed
      // record never pays a second scrypt. A plaintext value that merely looks
      // like `scrypt$...` (non-hex segments) fails parseStoredHash and falls
      // through to hashToken — fail-safe, never treated as a valid stored hash.
      const parsed = parseStoredHash(rec.token) ?? parseStoredHash(hashToken(rec.token));
      if (parsed === undefined) {
        throw new Error('internal: hashToken produced an unparseable hash');
      }
      const { salt, hash } = parsed;
      const identity: TokenIdentity =
        rec.tenants !== undefined && rec.tenants.length > 0
          ? { actor: rec.actor, role: rec.role, tenants: rec.tenants }
          : { actor: rec.actor, role: rec.role };
      const expiresAtMs = rec.expiresAt !== undefined ? Date.parse(rec.expiresAt) : undefined;
      return {
        salt,
        hash,
        identity,
        expiresAtMs:
          expiresAtMs !== undefined && !Number.isNaN(expiresAtMs) ? expiresAtMs : undefined,
        revoked: false,
      };
    });

    // Apply the durable, boot-time revocation list: any actor banned in the
    // persisted file starts revoked. Applied AFTER the records are built so it
    // also catches a token freshly issued to an already-banned actor — a ban is
    // on the identity, not on one specific secret.
    if (revokedActors.length > 0) {
      const banned = new Set(revokedActors);
      for (const rec of this.records) {
        if (banned.has(rec.identity.actor)) {
          rec.revoked = true;
        }
      }
    }
  }

  isEmpty(): boolean {
    return this.records.length === 0;
  }

  resolve(token: string): TokenIdentity | undefined {
    const now = Date.now();
    let found: TokenIdentity | undefined;
    for (const rec of this.records) {
      // Hash the presented secret under THIS record's salt, then constant-time
      // compare. Do not early-return on match — compare against all records so
      // the response time is independent of which (if any) token matched.
      const candidate = scryptSync(token, rec.salt, rec.hash.length);
      const matched = timingSafeBufEq(rec.hash, candidate);
      if (matched && !rec.revoked && (rec.expiresAtMs === undefined || rec.expiresAtMs > now)) {
        found = rec.identity;
      }
    }
    return found;
  }

  revoke(token: string): boolean {
    let revokedAny = false;
    for (const rec of this.records) {
      if (rec.revoked) continue;
      const candidate = scryptSync(token, rec.salt, rec.hash.length);
      if (timingSafeBufEq(rec.hash, candidate)) {
        rec.revoked = true;
        revokedAny = true;
      }
    }
    return revokedAny;
  }

  revokeByActor(actor: string): number {
    // Revoke by identity — no secret needed. This works after E1 hashed tokens
    // at rest (an admin has no plaintext to pass to revoke()) and cuts off ALL
    // of one actor's live tokens at once (e.g. a stolen laptop with a session).
    // Constant-time comparison is irrelevant here: `actor` is a public audit
    // identity, not a secret, so a plain string equals is correct.
    let count = 0;
    for (const rec of this.records) {
      if (rec.revoked) continue;
      if (rec.identity.actor === actor) {
        rec.revoked = true;
        count += 1;
      }
    }
    return count;
  }
}

/** Sources the registry can be built from (env / file / single key). */
export interface TokenSourceOptions {
  /** Back-compat single shared key → one admin token (actor "shared"). */
  apiKey?: string;
  /** Explicit records (highest precedence). */
  records?: TokenRecord[];
  /** JSON array string: [{ "token","actor","role","tenants"?,"expiresAt"? }]. */
  tokensJson?: string;
  /** Path to a JSON file of the same shape. */
  tokensFile?: string;
}

/**
 * Build the list of token records from the first available source:
 *   1. explicit `records`
 *   2. `tokensJson` (env TEAMKB_TOKENS)
 *   3. `tokensFile` (env TEAMKB_TOKENS_FILE / ~/.teamkb/tokens.json)
 *   4. `apiKey` → a single admin token (the legacy shared-key path)
 *   5. nothing → empty (dev mode, no auth)
 *
 * Malformed entries are skipped (a bad token file must not silently grant
 * access); an entry missing a role defaults to the least-privileged `member`.
 * An entry whose `expiresAt` is already in the past is dropped at load (an
 * expired credential should never be live, even momentarily).
 */
export function loadTokenRecords(opts: TokenSourceOptions): TokenRecord[] {
  if (opts.records && opts.records.length > 0) {
    return opts.records;
  }

  const raw = opts.tokensJson ?? readFileSafe(opts.tokensFile);
  if (raw !== undefined) {
    const parsed = parseRecords(raw);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  if (opts.apiKey !== undefined && opts.apiKey !== '') {
    return [{ token: opts.apiKey, actor: 'shared', role: 'admin' }];
  }

  return [];
}

function readFileSafe(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseRecords(raw: string): TokenRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const now = Date.now();
  const out: TokenRecord[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const token = rec['token'];
    const actor = rec['actor'];
    if (typeof token !== 'string' || token.length === 0) continue;
    if (typeof actor !== 'string' || actor.length === 0) continue;
    const role: TokenRole = rec['role'] === 'admin' ? 'admin' : 'member';
    const tenants = parseTenants(rec['tenants']);
    const expiresAt = parseExpiry(rec['expiresAt']);
    // Drop an already-expired record at load — fail closed, never grant briefly.
    if (expiresAt !== undefined) {
      const ms = Date.parse(expiresAt);
      if (Number.isNaN(ms) || ms <= now) continue;
    }
    const base: TokenRecord = { token, actor, role };
    if (tenants !== undefined) base.tenants = tenants;
    if (expiresAt !== undefined) base.expiresAt = expiresAt;
    out.push(base);
  }
  return out;
}

/**
 * Parse the optional `tenants` allowlist from a token record. Accepts an array
 * of non-empty strings; anything else (missing, wrong type, empty after
 * filtering) yields `undefined` = an unscoped (cross-tenant) token. Bad entries
 * are dropped rather than silently widening scope to "all".
 */
function parseTenants(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tenants = raw.filter((t): t is string => typeof t === 'string' && t.length > 0);
  return tenants.length > 0 ? tenants : undefined;
}

/**
 * Parse the optional `expiresAt` ISO-8601 instant. A non-string or
 * unparseable value yields `undefined` (no expiry — a permanent token). Note:
 * an unparseable expiry intentionally produces a NON-expiring token rather than
 * a never-valid one, but the load-time guard in {@link parseRecords} re-checks
 * `Date.parse` and drops a record whose expiry is malformed-or-past, so a typo'd
 * expiry never silently becomes a forever-token.
 */
function parseExpiry(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw;
}

// --- Durable revocation list (revoke-by-actor, survives restart) -----------
//
// A token record already supports `expiresAt` for time-boxed retirement (see
// TokenRecord / loadTokenRecords, both of which enforce it) — an operator caps
// a token's life by adding `"expiresAt": "2026-12-31T00:00:00Z"` to its record
// in tokens.json. That covers PLANNED retirement. The revocation list below
// covers UNPLANNED, immediate incident response by actor ("Tim's laptop was
// stolen") in a world where tokens are hashed at rest and no plaintext exists
// to revoke by value.

/**
 * One entry in the durable revocation list. Append-only: an entry is never
 * removed (un-revoking is re-issuing a fresh token, not editing this file), so
 * the file doubles as a small, human-readable revocation audit trail.
 */
export interface RevokedActorEntry {
  /** The audit actor whose tokens are cut off. */
  actor: string;
  /** When the revocation was recorded (ISO-8601). */
  revokedAt: string;
  /** Optional operator note ("laptop stolen", "left the team"). */
  reason?: string;
}

/**
 * Read the durable revocation list and return the DISTINCT set of revoked
 * actors. The file is a JSON array of {@link RevokedActorEntry}.
 *
 * Fail-open-safe: a missing file (the normal first-run case) yields `[]`
 * silently; a present-but-unparseable file yields `[]` but LOGS a warning. A
 * revocation file is a safety add-on, not the primary auth gate — a corrupt
 * file must never stop the brain from booting, but the operator should know it
 * was ignored (a silently-dropped ban list is a security footgun).
 */
export function loadRevokedActors(path: string | undefined): string[] {
  if (path === undefined || path === '') return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return []; // no file yet = nothing revoked
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('revocation file is not a JSON array');
    const actors = new Set<string>();
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const actor = (item as Record<string, unknown>)['actor'];
      if (typeof actor === 'string' && actor.length > 0) actors.add(actor);
    }
    return [...actors];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[teamkb-api] WARN: ignoring unparseable revocation file ${path}: ${msg}\n`,
    );
    return [];
  }
}

/**
 * Append one revocation to the durable list and return the entry written.
 *
 * Append-only semantics: the existing entries are read, the new one is pushed,
 * and the whole array is rewritten (so a concurrent reader always parses valid
 * JSON — never a torn half-write). A missing parent dir is created; a
 * missing-or-corrupt existing file is treated as an empty list so the append
 * still succeeds and heals a corrupt file forward without dropping the new
 * revocation. The file is written mode 0600 (it lists actor identities + free
 * -text reasons — no secrets, but no reason to be world-readable either).
 */
export function appendRevokedActor(
  path: string,
  actor: string,
  reason?: string,
): RevokedActorEntry {
  const entry: RevokedActorEntry = { actor, revokedAt: new Date().toISOString() };
  if (reason !== undefined && reason !== '') entry.reason = reason;

  let existing: RevokedActorEntry[] = [];
  const raw = readFileSafe(path);
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        existing = parsed.filter(
          (e): e is RevokedActorEntry =>
            !!e && typeof e === 'object' && typeof (e as { actor?: unknown }).actor === 'string',
        );
      }
    } catch {
      existing = []; // corrupt existing file → heal forward, don't lose this revoke
    }
  }
  existing.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  return entry;
}

/** Options for {@link buildTokenRegistry}: token sources + the revocation list. */
export interface RegistryBuildOptions extends TokenSourceOptions {
  /**
   * Path to the durable revocation list (env `TEAMKB_REVOKED_FILE`, default
   * `~/.teamkb/revoked-actors.json`). Actors listed here are revoked at boot.
   */
  revokedFile?: string;
}

/**
 * Build a registry from the token sources AND apply the durable revocation
 * list — the single construction path that guarantees a revoked actor stays
 * revoked across a restart. `buildApp` uses this instead of
 * `new InMemoryTokenRegistry(...)` directly so the boot-time file read is never
 * forgotten.
 */
export function buildTokenRegistry(opts: RegistryBuildOptions): InMemoryTokenRegistry {
  const records = loadTokenRecords(opts);
  const revoked = loadRevokedActors(opts.revokedFile);
  return new InMemoryTokenRegistry(records, revoked);
}
