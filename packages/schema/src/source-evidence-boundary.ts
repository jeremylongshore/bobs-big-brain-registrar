import { z } from 'zod';

/** Source assertions use a separate versioned governance envelope, never spool v1. */
export const SOURCE_EVIDENCE_UNSUPPORTED =
  'source_evidence_unsupported: use the source-governance v1 API after canonical candidate intake';
export const UnsupportedSourceEvidenceFields = {
  sourceEvidence: z.never().optional(),
  sourceAssertion: z.never().optional(),
  sourceClassification: z.never().optional(),
  assertion: z.never().optional(),
};
export function hasUnsupportedSourceEvidence(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.keys(UnsupportedSourceEvidenceFields).some((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  );
}
