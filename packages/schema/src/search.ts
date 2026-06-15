import { z } from 'zod';
import { MemoryCategory, SearchScope } from './enums.js';
import { IsoDatetime, NonEmptyString, TenantId, Uuid } from './common.js';

/** Pagination parameters */
export const Pagination = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof Pagination>;

/** A structured search request */
export const SearchQuery = z.object({
  query: NonEmptyString,
  scope: SearchScope,
  tenantId: TenantId.optional(),
  categories: z.array(MemoryCategory).optional(),
  dateFrom: IsoDatetime.optional(),
  dateTo: IsoDatetime.optional(),
  pagination: Pagination.default({ page: 1, pageSize: 20 }),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/** A single search result hit */
export const SearchHit = z.object({
  /**
   * UUID of the governed memory this hit resolves to. Present on the SQLite
   * metadata path; absent on the qmd retrieval path, where a hit is anchored
   * by its `citation` (qmd:// URI) rather than a store row.
   */
  memoryId: Uuid.optional(),
  title: NonEmptyString,
  snippet: z.string(),
  score: z.number().min(0).max(1),
  /** Governed memory category. Absent on qmd hits, which carry `collection`. */
  category: MemoryCategory.optional(),
  /**
   * The tamper-evident citation for this hit — a `qmd://<collection>/<file>`
   * URI emitted by qmd. This is the wedge: every retrieved answer is anchored
   * to a verifiable source, not just recalled. Present on the qmd path.
   */
  citation: z.string().optional(),
  /** qmd collection the hit came from (e.g. `kb-curated`). Present on the qmd path. */
  collection: z.string().optional(),
  highlightedContent: z.string().optional(),
  matchedAt: IsoDatetime,
});
export type SearchHit = z.infer<typeof SearchHit>;

/** Search response with results and pagination metadata */
export const SearchResult = z.object({
  hits: z.array(SearchHit),
  totalCount: z.number().int().min(0),
  query: NonEmptyString,
  scope: SearchScope,
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  hasMore: z.boolean(),
});
export type SearchResult = z.infer<typeof SearchResult>;
