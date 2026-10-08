import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { computeContentHash } from '@qmd-team-intent-kb/common';

import { getExportableCollections } from '../collections/collection-registry.js';
import { DEFAULT_DENSE_MAX_DOC_CHARS } from '../dense/dense-indexer.js';

/**
 * What SHOULD be indexed, read from the git-exporter output tree (kb-export) —
 * the source of truth every derived index is rebuilt from. The index scrub
 * reconciles each index against this: a row whose document is not exported at
 * that path with that content is stale and goes.
 */
export interface ExportedDoc {
  /** `qmd://<collection>/<file>` — the citation id shared by native FTS5 and dense. */
  docId: string;
  collection: string;
  /** File name inside the collection directory, e.g. `<memory-uuid>.md`. */
  name: string;
  content: string;
  /** sha256 of the whole file — qmd's `documents.hash`. */
  qmdHash: string;
  /** sha256 of the leading `denseMaxDocChars` chars — the dense index's `content_hash`. */
  denseHash: string;
}

export interface ExportTruth {
  exportDir: string;
  /** False when the export tree is missing or holds no exportable file. */
  present: boolean;
  byDocId: Map<string, ExportedDoc>;
}

/** Key a qmd `documents` row by its collection + stored path. */
export function qmdKey(collection: string, path: string): string {
  return `${collection}\u0000${path}`;
}

/**
 * qmd stores each file under `handelize(relativePath)`. For the flat
 * `<uuid>.md` names the git-exporter writes, handelize is the identity, so the
 * stored path equals the file name. Names it would rewrite (spaces, dots,
 * leading dashes, nested paths) are not mapped; a row for one of them is
 * treated as stale and is re-added by the next `qmd update`. The identity rule
 * here mirrors qmd 2.5.3's `handelize` last-segment cleaning.
 */
export function isHandelizeIdentity(name: string): boolean {
  if (name.includes('/') || name.includes('___')) return false;
  const match = /^(.*)(\.[a-z0-9]+)$/i.exec(name);
  const stem = match === null ? name : match[1]!;
  const cleaned = stem.replace(/[^\p{L}\p{N}$]+/gu, '-').replace(/^-+|-+$/g, '');
  return cleaned === stem && stem.length > 0;
}

/**
 * Read every exportable collection's `*.md` files. Reads content (the scrub
 * compares bytes, not timestamps — an mtime proves nothing about what the
 * index holds).
 */
export function loadExportTruth(
  exportDir: string,
  denseMaxDocChars: number = DEFAULT_DENSE_MAX_DOC_CHARS,
): ExportTruth {
  const byDocId = new Map<string, ExportedDoc>();
  for (const def of getExportableCollections()) {
    const dir = join(exportDir, def.sourceSubdir);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      let content: string;
      try {
        content = readFileSync(join(dir, name), 'utf8');
      } catch {
        continue; // removed between readdir and read
      }
      byDocId.set(`qmd://${def.name}/${name}`, {
        docId: `qmd://${def.name}/${name}`,
        collection: def.name,
        name,
        content,
        qmdHash: computeContentHash(content),
        denseHash: computeContentHash(content.slice(0, denseMaxDocChars)),
      });
    }
  }
  return { exportDir, present: byDocId.size > 0, byDocId };
}

/** Index the truth by qmd's (collection, path) key — only names qmd stores verbatim. */
export function qmdTruthIndex(truth: ExportTruth): Map<string, ExportedDoc> {
  const map = new Map<string, ExportedDoc>();
  for (const doc of truth.byDocId.values()) {
    if (isHandelizeIdentity(doc.name)) map.set(qmdKey(doc.collection, doc.name), doc);
  }
  return map;
}

/** The memory id a `<uuid>.md` file name or `qmd://…/<uuid>.md` id refers to. */
export function memoryIdOfPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}
