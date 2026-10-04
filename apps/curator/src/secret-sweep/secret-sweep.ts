/**
 * Whole-brain secret sweep.
 *
 * The promote-time `secret_detection` rule only sees a memory once, with the
 * patterns that existed that day. A secret shape added later (or a memory
 * promoted while the rule was dormant) stays in the corpus unexamined. This
 * sweep re-runs the SAME deterministic scan (`scanTextForSecrets`, the function
 * the rule itself calls) over every curated memory of a tenant, in every
 * lifecycle state — an archived memory still sits in the store and its exports.
 *
 * Read-only by construction: one SELECT, no writes. Disclosure discipline: a
 * finding carries the memory id, title, lifecycle, category and pattern names —
 * never the matched text, and never the content. If the TITLE itself matched,
 * the title is withheld too.
 *
 * @module secret-sweep
 */

import { scanTextForSecrets } from '@qmd-team-intent-kb/policy-engine';
import type { createDatabase } from '@qmd-team-intent-kb/store';

/** Printed in place of a title that itself matched a secret pattern. */
export const WITHHELD_TITLE = '[title withheld — it matched a secret pattern]';

/** One memory with at least one secret-pattern hit. No matched text, ever. */
interface SecretSweepFinding {
  id: string;
  title: string;
  lifecycle: string;
  category: string;
  /** Stable pattern ids, sorted, deduped across title + content. */
  patternIds: string[];
  /** Human-readable pattern names, sorted, deduped across title + content. */
  patterns: string[];
}

export interface SecretSweepReport {
  tenantId: string;
  /** Memories examined (every lifecycle state). */
  scanned: number;
  /** Pattern-id filter applied, or null when every pattern was in scope. */
  patternFilter: string[] | null;
  findings: SecretSweepFinding[];
}

export interface SecretSweepOptions {
  /**
   * Restrict findings to these pattern ids. An encoded-wrapped hit
   * (`base64-wrapped:aws-key`) counts for its base id (`aws-key`).
   */
  patternIds?: readonly string[];
}

interface SweepRow {
  id: string;
  title: string;
  content: string;
  lifecycle: string;
  category: string;
}

/** `base64-wrapped:aws-key` → `aws-key`; a plain id is returned unchanged. */
function basePatternId(patternId: string): string {
  const separator = patternId.lastIndexOf(':');
  return separator === -1 ? patternId : patternId.slice(separator + 1);
}

/**
 * Sweep every curated memory of `tenantId` for secret patterns. Pure with
 * respect to the store: a single read, no writes.
 */
export function sweepSecrets(
  db: ReturnType<typeof createDatabase>,
  tenantId: string,
  options: SecretSweepOptions = {},
): SecretSweepReport {
  const filter =
    options.patternIds !== undefined && options.patternIds.length > 0
      ? new Set(options.patternIds)
      : null;

  const rows = db
    .prepare(
      `SELECT id, title, content, lifecycle, category
       FROM curated_memories
       WHERE tenant_id = ?
       ORDER BY id`,
    )
    .all(tenantId) as SweepRow[];

  const inScope = (text: string): Array<{ patternId: string; patternName: string }> =>
    scanTextForSecrets(text).filter(
      (finding) => filter === null || filter.has(basePatternId(finding.patternId)),
    );

  const findings: SecretSweepFinding[] = [];
  for (const row of rows) {
    const titleHits = inScope(row.title);
    const hits = [...titleHits, ...inScope(row.content)];
    if (hits.length === 0) continue;
    findings.push({
      id: row.id,
      title: titleHits.length > 0 ? WITHHELD_TITLE : row.title,
      lifecycle: row.lifecycle,
      category: row.category,
      patternIds: [...new Set(hits.map((hit) => hit.patternId))].sort(),
      patterns: [...new Set(hits.map((hit) => hit.patternName))].sort(),
    });
  }

  return {
    tenantId,
    scanned: rows.length,
    patternFilter: filter === null ? null : [...filter].sort(),
    findings,
  };
}
