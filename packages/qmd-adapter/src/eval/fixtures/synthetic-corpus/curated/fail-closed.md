# Fail-Closed Default

A fail-closed system denies an operation by default and only proceeds when a
request is explicitly permitted. When a check cannot run, when a token is
missing, or when a scope is ambiguous, the safe outcome is refusal rather than
a silent allow.

The governed brain applies this at every boundary: an unscoped search returns
nothing instead of leaking a tenant's index, and a governance rule that errors
is treated as a block, never as a pass. Failing open would trade a visible
error for an invisible breach, so the default posture is always to stop.
