import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonRecord;
export interface JsonRecord {
  [key: string]: JsonValue;
}
export const OKF_SPEC_REVISION = 'ad30107c31c06aec8a7d5636e0d1058118604e6f';
export const OKF_FIXTURE_LIMITS = Object.freeze({
  entries: 64,
  bundleBytes: 1048576,
  documentBytes: 262144,
  frontmatterBytes: 32768,
  nodes: 4096,
  depth: 16,
});

/** Error codes deliberately exclude foreign YAML snippets and parser diagnostics. */
export function invalid(code: string): never {
  throw new Error(`okf_fixture:${code}`);
}

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      invalid('unsafe_integer');
    return Number(value);
  }
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (value instanceof Map) {
    const result: JsonRecord = Object.create(null) as JsonRecord;
    for (const [key, item] of value) {
      if (typeof key !== 'string') invalid('non_string_key');
      result[key] = toJson(item);
    }
    return result;
  }
  return invalid('non_json_value');
}

function readYaml(source: string): JsonRecord {
  if (Buffer.byteLength(source) > OKF_FIXTURE_LIMITS.frontmatterBytes) invalid('frontmatter_limit');
  const doc = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    schema: 'core',
    resolveKnownTags: false,
    intAsBigInt: true,
  });
  if (doc.errors.length || doc.warnings.length) invalid('yaml');
  let nodes = 0;
  function check(node: unknown, depth: number): void {
    if (++nodes > OKF_FIXTURE_LIMITS.nodes || depth > OKF_FIXTURE_LIMITS.depth)
      invalid('yaml_complexity');
    if (isAlias(node)) invalid('yaml_alias');
    if (isMap(node) || isSeq(node) || isScalar(node)) {
      if (node.tag || node.anchor) invalid('yaml_tag_or_anchor');
    }
    if (isMap(node))
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') invalid('non_string_key');
        check(pair.key, depth + 1);
        check(pair.value, depth + 1);
      }
    if (isSeq(node)) for (const item of node.items) check(item, depth + 1);
  }
  check(doc.contents, 0);
  const value = toJson(doc.toJS({ mapAsMap: true, maxAliasCount: 0 }));
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid('frontmatter_mapping');
  return value;
}

export interface OkfDocument {
  frontmatter: JsonRecord;
  body: string;
  hasFrontmatter: boolean;
}
export function parseOkfDocument(text: string): OkfDocument {
  if (
    Buffer.byteLength(text) > OKF_FIXTURE_LIMITS.documentBytes ||
    text.includes('\0') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
  )
    invalid('document_encoding_or_limit');
  const open = /^(?:\uFEFF)?---\r?\n/.exec(text);
  if (!open)
    return { frontmatter: Object.create(null) as JsonRecord, body: text, hasFrontmatter: false };
  const tail = text.slice(open[0].length);
  const close = /^(?:---)(?:\r?\n|$)/m.exec(tail);
  if (!close) invalid('unterminated_frontmatter');
  return {
    frontmatter: readYaml(tail.slice(0, close.index)),
    body: tail.slice(close.index + close[0].length),
    hasFrontmatter: true,
  };
}

/** Normalizes YAML presentation only; JSON-compatible unknown fields are retained. */
export function serializeOkfDocument(doc: OkfDocument): string {
  const text = doc.hasFrontmatter ? `---\n${stringify(doc.frontmatter)}---\n${doc.body}` : doc.body;
  parseOkfDocument(text);
  return text;
}
