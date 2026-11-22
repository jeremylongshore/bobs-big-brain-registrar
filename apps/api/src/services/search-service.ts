import { readCurrentSearchHits } from '@qmd-team-intent-kb/store';
import type { MemoryRepository, GraphReadScope } from '@qmd-team-intent-kb/store';
import { parseContradictionReferences } from '@qmd-team-intent-kb/schema';
import type { ContradictionReferences } from '@qmd-team-intent-kb/schema';
import type { SearchQuery, SearchResult, SearchHit, SearchScope } from '@qmd-team-intent-kb/schema';
import {
  rerankSearchHits,
  isSearchVisibleSensitivity,
  isAudienceVisibleToRole,
} from '@qmd-team-intent-kb/common';
import type { ReaderRole } from '@qmd-team-intent-kb/common';
import { badRequest } from '../errors.js';

/**
 * A single qmd retrieval hit. Structurally matches `QmdSearchResult` from
 * `@qmd-team-intent-kb/qmd-adapter` so the real adapter satisfies this port
 * without the service taking a hard dependency on the package (keeps the
 * service unit-testable with a fake).
 */
export interface QmdCiteHit {
  /** `qmd://<collection>/<file>` URI — the citation. */
  file: string;
  score: number;
  snippet: string;
  collection: string;
}

/**
 * Minimal query port over qmd. The concrete `QmdAdapter.query()` matches this
 * shape; the bootstrap injects it, unit tests inject a fake.
 *
 * `tenantId` carries the request's tenant scope through to qmd so the cited
 * path is isolated to the same tenant the SQLite fallback already filters by.
 * Before EPIC 0 this argument was dropped, leaking governed memories across
 * every tenant on the production qmd path (compile-then-govern-c5k).
 */
export interface QmdQueryPort {
  query(
    queryText: string,
    scope?: SearchScope,
    tenantId?: string,
  ): Promise<{ ok: true; value: QmdCiteHit[] } | { ok: false; error: unknown }>;
}

/**
 * Service layer for memory search.
 *
 * When a `QmdQueryPort` is wired (production bootstrap), search runs through
 * qmd so every hit carries a `qmd://` citation — the governed, verifiable
 * retrieval path. When no port is wired (unit/integration without qmd), it
 * falls back to SQLite text-match with freshness-aware reranking over the
 * curated memory store.
 */
export class SearchService {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly qmd?: QmdQueryPort,
    private readonly readContradictions?: (
      memoryId: string,
      scope: GraphReadScope,
    ) => ContradictionReferences,
  ) {}

  /**
   * Search curated memories by text query.
   *
   * qmd path: returns `qmd://`-cited hits, qmd relevance normalised to [0,1]
   * then reranked with the same exponential time decay + category boost as
   * the fallback (citations resolve to store rows for the metadata).
   * SQLite fallback: title match = 0.9, content-only = 0.6, then exponential
   * time decay + category boost.
   *
   * `readerRole` is the caller's read standing for claim-level audience (K2).
   * Both paths drop a memory whose audience the role is not cleared for. It
   * defaults to `member`, the least-privileged standing, so a caller that
   * forgets to pass it can only ever see tenant-wide memories.
   */
  async search(query: SearchQuery, readerRole: ReaderRole = 'member'): Promise<SearchResult> {
    if (query.query.trim().length === 0) {
      throw badRequest('Search query must not be empty');
    }

    const result =
      this.qmd !== undefined
        ? await this.searchViaQmd(query, readerRole)
        : this.searchViaSqlite(query, readerRole);
    if (!this.readContradictions) return result;
    return {
      ...result,
      hits: result.hits.map((hit) => {
        let contradictions: ContradictionReferences = { status: 'unavailable' };
        try {
          if (hit.memoryId)
            contradictions = parseContradictionReferences(
              this.readContradictions!(hit.memoryId, { tenantId: query.tenantId, readerRole }),
            );
        } catch {
          /* Keep retrieval usable without claiming a measured zero. */
        }
        return { ...hit, contradictions };
      }),
    };
  }

  /**
   * Cited retrieval over the governed corpus via qmd. Each hit's `citation`
   * is the `qmd://` URI qmd emits; the score is normalised to [0,1] against
   * the top hit so the contract holds while qmd's relevance ordering is
   * preserved.
   */
  private async searchViaQmd(query: SearchQuery, readerRole: ReaderRole): Promise<SearchResult> {
    const nowIso = new Date().toISOString();
    // Propagate the tenant scope so the cited path is isolated to the same
    // tenant the SQLite fallback filters by — closing the cross-tenant leak on
    // the production qmd path (EPIC 0, compile-then-govern-c5k).
    const result = await this.qmd!.query(query.query, query.scope, query.tenantId);

    if (!result.ok) {
      // qmd unavailable / failed — degrade to "no results" rather than 500.
      // The store remains the source of truth; an empty cited result is an
      // honest answer ("nothing retrievable") not a crash.
      return {
        hits: [],
        totalCount: 0,
        query: query.query,
        scope: query.scope,
        page: query.pagination.page,
        pageSize: query.pagination.pageSize,
        hasMore: false,
      };
    }

    const ranked = readCurrentSearchHits(this.memoryRepo, result.value, {
      tenantId: query.tenantId,
      readerRole,
      scope: query.scope,
    });
    const maxScore = ranked.reduce((m, h) => Math.max(m, h.score), 0);
    const normalised = ranked.map((hit, index) => ({
      ...hit,
      score: normaliseScore(hit.score, maxScore, index, ranked.length),
      category: hit.memory.category,
      updatedAt: hit.memory.updatedAt,
      title: hit.memory.title,
      lifecycle: hit.memory.lifecycle,
    }));
    const reranked = rerankSearchHits(normalised, nowIso, undefined, { query: query.query });
    const allHits: SearchHit[] = reranked.map((hit) => ({
      memoryId: hit.memory.id,
      title: hit.memory.title,
      snippet: hit.snippet,
      score: Math.min(hit.finalScore, 1),
      category: hit.memory.category,
      citation: hit.file,
      collection: hit.collection,
      matchedAt: nowIso,
    }));

    return paginate(allHits, query);
  }

  /** SQLite text-match fallback with freshness reranking. */
  private searchViaSqlite(query: SearchQuery, readerRole: ReaderRole): SearchResult {
    const allMemories = this.memoryRepo.searchByText(query.query, query.tenantId, query.categories);
    // Read-time sensitivity enforcement (5bm.11): the SQLite path returns rows
    // directly, so drop confidential/restricted here — the leak the audit found.
    // Bulk-digestion scoping (5bm.8): the qmd path excludes the kb-bulk
    // collection from the DEFAULT (curated) scope at the collection level; this
    // path has no collections, so mirror that contract on the row's source.
    // Only two scopes constrain bulk membership here: `curated` (the default)
    // excludes bulk; `bulk` returns ONLY bulk. Every other scope is left to its
    // own semantics and must NOT bulk-filter — notably `archived`, where a bulk
    // memory exports to kb-archive (lifecycle wins in getDirectory), so on the
    // qmd path an archived bulk hit IS returned under `archived`; excluding it
    // here would diverge. (Moot in practice — searchByText is active-only — but
    // kept correct so the two paths never disagree.)
    const bulkVisible = (m: { source: string }): boolean => {
      if (query.scope === 'curated') return m.source !== 'bulk_import';
      if (query.scope === 'bulk') return m.source === 'bulk_import';
      return true;
    };
    // Read-time audience enforcement (K2): this path reads store rows directly,
    // so it is the PRIMARY gate here — nothing upstream has filtered by audience.
    const memories = allMemories.filter(
      (m) =>
        isSearchVisibleSensitivity(m.sensitivity) &&
        isAudienceVisibleToRole(m.metadata.audience, readerRole) &&
        bulkVisible(m),
    );

    const nowIso = new Date().toISOString();
    const queryLower = query.query.toLowerCase();

    const rawHits = memories.map((memory) => {
      const titleMatch = memory.title.toLowerCase().includes(queryLower);
      const rawScore = titleMatch ? 0.9 : 0.6;
      return {
        memoryId: memory.id,
        title: memory.title,
        snippet: memory.content.slice(0, 200),
        score: rawScore,
        category: memory.category,
        updatedAt: memory.updatedAt,
        lifecycle: memory.lifecycle,
        matchedAt: nowIso,
      };
    });

    const reranked = rerankSearchHits(rawHits, nowIso, undefined, { query: query.query });

    const page = query.pagination.page;
    const pageSize = query.pagination.pageSize;
    const start = (page - 1) * pageSize;
    const paginatedHits = reranked.slice(start, start + pageSize);

    const hits: SearchHit[] = paginatedHits.map((hit) => ({
      memoryId: hit.memoryId,
      title: hit.title,
      snippet: hit.snippet,
      score: Math.min(hit.finalScore, 1),
      category: hit.category,
      matchedAt: hit.matchedAt,
    }));

    return {
      hits,
      totalCount: reranked.length,
      query: query.query,
      scope: query.scope,
      page,
      pageSize,
      hasMore: start + pageSize < reranked.length,
    };
  }
}

/** Paginate a fully-ranked hit list into a SearchResult. */
function paginate(allHits: SearchHit[], query: SearchQuery): SearchResult {
  const page = query.pagination.page;
  const pageSize = query.pagination.pageSize;
  const start = (page - 1) * pageSize;
  return {
    hits: allHits.slice(start, start + pageSize),
    totalCount: allHits.length,
    query: query.query,
    scope: query.scope,
    page,
    pageSize,
    hasMore: start + pageSize < allHits.length,
  };
}

/**
 * Normalise a qmd relevance score into the [0,1] contract.
 *
 * qmd BM25/embedding scores are unbounded and may all be 0 for exact hits, so
 * a raw clamp would collapse the ranking. When a positive top score exists we
 * scale against it (preserving relative magnitude); otherwise we fall back to a
 * rank-derived score so qmd's ordering still shows through.
 */
function normaliseScore(score: number, maxScore: number, index: number, total: number): number {
  if (maxScore > 0) {
    return Math.min(Math.max(score / maxScore, 0), 1);
  }
  return total > 0 ? (total - index) / total : 0;
}
