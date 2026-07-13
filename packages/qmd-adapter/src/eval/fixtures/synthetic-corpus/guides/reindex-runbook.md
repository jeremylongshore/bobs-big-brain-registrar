# Reindex Runbook

The search index is derived state: it can be rebuilt at any time from the
export tree and is never the source of truth. When search returns nothing on
known-good queries, the index is stale or was never registered, and the fix is
to rebuild it rather than to touch the underlying database.

Reindexing registers each collection against its exported directory and then
updates the index over the current files. The operation is idempotent — running
it twice with no change to the corpus is a harmless no-op — so it is safe to run
whenever the search surface looks degraded.
