import type { QmdSearchResult } from '../types.js';

/**
 * One entry of qmd 2.x's `search --json` output.
 *
 * Example:
 * ```json
 * { "docid": "#ba1275", "score": 0, "file": "qmd://kb-curated/transformers.md",
 *   "title": "Transformer attention mechanism", "snippet": "@@ -1,3 @@ ..." }
 * ```
 */
interface QmdJsonHit {
  docid?: string;
  score?: number;
  file?: string;
  title?: string;
  snippet?: string;
}

/**
 * Parse qmd's `search --json` / `query --json` output into typed results.
 *
 * qmd 2.x's default (non-JSON) output is a human-readable block that is not
 * machine-parseable; the adapter always passes `--json` and parses the array
 * here. Tolerant by design: empty input, non-array JSON, or a parse failure all
 * yield `[]` rather than throwing, so a malformed qmd response degrades to "no
 * results" instead of crashing the cycle.
 */
export function parseQueryOutput(stdout: string): QmdSearchResult[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const results: QmdSearchResult[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const hit = raw as QmdJsonHit;
    if (typeof hit.file !== 'string' || hit.file.length === 0) continue;
    const score = typeof hit.score === 'number' && !Number.isNaN(hit.score) ? hit.score : 0;
    results.push({
      file: hit.file,
      score,
      snippet: typeof hit.snippet === 'string' ? hit.snippet : '',
      collection: deriveCollectionFromPath(hit.file),
    });
  }
  return results;
}

/** Derive collection name from a file path (qmd:// URI or filesystem path) */
export function deriveCollectionFromPath(filePath: string): string {
  const knownCollections = [
    'kb-curated',
    'kb-decisions',
    'kb-guides',
    'kb-inbox',
    'kb-archive',
    'kb-bulk',
  ];
  for (const name of knownCollections) {
    if (filePath.includes(name)) return name;
  }
  return 'unknown';
}
