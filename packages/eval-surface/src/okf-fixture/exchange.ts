import {
  computeContentHash,
  deriveCandidateId,
  isExportableAudience,
} from '@qmd-team-intent-kb/common';
import { CuratedMemory, IsoDatetime, MemoryCandidate, TenantId } from '@qmd-team-intent-kb/schema';
import {
  canonicalJson,
  invalid,
  OKF_FIXTURE_LIMITS,
  OKF_SPEC_REVISION,
  parseOkfDocument,
  serializeOkfDocument,
  type JsonRecord,
  type JsonValue,
  type OkfDocument,
} from './codec.js';
import { fixtureReferences, resolveFixtureReference, validateEntryPath } from './paths.js';

export interface FixtureEntry {
  path: string;
  text: string;
}
export interface FixtureConcept extends OkfDocument {
  path: string;
  diagnostics: string[];
  /** Informational claims only. These never become admission authority. */
  claimedVerification: 'unverified' | 'machine-confirmed' | 'human-reviewed';
  claimedFreshness: 'unspecified' | 'fresh' | 'stale' | 'invalid';
}
export interface FixtureBundle {
  concepts: FixtureConcept[];
  diagnostics: string[];
}
function record(value: JsonValue | undefined): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function instant(value: JsonValue | undefined): number | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  )
    return null;
  const parsed = Date.parse(value);
  const date = value.slice(0, 10);
  const day = Date.parse(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(day) ||
    new Date(day).toISOString().slice(0, 10) !== date ||
    value.slice(11, 13) === '24'
  )
    return null;
  return Number.isFinite(parsed) ? parsed : null;
}
function inspectComputation(fm: JsonRecord, body: string): string[] {
  const diagnostics: string[] = [];
  if (typeof fm.runtime !== 'string' || !fm.runtime.trim()) diagnostics.push('missing_runtime');
  if (!(typeof fm.computation === 'string' || /(?:^|\n)#+ Computation\s*\n[\s\S]*?```/.test(body)))
    diagnostics.push('computation_contract_not_validated');
  for (const field of ['executor', 'attester'])
    if (!record(fm[field]) || typeof fm[field].resource !== 'string')
      diagnostics.push(`incomplete_${field}`);
  if (!record(fm.executor) || typeof fm.executor.receipt !== 'string')
    diagnostics.push('missing_executor_receipt');
  if (
    fm.parameters !== undefined &&
    (!Array.isArray(fm.parameters) ||
      fm.parameters.some(
        (parameter) =>
          !record(parameter) ||
          typeof parameter.name !== 'string' ||
          typeof parameter.type !== 'string' ||
          typeof parameter.required !== 'boolean',
      ))
  )
    diagnostics.push('invalid_parameters');
  diagnostics.push('computation_semantics_not_validated');
  diagnostics.push('attestation_not_performed');
  return diagnostics;
}
function inspectClaims(
  fm: JsonRecord,
  body: string,
  now: number,
): Pick<FixtureConcept, 'diagnostics' | 'claimedVerification' | 'claimedFreshness'> {
  const diagnostics: string[] = [];
  if (
    fm.status !== undefined &&
    (typeof fm.status !== 'string' || !['draft', 'stable', 'deprecated'].includes(fm.status))
  )
    diagnostics.push('unsupported_status');
  const verified =
    fm.verified === undefined ? [] : Array.isArray(fm.verified) ? fm.verified : [fm.verified];
  const valid = verified.filter(
    (item) =>
      record(item) &&
      typeof item.by === 'string' &&
      /^(?:human:|process:|[^\s/]+\/).+/.test(item.by) &&
      instant(item.at) !== null,
  );
  if (valid.length !== verified.length) diagnostics.push('invalid_verified_claim');
  const human = valid.some(
    (item) => record(item) && typeof item.by === 'string' && item.by.startsWith('human:'),
  );
  const staleAt = instant(fm.stale_after);
  const claimedFreshness =
    fm.stale_after === undefined
      ? 'unspecified'
      : staleAt === null
        ? 'invalid'
        : now >= staleAt
          ? 'stale'
          : 'fresh';
  if (claimedFreshness === 'invalid') diagnostics.push('invalid_stale_after');
  if (
    fm.generated !== undefined &&
    (!record(fm.generated) ||
      typeof fm.generated.by !== 'string' ||
      instant(fm.generated.at) === null)
  )
    diagnostics.push('invalid_generated_claim');
  if (
    fm.sources !== undefined &&
    (!Array.isArray(fm.sources) ||
      fm.sources.some(
        (source) =>
          !record(source) || typeof source.resource !== 'string' || !source.resource.trim(),
      ))
  )
    diagnostics.push('invalid_sources');
  if (fm.type === 'Attested Computation') diagnostics.push(...inspectComputation(fm, body));
  return {
    diagnostics,
    claimedVerification: human
      ? 'human-reviewed'
      : valid.length
        ? 'machine-confirmed'
        : 'unverified',
    claimedFreshness,
  };
}

/** No filesystem, network, store, runtime execution, or provider access. */
export function parseOkfFixtureBundle(
  entries: readonly FixtureEntry[],
  now: string,
): FixtureBundle {
  IsoDatetime.parse(now);
  if (entries.length > OKF_FIXTURE_LIMITS.entries) invalid('entry_limit');
  let bytes = 0;
  const paths = new Set<string>();
  for (const entry of entries) {
    validateEntryPath(entry.path);
    if (paths.has(entry.path)) invalid('duplicate_path');
    paths.add(entry.path);
    bytes += Buffer.byteLength(entry.text);
    if (bytes > OKF_FIXTURE_LIMITS.bundleBytes) invalid('bundle_limit');
  }
  const concepts: FixtureConcept[] = [];
  const diagnostics: string[] = [];
  for (const entry of entries) {
    const doc = parseOkfDocument(entry.text);
    const name = entry.path.split('/').at(-1)!;
    if (name === 'index.md' || name === 'log.md') {
      const allowed =
        entry.path === 'index.md' &&
        Object.keys(doc.frontmatter).length === 1 &&
        doc.frontmatter.okf_version === '0.2';
      if (doc.hasFrontmatter && !allowed)
        diagnostics.push(`${entry.path}:noncanonical_reserved_frontmatter`);
      continue;
    }
    if (
      !doc.hasFrontmatter ||
      typeof doc.frontmatter.type !== 'string' ||
      !doc.frontmatter.type.trim()
    )
      invalid('required_type');
    const claims = inspectClaims(doc.frontmatter, doc.body, Date.parse(now));
    for (const ref of fixtureReferences(doc.frontmatter, doc.body)) {
      const target = resolveFixtureReference(entry.path, ref);
      if (target !== null && !paths.has(target)) claims.diagnostics.push('broken_bundle_link');
    }
    concepts.push({ ...doc, path: entry.path, ...claims });
  }
  return { concepts, diagnostics };
}

/** Caller selects a public synthetic record; this is not an export authorization service. */
export function exportGovernedOkfFixture(input: CuratedMemory, tenantId: string): FixtureEntry[] {
  const memory = CuratedMemory.parse(input);
  TenantId.parse(tenantId);
  if (
    memory.tenantId !== tenantId ||
    memory.sensitivity !== 'public' ||
    (memory.metadata.sensitivity !== undefined && memory.metadata.sensitivity !== 'public') ||
    !isExportableAudience(memory.metadata.audience)
  )
    invalid('export_scope');
  if (computeContentHash(memory.content) !== memory.contentHash) invalid('content_hash');
  const frontmatter: JsonRecord = {
    type: 'Governed Memory',
    title: memory.title,
    status: memory.lifecycle === 'active' ? 'stable' : 'deprecated',
    sources: [{ resource: `urn:bbb:memory:${memory.id}` }],
    bbb_fixture: JSON.parse(JSON.stringify(memory)) as JsonRecord,
  };
  // Promotion is not independent verification. No generated/verified/receipt invented.
  const entries = [
    {
      path: 'index.md',
      text: '---\nokf_version: "0.2"\n---\n# Synthetic exchange\n\n[Memory](concepts/memory.md)\n',
    },
    {
      path: 'log.md',
      text: `# Export log\n\n## ${memory.updatedAt.slice(0, 10)}\n\nSynthetic fixture export; no independent attestation.\n`,
    },
    {
      path: 'concepts/memory.md',
      text: serializeOkfDocument({ frontmatter, body: memory.content, hasFrontmatter: true }),
    },
  ];
  parseOkfFixtureBundle(entries, memory.updatedAt);
  return entries;
}

/** Returns proposals only. Caller must use normal persistence and governance gates. */
export function proposeOkfFixtureImport(
  entries: readonly FixtureEntry[],
  context: { tenantId: string; capturedAt: string },
): { bundle: FixtureBundle; candidates: MemoryCandidate[] } {
  const tenantId = TenantId.parse(context.tenantId);
  IsoDatetime.parse(context.capturedAt);
  const bundle = parseOkfFixtureBundle(entries, context.capturedAt);
  const candidates = bundle.concepts.map((concept) => {
    if (!concept.body.trim()) invalid('empty_body_unsupported');
    // Keep the exact foreign body in inert provenance; schema candidate content is trimmed.
    const content = concept.body.trim();
    const packet: JsonRecord = {
      specRevision: OKF_SPEC_REVISION,
      profile: 'bbb-okf-fixture-v1',
      path: concept.path,
      frontmatter: concept.frontmatter,
      body: concept.body,
      bodyHash: computeContentHash(concept.body),
    };
    const revision = computeContentHash(canonicalJson(packet));
    const sourcePath = `packets/${revision}/${concept.path}`;
    return MemoryCandidate.parse({
      schemaVersion: '1',
      id: deriveCandidateId(
        `okf-fixture:${computeContentHash(tenantId)}`,
        sourcePath,
        computeContentHash(content),
      ),
      status: 'inbox',
      source: 'import',
      content,
      title:
        typeof concept.frontmatter.title === 'string' && concept.frontmatter.title.trim()
          ? concept.frontmatter.title
          : concept.path,
      category: 'reference',
      trustLevel: 'untrusted',
      tenantId,
      author: { type: 'system', id: 'okf-fixture-import' },
      metadata: {
        filePaths: [sourcePath],
        tags: [],
        audience: 'owner',
        sensitivity: 'internal',
        projectContext: canonicalJson(packet),
      },
      prePolicyFlags: { potentialSecret: false, lowConfidence: true, duplicateSuspect: false },
      capturedAt: context.capturedAt,
    });
  });
  return { bundle, candidates };
}
