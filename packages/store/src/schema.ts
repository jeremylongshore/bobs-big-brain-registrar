/**
 * SQL DDL statements for the store package.
 * Each entry creates one table and its associated indexes idempotently.
 */

const CANDIDATES_DDL = `
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'inbox',
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'medium',
  author_json TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  pre_policy_flags_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_candidates_tenant ON candidates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_candidates_hash ON candidates(content_hash);
`.trim();

const CURATED_MEMORIES_DDL = `
CREATE TABLE IF NOT EXISTS curated_memories (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  author_json TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  lifecycle TEXT NOT NULL DEFAULT 'active',
  content_hash TEXT NOT NULL,
  policy_evaluations_json TEXT NOT NULL DEFAULT '[]',
  supersession_json TEXT,
  promoted_at TEXT NOT NULL,
  promoted_by_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_memories_tenant ON curated_memories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON curated_memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_lifecycle ON curated_memories(lifecycle);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON curated_memories(updated_at);
`.trim();

const GOVERNANCE_POLICIES_DDL = `
CREATE TABLE IF NOT EXISTS governance_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policies_tenant ON governance_policies(tenant_id);
`.trim();

const AUDIT_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  reason TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL
);
-- entry_hash / prev_entry_hash columns added via MIGRATIONS[5] so the
-- migration runs against both fresh and pre-existing databases. Adding
-- them here would cause a 'duplicate column' error when migration 5
-- replays on a fresh DB.
CREATE INDEX IF NOT EXISTS idx_audit_memory ON audit_events(memory_id);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);
`.trim();

const EXPORT_STATE_DDL = `
CREATE TABLE IF NOT EXISTS export_state (
  target_id TEXT PRIMARY KEY,
  last_exported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`.trim();

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`.trim();

/** All DDL statements, each including the CREATE TABLE and its indexes as one string. */
export const TABLE_DDL: string[] = [
  CANDIDATES_DDL,
  CURATED_MEMORIES_DDL,
  GOVERNANCE_POLICIES_DDL,
  AUDIT_EVENTS_DDL,
  EXPORT_STATE_DDL,
  SCHEMA_MIGRATIONS_DDL,
];

/**
 * Numbered migrations applied incrementally after initial schema creation.
 * Each migration runs exactly once, tracked by the schema_migrations table.
 *
 * IMPORTANT: Never modify existing migrations — only append new ones.
 */
interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'add_compound_indexes',
    sql: `
CREATE INDEX IF NOT EXISTS idx_memories_tenant_lifecycle ON curated_memories(tenant_id, lifecycle);
CREATE INDEX IF NOT EXISTS idx_memories_lifecycle_updated ON curated_memories(lifecycle, updated_at);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_memories_tenant_category ON curated_memories(tenant_id, category);
    `.trim(),
  },
  {
    version: 2,
    name: 'add_fts5_search',
    sql: `
CREATE VIRTUAL TABLE IF NOT EXISTS curated_memories_fts USING fts5(
  title,
  content,
  content='curated_memories',
  content_rowid='rowid'
);

-- Populate FTS from existing data
INSERT OR IGNORE INTO curated_memories_fts(rowid, title, content)
  SELECT rowid, title, content FROM curated_memories;

-- Triggers to keep FTS in sync with curated_memories
CREATE TRIGGER IF NOT EXISTS curated_memories_fts_insert
AFTER INSERT ON curated_memories BEGIN
  INSERT INTO curated_memories_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS curated_memories_fts_delete
AFTER DELETE ON curated_memories BEGIN
  INSERT INTO curated_memories_fts(curated_memories_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS curated_memories_fts_update
AFTER UPDATE ON curated_memories BEGIN
  INSERT INTO curated_memories_fts(curated_memories_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO curated_memories_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;
    `.trim(),
  },
  {
    version: 3,
    name: 'add_memory_links_and_import_batches',
    sql: `
CREATE TABLE IF NOT EXISTS memory_links (
  id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL REFERENCES curated_memories(id),
  target_memory_id TEXT NOT NULL REFERENCES curated_memories(id),
  link_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_by TEXT NOT NULL,
  source TEXT NOT NULL,
  import_batch_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_memory_id, target_memory_id, link_type)
);
CREATE INDEX IF NOT EXISTS idx_links_source ON memory_links(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON memory_links(target_memory_id);
CREATE INDEX IF NOT EXISTS idx_links_type ON memory_links(link_type);
CREATE INDEX IF NOT EXISTS idx_links_batch ON memory_links(import_batch_id);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_path TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rolled_back_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_batches_tenant ON import_batches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_batches_status ON import_batches(status);
    `.trim(),
  },
  {
    version: 4,
    name: 'add_import_batch_id_to_candidates',
    sql: `
ALTER TABLE candidates ADD COLUMN import_batch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_candidates_batch ON candidates(import_batch_id);
    `.trim(),
  },
  {
    // Adds a SHA-256 hash chain to audit_events so auditors can verify
    // integrity end-to-end (bead qmd-team-intent-kb-kmr / gvt).
    //
    // Each post-migration row carries:
    //   entry_hash       — sha256 of canonical JSON of the row fields
    //                       plus the previous row's entry_hash
    //   prev_entry_hash  — the entry_hash of the chronologically previous
    //                       row, NULL for the first hashed row
    //
    // Pre-migration rows retain both columns NULL — the verifier flags
    // these as `unverified` rather than `broken` because they predate
    // the hash-chain contract. Operators can backfill via a separate
    // tool if cryptographic continuity over pre-migration history is
    // required for compliance.
    version: 5,
    name: 'add_audit_hash_chain',
    sql: `
ALTER TABLE audit_events ADD COLUMN entry_hash TEXT;
ALTER TABLE audit_events ADD COLUMN prev_entry_hash TEXT;
    `.trim(),
  },
];
