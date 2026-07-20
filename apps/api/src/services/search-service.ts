import type { MemoryRepository } from '@qmd-team-intent-kb/store';
import type { SearchQuery, SearchResult, SearchHit, SearchScope } from '@qmd-team-intent-kb/schema';
import {
  rerankSearchHits,
  rerankCitedHits,
  isSearchVisibleSensitivity,
} from '@qmd-team-intent-kb/common';
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
  ) {}

  /**
   * Search curated memories by text query.
   *
   * qmd path: returns `qmd://`-cited hits, qmd relevance normalised to [0,1]
   * then reranked with the same exponential time decay + category boost as
   * the fallback (citations resolve to store rows for the metadata).
   * SQLite fallback: title match = 0.9, content-only = 0.6, then exponential
   * time decay + category boost.
   */
  async search(query: SearchQuery): Promise<SearchResult> {
    if (query.query.trim().length === 0) {
      throw badRequest('Search query must not be empty');
    }

    if (this.qmd !== undefined) {
      return this.searchViaQmd(query);
    }
    return this.searchViaSqlite(query);
  }

  /**
   * Cited retrieval over the governed corpus via qmd. Each hit's `citation`
   * is the `qmd://` URI qmd emits; the score is normalised to [0,1] against
   * the top hit so the contract holds while qmd's relevance ordering is
   * preserved.
   */
  private async searchViaQmd(query: SearchQuery): Promise<SearchResult> {
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

    const ranked = result.value;
    const maxScore = ranked.reduce((m, h) => (h.score > m ? h.score : m), 0);

    // Normalise BEFORE the freshness rerank: qmd exact hits can all score 0,
    // where normaliseScore falls back to a rank-derived score — reranking the
    // raw zeros instead would multiply freshness into 0 and erase the ranking.
    const normalised = ranked.map((hit, index) => ({
      ...hit,
      score: normaliseScore(hit.score, maxScore, index, ranked.length),
    }));

    // Freshness + category rerank (same policy as the SQLite fallback, R1 of
    // the retrieval epic). Citations resolve back to store rows by id — the
    // exporter names files `{memoryId}.md` — purely for ranking metadata; the
    // qmd index itself is already tenant-scoped, and ids are globally unique.
    const reranked = rerankCitedHits(
      normalised,
      (memoryId) => {
        const memory = this.memoryRepo.findById(memoryId);
        return memory === null
          ? null
          : {
              category: memory.category,
              updatedAt: memory.updatedAt,
              sensitivity: memory.sensitivity,
            };
      },
      nowIso,
    );

    // Read-time sensitivity enforcement (5bm.11): drop confidential/restricted
    // hits so a sensitive memory is never returned to a search caller — the same
    // levels the exporter skips (5bm.3). The qmd index should already exclude
    // them; this is the defense-in-depth for a pre-skip index or a resolved row.
    const visible = reranked.filter((hit) => isSearchVisibleSensitivity(hit.sensitivity));

    const allHits: SearchHit[] = visible.map((hit) => ({
      memoryId: hit.memoryId ?? undefined,
      title: titleFromCitation(hit.file),
      snippet: hit.snippet,
      score: Math.min(hit.finalScore, 1),
      // Category came off a governed store row, so it is a valid MemoryCategory.
      category: hit.memoryId !== null ? (hit.category as SearchHit['category']) : undefined,
      citation: hit.file,
      collection: hit.collection,
      matchedAt: nowIso,
    }));

    return paginate(allHits, query);
  }

  /** SQLite text-match fallback with freshness reranking. */
  private searchViaSqlite(query: SearchQuery): SearchResult {
    const allMemories = this.memoryRepo.searchByText(query.query, query.tenantId, query.categories);
    // Read-time sensitivity enforcement (5bm.11): the SQLite path returns rows
    // directly, so drop confidential/restricted here — the leak the audit found.
    // Bulk-digestion scoping (5bm.8): the qmd path excludes the kb-bulk
    // collection from the default scope at the collection level; this path has
    // no collections, so mirror the contract on the row's source — bulk_import
    // rows only surface when the caller deliberately asks ('bulk' or 'all').
    const bulkVisible = (m: { source: string }): boolean => {
      if (query.scope === 'all') return true;
      if (query.scope === 'bulk') return m.source === 'bulk_import';
      return m.source !== 'bulk_import';
    };
    const memories = allMemories.filter(
      (m) => isSearchVisibleSensitivity(m.sensitivity) && bulkVisible(m),
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
        matchedAt: nowIso,
      };
    });

    const reranked = rerankSearchHits(rawHits, nowIso);

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
 * Derive a human-readable title from a `qmd://collection/path/to/file.md`
 * citation: take the basename, drop the extension, turn separators into
 * spaces. Falls back to the full citation so the title is never empty
 * (SearchHit.title is NonEmptyString).
 */
function titleFromCitation(citation: string): string {
  const lastSlash = citation.lastIndexOf('/');
  const base = lastSlash === -1 ? citation : citation.slice(lastSlash + 1);
  const stripped = base
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : citation;
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
