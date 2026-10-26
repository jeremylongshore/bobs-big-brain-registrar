import type { IngestResult } from './spool-intake.js';

/** Observations from one successful spool call, before caller caps or tenant/repo filtering.
 * Not an exhaustive input ledger: unreadable/malformed lines and existing IDs can be skipped.
 * Repeated refusals can be counted again while raw input remains in the source directory.
 */
export interface SpoolIntakeSummary {
  ingestedCandidates: number;
  disclosureRejectedCandidates: number;
  disclosureCategories: {
    pii: number;
    compensation: number;
    secret: number;
    other: number;
  };
  tamperedFiles: number;
  admissionRejectedFiles: number;
}

/** Fixed counters only; never copy IDs, paths, raw reasons or arbitrary category keys. */
export function summarizeSpoolIntake(result: IngestResult): SpoolIntakeSummary {
  const disclosureCategories = { pii: 0, compensation: 0, secret: 0, other: 0 };
  for (const { category } of result.rejected) {
    if (category === 'pii' || category === 'compensation' || category === 'secret') {
      disclosureCategories[category]++;
    } else {
      disclosureCategories.other++;
    }
  }
  return {
    ingestedCandidates: result.ingested.length,
    disclosureRejectedCandidates: result.rejected.length,
    disclosureCategories,
    tamperedFiles: result.tampered.length,
    admissionRejectedFiles: result.admissionRejected.length,
  };
}
