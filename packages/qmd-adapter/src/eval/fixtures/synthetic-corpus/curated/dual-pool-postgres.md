# Dual-Pool Postgres

Dual-pool Postgres runs two separate connection pools against one database: a
writer pool with read-write privileges and a reader pool restricted to
read-only. Code paths that must never mutate state — the audit verifier, the
search surface — are handed the reader pool.

Separating the pools makes an accidental write structurally impossible on the
verification path rather than merely discouraged by convention. The privilege
boundary lives in the connection, so a bug in read-only code cannot corrupt the
record it is supposed to be checking.
