import { invalid, type JsonValue } from './codec.js';

export function validateEntryPath(path: string): void {
  if (
    path.length > 255 ||
    !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*\.md$/.test(path) ||
    path.split('/').length > 8
  )
    invalid('entry_path');
}

/** URI references are inert. Bundle-root slash and confined parent segments are legal. */
export function resolveFixtureReference(from: string, reference: string): string | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) return null;
  if (reference.startsWith('//')) invalid('reference_path');
  const target = reference.split(/[?#]/, 1)[0]!;
  if (!target) return from;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return invalid('reference_encoding');
  }
  if (/[\\\x00-\x20\x7f%]/.test(decoded)) invalid('reference_path');
  const parts = decoded.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) invalid('reference_escape');
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

export function fixtureReferences(frontmatter: Record<string, JsonValue>, body: string): string[] {
  const refs: string[] = [];
  for (const field of ['resource', 'computation'])
    if (typeof frontmatter[field] === 'string') refs.push(frontmatter[field]);
  for (const field of ['executor', 'attester']) {
    const value = frontmatter[field];
    if (
      value &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      typeof value.resource === 'string'
    )
      refs.push(value.resource);
  }
  // sources.resource may be a population descriptor, not a file reference.
  // Recognize only explicit URI/root/relative/Markdown-path spellings there.
  if (Array.isArray(frontmatter.sources))
    for (const value of frontmatter.sources) {
      if (
        value &&
        !Array.isArray(value) &&
        typeof value === 'object' &&
        typeof value.resource === 'string' &&
        /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|\.\.?\/)|\.md(?:[?#]|$)/.test(value.resource)
      )
        refs.push(value.resource);
    }
  // Deliberately a simple inline-link subset, not a Markdown parser or fetcher.
  for (const match of body.matchAll(/\]\(([^\s()]+)\)/g)) refs.push(match[1]!);
  return refs;
}
