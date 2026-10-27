import { z } from 'zod';
import { NonEmptyString, Uuid } from './common.js';

/** Stored graph references visible to this reader, not semantic truth or audit receipts. */
export const ContradictionReferences = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      references: z
        .array(z.object({ memoryId: Uuid, title: NonEmptyString }).strict())
        .refine(
          (rows) => new Set(rows.map((row) => row.memoryId.toLowerCase())).size === rows.length,
          'Duplicate memory reference',
        ),
    })
    .strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
]);
export type ContradictionReferences = z.infer<typeof ContradictionReferences>;

/** Do not forward malformed remote evidence as a verified empty graph. */
export function parseContradictionReferences(value: unknown): ContradictionReferences {
  const result = ContradictionReferences.safeParse(value);
  return result.success ? result.data : { status: 'unavailable' };
}
