/**
 * Schema-coverage regression guard for the disclosure choke point
 * (compile-then-govern-c5k.1).
 *
 * ## Why this test exists
 *
 * The original `assertDisclosureClean` used a HAND-MAINTAINED field subset
 * (`DisclosureScanInput`) instead of deriving the scanned set from the persisted
 * schema. So when `tenant_id` was added as a persisted free-text column it was
 * never enumerated and silently bypassed the gate — an adversarial probe landed an
 * SSN-shaped and a comp-shaped `tenant_id` in durable state.
 *
 * The structural fix (`collectFreeTextFields`) now scans every persisted string
 * surface automatically. This test is the GUARD that keeps it honest: it derives
 * the free-text leaf fields from the *actual* Zod schemas
 * (`MemoryCandidate` / `ContentMetadata` / `Author`) and FAILS if a new free-text
 * field is added to the persisted candidate shape without being reached by the
 * scanner. That makes this class of leak non-recurring: you cannot add a free-text
 * column and forget to scan it without turning this test red.
 *
 * The only escape hatch is the `ENUM_CONSTRAINED_FIELDS` allow-list (closed-vocab
 * fields that carry no attacker-controlled free text). Adding a field there is an
 * explicit, reviewable decision; the test asserts that list stays aligned with the
 * schema's actually-enum-typed fields.
 */
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { collectFreeTextFields, ENUM_CONSTRAINED_FIELDS } from '@qmd-team-intent-kb/common';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';

/**
 * The minimal structural view of a Zod schema node this guard needs. Zod v4
 * exposes the kind via the runtime constructor name and wrapper/array internals
 * via `_def`; this guard reads only those, so it does not couple to Zod's public
 * type surface.
 */
interface ZodLike {
  constructor: { name: string };
  _def?: { innerType?: ZodLike; element?: ZodLike };
}

/** Runtime kind of a Zod node (e.g. 'ZodString', 'ZodEnum', 'ZodObject'). */
function kindOf(schema: unknown): string {
  return (schema as ZodLike | undefined)?.constructor?.name ?? '';
}

/**
 * Unwrap Zod optional/default/nullable wrappers (`_def.innerType`) to the inner
 * leaf so we can classify it. Bounded — wrapper nesting here is at most a couple
 * deep.
 */
function unwrap(schema: unknown): unknown {
  let t = schema as ZodLike | undefined;
  for (let i = 0; i < 8 && t?._def?.innerType; i += 1) {
    t = t._def.innerType;
  }
  return t;
}

/**
 * Walk a Zod object schema and collect, by dotted key path, every leaf that can
 * carry attacker-controlled FREE TEXT (a string, or an array of strings) — i.e.
 * the surfaces that MUST be scanned. Enum / literal / boolean / number leaves are
 * closed-vocab or non-text and are NOT free-text. Recurses into nested objects.
 */
function freeTextLeafPaths(objSchema: z.ZodObject<z.ZodRawShape>, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, raw] of Object.entries(objSchema.shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const inner = unwrap(raw);
    const kind = kindOf(inner);

    if (kind === 'ZodString') {
      paths.push(path);
    } else if (kind === 'ZodArray') {
      const el = (inner as ZodLike)._def?.element;
      if (kindOf(el) === 'ZodString') paths.push(path);
    } else if (kind === 'ZodObject') {
      paths.push(...freeTextLeafPaths(inner as z.ZodObject<z.ZodRawShape>, path));
    }
    // ZodEnum / ZodLiteral / ZodBoolean / ZodNumber: closed-vocab or non-text — skip.
  }
  return paths;
}

describe('disclosure choke point — schema-coverage guard (c5k.1)', () => {
  it('derives the persisted free-text leaf set from the live MemoryCandidate schema', () => {
    const leaves = freeTextLeafPaths(MemoryCandidate as unknown as z.ZodObject<z.ZodRawShape>);
    // Sanity: the schema must expose the surfaces this guard protects, including
    // the one that leaked (tenantId) and the metadata / author free-text columns.
    expect(leaves).toContain('tenantId');
    expect(leaves).toContain('content');
    expect(leaves).toContain('title');
    expect(leaves).toContain('metadata.projectContext');
    expect(leaves).toContain('metadata.tags');
    expect(leaves).toContain('author.id');
    // The metadata enum fields must NOT be classified as free-text.
    expect(leaves).not.toContain('metadata.confidence');
    expect(leaves).not.toContain('metadata.sensitivity');
  });

  it('FAILS if any persisted free-text leaf is not reached by the scanner', () => {
    // Build a candidate whose every free-text leaf carries a UNIQUE sentinel
    // string, then assert the structural collector reaches every one. A new
    // free-text column added to the schema that the walk does not reach (e.g. a
    // future `region` or `note` field, or another `tenant_id`-class column) will
    // leave its sentinel uncollected and turn this test red.
    const leaves = freeTextLeafPaths(MemoryCandidate as unknown as z.ZodObject<z.ZodRawShape>);

    const sentinelFor = (path: string): string => `sentinel-${path.replace(/\./g, '-')}-zzz`;

    // Assemble a structurally-shaped candidate object (does NOT need to pass Zod —
    // we are testing the scanner's reach over the shape, not domain validity).
    const obj: Record<string, unknown> = {};
    for (const path of leaves) {
      const parts = path.split('.');
      const last = parts[parts.length - 1] as string;
      let cursor = obj;
      for (const p of parts.slice(0, -1)) {
        cursor[p] = (cursor[p] as Record<string, unknown>) ?? {};
        cursor = cursor[p] as Record<string, unknown>;
      }
      // Array-typed free-text leaves (tags, filePaths) get an array sentinel.
      const isArrayLeaf = last === 'tags' || last === 'filePaths';
      cursor[last] = isArrayLeaf ? [sentinelFor(path)] : sentinelFor(path);
    }

    const collected = new Set(collectFreeTextFields(obj));
    const missed = leaves.filter((p) => !collected.has(sentinelFor(p)));
    expect(missed, `unscanned persisted free-text leaves: ${missed.join(', ')}`).toEqual([]);
  });

  it('keeps ENUM_CONSTRAINED_FIELDS aligned with the schema enum/literal fields', () => {
    // Every name on the allow-list must correspond to an actually closed-vocab
    // field in the schema (enum / literal). If someone tries to silence the guard
    // by dumping a free-text field name onto the allow-list, this catches it: the
    // field would be string-typed in the schema, not enum/literal.
    const enumLikeNames = new Set<string>();
    const collectEnumNames = (objSchema: z.ZodObject<z.ZodRawShape>): void => {
      for (const [key, raw] of Object.entries(objSchema.shape)) {
        const inner = unwrap(raw);
        const kind = kindOf(inner);
        if (kind === 'ZodEnum' || kind === 'ZodLiteral') enumLikeNames.add(key);
        else if (kind === 'ZodObject') collectEnumNames(inner as z.ZodObject<z.ZodRawShape>);
      }
    };
    collectEnumNames(MemoryCandidate as unknown as z.ZodObject<z.ZodRawShape>);

    for (const allowed of ENUM_CONSTRAINED_FIELDS) {
      expect(
        enumLikeNames.has(allowed),
        `'${allowed}' is on ENUM_CONSTRAINED_FIELDS but is not an enum/literal in the schema`,
      ).toBe(true);
    }
  });
});
