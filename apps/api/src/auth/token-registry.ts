import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** What a token grants. `admin` may write/promote; `member` is read-only. */
export type TokenRole = 'admin' | 'member';

/** The identity a valid token resolves to. */
export interface TokenIdentity {
  /** Audit actor — the person/agent the token belongs to. */
  actor: string;
  role: TokenRole;
}

/** A token and the identity it grants. */
export interface TokenRecord extends TokenIdentity {
  token: string;
}

/** Resolves bearer tokens to identities. Revocation = drop the record. */
export interface TokenRegistry {
  isEmpty(): boolean;
  /** Returns the identity for a token, or undefined if unknown/revoked. */
  resolve(token: string): TokenIdentity | undefined;
}

/** Constant-time string compare (equal-length-safe). */
function timingSafeStrEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Touch timingSafeEqual anyway so the length-mismatch branch costs the same.
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * In-memory per-user token registry.
 *
 * Each request's bearer token is compared (constant-time) against every record
 * so timing does not leak which tokens exist. Per-user records give two things
 * a single shared key cannot: an audit `actor` per request, and single-token
 * revocation — drop one record and only that person is cut off.
 */
export class InMemoryTokenRegistry implements TokenRegistry {
  private readonly records: ReadonlyArray<TokenRecord>;

  constructor(records: readonly TokenRecord[]) {
    this.records = records;
  }

  isEmpty(): boolean {
    return this.records.length === 0;
  }

  resolve(token: string): TokenIdentity | undefined {
    let found: TokenIdentity | undefined;
    for (const rec of this.records) {
      // Do not early-return on match — compare against all records so the
      // response time is independent of which (if any) token matched.
      if (timingSafeStrEq(rec.token, token)) {
        found = { actor: rec.actor, role: rec.role };
      }
    }
    return found;
  }
}

/** Sources the registry can be built from (env / file / single key). */
export interface TokenSourceOptions {
  /** Back-compat single shared key → one admin token (actor "shared"). */
  apiKey?: string;
  /** Explicit records (highest precedence). */
  records?: TokenRecord[];
  /** JSON array string: [{ "token","actor","role" }]. */
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

  const out: TokenRecord[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const token = rec['token'];
    const actor = rec['actor'];
    if (typeof token !== 'string' || token.length === 0) continue;
    if (typeof actor !== 'string' || actor.length === 0) continue;
    const role: TokenRole = rec['role'] === 'admin' ? 'admin' : 'member';
    out.push({ token, actor, role });
  }
  return out;
}
