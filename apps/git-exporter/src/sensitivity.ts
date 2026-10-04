import { Sensitivity } from '@qmd-team-intent-kb/schema';

/** Sensitivity threshold: memories at or above 'confidential' are never exported. */
const CONFIDENTIAL_INDEX = Sensitivity.options.indexOf('confidential');

/** True when a memory's sensitivity forbids writing it to the export tree. */
export function isSensitivityRestricted(level: string): boolean {
  const idx = Sensitivity.options.indexOf(level as (typeof Sensitivity.options)[number]);
  return idx >= CONFIDENTIAL_INDEX;
}
