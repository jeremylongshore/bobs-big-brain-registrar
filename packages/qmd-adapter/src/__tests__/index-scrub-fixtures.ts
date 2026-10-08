/**
 * Real-file fixtures for the index-scrub tests (bead 39z.19).
 *
 * The native FTS5 and dense sidecar files are built with the PRODUCTION
 * classes (`NativeIndexManager`, `DenseVecIndex`). The qmd BM25 cache is built
 * with the real pinned qmd binary where a test needs it (see
 * index-scrub-qmd-integration.test.ts); unit tests that must control the qmd
 * cache's rows exactly (orphans, schema drift, mass removal) write a SQLite
 * file with qmd 2.5.3's DDL, copied verbatim from a live index's `.schema`.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import Database from 'better-sqlite3';
import { computeContentHash } from '@qmd-team-intent-kb/common';

import { DenseVecIndex } from '../dense/dense-index.js';
import { DEFAULT_DENSE_MAX_DOC_CHARS } from '../dense/dense-indexer.js';
import { DENSE_SNIPPET_CHARS } from '../dense/dense-index.js';
import { NativeIndexManager } from '../native/native-index-manager.js';
import { listFilesUnder } from '../scrub/index-scrub.js';

/** Assembled from parts so no scanner treats this file as holding a credential. */
export const SECRET = 'zq' + 'Synth' + 'Ember' + '5Rt7Lp2Nw9Qx';
export const SURVIVOR_TERM = 'heliotrope';

export const MEMORY_A = '0a000000-0000-5000-8000-00000000000a';
export const MEMORY_B = '0b000000-0000-5000-8000-00000000000b';

export const LEAKED = `# Credential note\n\nThe vault passphrase is ${SECRET} until rotation.\n`;
export const REDACTED = '# Credential note\n\n[REDACTED] The passphrase was removed.\n';
export const SURVIVOR = `# Survivor\n\nThe ${SURVIVOR_TERM} convention stays searchable after a scrub.\n`;

/** qmd 2.5.3 index.sqlite DDL (from `.schema` on a live index). */
export const QMD_253_DDL = `
CREATE TABLE content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, path TEXT NOT NULL,
  title TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE, UNIQUE(collection, path));
CREATE TABLE llm_cache (hash TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE content_vectors (
  hash TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL, embedded_at TEXT NOT NULL, embed_fingerprint TEXT NOT NULL DEFAULT '',
  total_chunks INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (hash, seq));
CREATE VIRTUAL TABLE documents_fts USING fts5(filepath, title, body, tokenize='porter unicode61');
CREATE TRIGGER documents_ai AFTER INSERT ON documents WHEN new.active = 1 BEGIN
  INSERT INTO documents_fts(rowid, filepath, title, body)
  SELECT new.id, new.collection || '/' || new.path, new.title,
    (SELECT doc FROM content WHERE hash = new.hash) WHERE new.active = 1;
END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = old.id;
END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0;
  INSERT OR REPLACE INTO documents_fts(rowid, filepath, title, body)
  SELECT new.id, new.collection || '/' || new.path, new.title,
    (SELECT doc FROM content WHERE hash = new.hash) WHERE new.active = 1;
END;
`;

export function writeExport(exportDir: string, subdir: string, name: string, body: string): void {
  const dir = join(exportDir, subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, 'utf8');
}

export interface QmdFixtureDoc {
  collection: string;
  path: string;
  content: string;
  active?: boolean;
}

/** Write a qmd-2.5.3-shaped index.sqlite holding `docs`. Extra content rows become orphans. */
export function buildQmdFixture(
  path: string,
  docs: readonly QmdFixtureDoc[],
  orphanContent: readonly string[] = [],
  ddl: string = QMD_253_DDL,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(ddl);
    const now = '2026-10-04T00:00:00.000Z';
    const addContent = db.prepare('INSERT OR IGNORE INTO content VALUES (?, ?, ?)');
    for (const text of orphanContent) addContent.run(computeContentHash(text), text, now);
    const addDoc = db.prepare(
      'INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const doc of docs) {
      const hash = computeContentHash(doc.content);
      addContent.run(hash, doc.content, now);
      addDoc.run(doc.collection, doc.path, 'title', hash, now, now, doc.active === false ? 0 : 1);
    }
    db.prepare('INSERT INTO llm_cache VALUES (?, ?, ?)').run('k', 'cached', now);
  } finally {
    db.close();
  }
}

/** Build a native FTS5 index from the export tree with the production manager. */
export function buildNative(path: string, exportDir: string): void {
  const manager = new NativeIndexManager({ exportDir, indexPath: path, refreshTtlMs: 0 });
  try {
    manager.ensureFresh(Date.now());
  } finally {
    manager.close();
  }
}

/** A deterministic unit vector so the dense index can be built without the embedder. */
function fakeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(8).map((_, i) => Math.sin(seed + i) + 1.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** Build a dense sidecar for the given export docs, exactly as DenseIndexer.sync stores them. */
export function buildDense(
  path: string,
  docs: ReadonlyArray<{ collection: string; name: string; content: string }>,
): void {
  const index = new DenseVecIndex({ path, modelId: 'fixture-model', modelVersion: 'fixture-v1' });
  try {
    docs.forEach((doc, i) => {
      index.upsert({
        docId: `qmd://${doc.collection}/${doc.name}`,
        collection: doc.collection,
        contentHash: computeContentHash(doc.content.slice(0, DEFAULT_DENSE_MAX_DOC_CHARS)),
        snippet: doc.content.slice(0, DENSE_SNIPPET_CHARS),
        embedding: fakeEmbedding(i),
      });
    });
  } finally {
    index.close();
  }
}

/** Files under `dir` (relative) whose bytes contain `needle`. */
export function filesContaining(dir: string, needle: string): string[] {
  const bytes = Buffer.from(needle, 'utf8');
  return listFilesUnder(dir)
    .filter((file) => readFileSync(file).includes(bytes))
    .map((file) => relative(dir, file));
}

/** sha256 + mtime of every file under `dir`, keyed by relative path. */
export function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of listFilesUnder(dir)) {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    out[relative(dir, file)] = `${hash}@${statSync(file).mtimeMs}`;
  }
  return out;
}
