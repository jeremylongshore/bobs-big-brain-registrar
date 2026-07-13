# Hash Chain Audit Log

The audit log is an append-only sequence of events where each entry embeds a
cryptographic hash of the previous entry. Because every record commits to the
one before it, editing or reordering any past event breaks the chain and the
tampering becomes detectable on the next verification pass.

This is the receipts wedge: the differentiator is not better recall, it is a
tamper-evident trail that anyone can re-verify after the fact. Note the trail
is tamper-evident, not tamper-proof — a writer with local access can rewrite an
event and re-hash forward, so cross-actor guarantees need an external anchor on
the chain head.
