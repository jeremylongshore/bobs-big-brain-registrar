import { join } from 'node:path';
import { parseContradictionReferences } from '@qmd-team-intent-kb/schema';
import type { SearchScope, ContradictionReferences } from '@qmd-team-intent-kb/schema';
import { getDefaultDenseConfig, QmdAdapter } from '@qmd-team-intent-kb/qmd-adapter';
import {
  createDatabase,
  MemoryRepository,
  readContradictionReferences,
  readCurrentSearchHits,
} from '@qmd-team-intent-kb/store';
import type { McpServerConfig } from '../config.js';

/** One raw qmd hit before it is mapped to the caller-facing shape. */
interface RawQmdHit {
  file: string;
  score: number;
  snippet: string;
  collection: string;
  contradictions?: ContradictionReferences;
}

/** Resolve content and standing from one read-only store snapshot. */
function readLocalHitMetadata(
  hits: RawQmdHit[],
  config: McpServerConfig,
  scope: SearchScope,
): RawQmdHit[] {
  if (hits.length === 0) return [];
  try {
    const db = createDatabase({ path: config.dbPath, readonly: true });
    try {
      const repo = new MemoryRepository(db);
      return db
        .transaction(() =>
          readCurrentSearchHits(repo, hits, {
            tenantId: config.tenantId,
            readerRole: config.role ?? 'member',
            scope,
          }).map((hit) => ({
            file: hit.file,
            score: hit.score,
            snippet: hit.snippet,
            collection: hit.collection,
            contradictions: readContradictionReferences(db, hit.memory.id, {
              tenantId: config.tenantId,
              readerRole: config.role ?? 'member',
            }),
          })),
        )
        .deferred();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** One cited hit returned to the MCP caller. */
export interface SearchHitOut {
  /** `qmd://<collection>/<file>` URI — the verifiable citation. */
  citation: string;
  snippet: string;
  score: number;
  collection?: string;
  contradictions?: ContradictionReferences;
}

/** Result of a `teamkb_search` call. */
export interface SearchToolResult {
  /** Which path served the answer — local qmd or the remote brain API. */
  source: 'qmd-local' | 'brain-api';
  query: string;
  scope: SearchScope;
  count: number;
  results: SearchHitOut[];
}

/** Input to `teamkb_search`. */
export interface SearchInput {
  query: string;
  scope?: SearchScope;
  limit?: number;
}

/**
 * A minimal qmd query port. The real `QmdAdapter` satisfies it; tests inject a
 * fake. Mirrors `QmdAdapter.query()`.
 */
export interface QmdQueryPort {
  query(
    queryText: string,
    scope?: SearchScope,
  ): Promise<
    | {
        ok: true;
        value: Array<{ file: string; score: number; snippet: string; collection: string }>;
      }
    | { ok: false; error: unknown }
  >;
}

/** Injectable seams (default to the real adapter / global fetch). */
export interface SearchDeps {
  makeAdapter?: (tenantId: string, exportDir: string) => QmdQueryPort;
  fetchFn?: typeof fetch;
}

/**
 * Search the governed corpus, returning `qmd://`-cited hits.
 *
 * Hosting flip (config, not a rewrite):
 *   - `config.apiUrl` SET  → proxy to the remote brain API over HTTP (team mode).
 *     The per-user `config.apiToken` rides in the Authorization header.
 *   - `config.apiUrl` UNSET → query qmd in-process against the local index
 *     (demo/local mode); no API server needed.
 *
 * Both paths degrade to an empty cited result rather than throwing, so a
 * missing index or unreachable brain reads as "nothing retrievable", not a
 * tool crash.
 */
export async function searchTool(
  input: SearchInput,
  config: McpServerConfig,
  deps: SearchDeps = {},
): Promise<SearchToolResult> {
  const scope: SearchScope = input.scope ?? 'curated';
  const limit = input.limit !== undefined && input.limit > 0 ? input.limit : 10;

  if (config.apiUrl !== undefined && config.apiUrl !== '') {
    return searchRemote(input.query, scope, limit, config, deps.fetchFn ?? fetch);
  }
  return searchLocal(
    input.query,
    scope,
    limit,
    config,
    deps.makeAdapter ?? ((tenantId, exportDir) => defaultAdapter(tenantId, exportDir, config)),
  );
}

function defaultAdapter(
  tenantId: string,
  exportDir: string,
  config: McpServerConfig,
): QmdQueryPort {
  return new QmdAdapter({
    tenantId,
    exportDir,
    basePath: config.basePath,
    qmdBinary: config.qmdBinary,
    qmdRuntime: config.qmdRuntime,
    dense: getDefaultDenseConfig(),
  });
}

/** Local mode: run qmd in-process and map results to cited hits. */
async function searchLocal(
  query: string,
  scope: SearchScope,
  limit: number,
  config: McpServerConfig,
  makeAdapter: (tenantId: string, exportDir: string) => QmdQueryPort,
): Promise<SearchToolResult> {
  const exportDir = config.exportDir ?? join(config.basePath, 'kb-export');
  const adapter = makeAdapter(config.tenantId, exportDir);
  const result = await adapter.query(query, scope);

  const hits = result.ok ? result.value : [];
  // Missing or unreadable authority never falls back to cached index content.
  const visible = readLocalHitMetadata(hits, config, scope);

  const results: SearchHitOut[] = visible.slice(0, limit).map((r) => ({
    citation: r.file,
    snippet: r.snippet,
    score: r.score,
    collection: r.collection,
    contradictions: r.contradictions,
  }));

  return { source: 'qmd-local', query, scope, count: results.length, results };
}

/** Remote mode: proxy to the brain API; the cited hits come back over HTTP. */
async function searchRemote(
  query: string,
  scope: SearchScope,
  limit: number,
  config: McpServerConfig,
  fetchFn: typeof fetch,
): Promise<SearchToolResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiToken !== undefined && config.apiToken !== '') {
    headers['authorization'] = `Bearer ${config.apiToken}`;
  }

  const url = `${config.apiUrl!.replace(/\/+$/, '')}/api/search`;
  let results: SearchHitOut[] = [];
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, scope, pagination: { page: 1, pageSize: limit } }),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        hits?: Array<{
          citation?: string;
          snippet?: string;
          score?: number;
          collection?: string;
          contradictions?: unknown;
        }>;
      };
      results = (body.hits ?? [])
        .filter((h) => typeof h.citation === 'string' && h.citation.length > 0)
        .map((h) => ({
          citation: h.citation as string,
          snippet: typeof h.snippet === 'string' ? h.snippet : '',
          score: typeof h.score === 'number' ? h.score : 0,
          collection: h.collection,
          ...(h.contradictions === undefined
            ? {}
            : { contradictions: parseContradictionReferences(h.contradictions) }),
        }));
    }
  } catch {
    // Unreachable brain → empty cited result, not a crash.
    results = [];
  }

  return { source: 'brain-api', query, scope, count: results.length, results };
}
