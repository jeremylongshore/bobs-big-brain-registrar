/**
 * dataset/v1 loader — turns each labeled {@link GovernCase} into a real,
 * Zod-valid `MemoryCandidate` by deep-merging its partial candidate over
 * {@link CASE_DEFAULTS} and parsing through the schema. This guarantees the
 * eval scores the SAME candidate shape the govern pipeline sees in production
 * (no ad-hoc objects), so a false-negative the eval measures is a real one.
 */

import { randomUUID } from 'node:crypto';

import { MemoryCandidate } from '@qmd-team-intent-kb/schema';

import type { GovernCase } from '../../types.js';
import { CASE_DEFAULTS, GOVERN_CASES } from './index.js';

/** A case paired with its parsed, schema-valid candidate. */
export interface LoadedCase {
  readonly def: GovernCase;
  readonly candidate: MemoryCandidate;
}

/**
 * Build the schema-valid candidate for one case. `metadata` is merged one level
 * deep (so a case that only sets `metadata.filePaths` keeps the default
 * `tags: []`), everything else is a shallow override. Each candidate gets a
 * fresh UUID so dedup/id logic never collides across cases.
 */
export function loadCase(def: GovernCase): LoadedCase {
  const overrides = def.candidate;
  const mergedMetadata = {
    ...CASE_DEFAULTS.metadata,
    ...(overrides.metadata ?? {}),
  };
  const candidate = MemoryCandidate.parse({
    ...CASE_DEFAULTS,
    ...overrides,
    id: randomUUID(),
    metadata: mergedMetadata,
  });
  return { def, candidate };
}

/** Load the whole v1 set. */
export function loadDataset(cases: readonly GovernCase[] = GOVERN_CASES): LoadedCase[] {
  return cases.map(loadCase);
}
