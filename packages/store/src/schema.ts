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
  source TEXT NOT NULL CHECK (source IN ('claude_session', 'manual', 'import', 'mcp')),
  content TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('decision', 'pattern', 'convention', 'architecture', 'troubleshooting', 'reference', 'onboarding')),
  trust_level TEXT NOT NULL CHECK (trust_level IN ('high', 'medium', 'low', 'untrusted')),
  sensitivity TEXT NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  author_json TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deprecated', 'superseded', 'archived')),
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
-- entry_hash / prev_entry_hash columns added via migration 5, and
-- hash_version via migration 6, so each migration runs against both fresh
-- and pre-existing databases. Adding them here would cause a 'duplicate
-- column' error when the migration replays on a fresh DB.
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
  {
    // Cross-clone determinism for the audit hash chain (bead
    // qmd-team-intent-kb-8da.6).
    //
    // The original (v1) canonical hash body included `timestamp`, which is
    // sourced from `new Date().toISOString()` at write time. Two clones
    // processing the same logical event at different instants minted
    // different timestamps, hence different entry_hash values, so the chain
    // was reproducible only within a single DB, not across clones.
    //
    // This migration adds a `hash_version` discriminant. Existing rows take
    // the DEFAULT 1 (still hashed WITH timestamp; their stored hashes are
    // unchanged and remain valid v1 tamper-evidence). New rows are inserted
    // with hash_version = 2, whose canonical body EXCLUDES timestamp, so the
    // entry_hash is a pure function of the logical event and reproducible on
    // every clone. The timestamp column is untouched: it is still stored,
    // just no longer fed into the v2 hash. Chain ordering is unaffected; it
    // rides on prev_entry_hash, which never depended on the timestamp value.
    //
    // v1 rows are NOT backfilled to v2: rehashing them would erase the very
    // tamper-evidence those v1 hashes provide. verifyAuditChain dispatches
    // per row on hash_version (NULL/absent => 1), so a DB with both v1 and
    // v2 rows verifies in a single pass. `ico audit verify` stays valid
    // before and after; pre-existing rows are byte-for-byte unchanged.
    version: 6,
    name: 'rehash_audit_chain_v2',
    sql: `
ALTER TABLE audit_events ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1;
    `.trim(),
  },
  {
    // Order the audit hash chain by a monotonic write-order key instead of
    // (timestamp, id) — bead qmd-team-intent-kb-yxp.
    //
    // `id` is a random UUID, so when two events share one timestamp (a
    // promotion that supersedes writes a `promoted` and a `superseded` event
    // in the same instant) the equal-timestamp tiebreak sorted by UUID,
    // flipping ~half the pairs relative to true insertion order. The
    // prev_entry_hash links were always built in insertion order (the
    // write-time prev lookup returned the sole same-timestamp predecessor
    // present at write time), so the verifier's (timestamp, id) read
    // disagreed with the stored links and reported PREV_LINK_MISMATCH on
    // every flipped pair — even though every entry_hash was intact (no
    // tampering, only a stale ordering contract).
    //
    // Fix: add an explicit monotonic `seq`, backfill existing rows by rowid
    // (which reflects insertion order for this append-only, delete-free
    // table), and order both the verifier walk and the write-time prev lookup
    // by seq. No row data is rewritten and no entry_hash changes — the
    // existing chain verifies clean immediately. An explicit column (rather
    // than relying on SQLite's rowid) keeps the ordering contract portable to
    // Dolt/Postgres, where rowid has no stable equivalent.
    version: 7,
    name: 'add_audit_seq_ordering',
    sql: `
ALTER TABLE audit_events ADD COLUMN seq INTEGER;
UPDATE audit_events SET seq = rowid WHERE seq IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_seq ON audit_events(seq);
    `.trim(),
  },
  {
    // Index the auto-govern inbox sweep's hot lookup (B1, bead
    // compile-then-govern-jfv.2.1). The nightly sweep calls
    // `CandidateRepository.findByStatus('inbox', tenantId)` — a filter on
    // (status, tenant_id) — to drain the remote-capture inbox. Purely additive:
    // no column change (the `candidates.status` column is already TEXT with a
    // DEFAULT of 'inbox'; the B1 enum widening is enforced in Zod, not by a DB
    // CHECK), just a compound index so the sweep does not table-scan `candidates`
    // as the inbox grows. `IF NOT EXISTS` keeps it replay-safe on fresh and
    // pre-existing databases alike.
    version: 8,
    name: 'add_candidates_status_tenant_index',
    sql: `
CREATE INDEX IF NOT EXISTS idx_candidates_status_tenant ON candidates(status, tenant_id);
    `.trim(),
  },
];
