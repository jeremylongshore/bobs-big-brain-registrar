# Token Passthrough Prohibition

Token passthrough is the practice of accepting a bearer token that was issued
for a different audience and replaying it to an upstream service. It is
prohibited because it collapses the audience boundary: the receiving server can
no longer prove that the token was minted for itself.

A server must reject any credential that was not issued directly to it. Instead
of forwarding an inbound token, exchange it for a fresh, correctly scoped one or
refuse the call. Passthrough turns every intermediary into a universal key and
defeats per-audience revocation.
