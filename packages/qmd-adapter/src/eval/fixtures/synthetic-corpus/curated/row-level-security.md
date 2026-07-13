# Row Level Security

Row level security enforces tenant isolation inside the database itself. A
policy attached to each table restricts which rows a session can read or write
based on the current tenant, so isolation does not depend on every query
remembering to add a filter.

This is defense in depth for multi-tenant storage: even if application code
forgets a scope clause, the engine still refuses to return another tenant's
rows. The policy is the last line, evaluated on every statement, and it cannot
be bypassed by a forgotten predicate in the application layer.
