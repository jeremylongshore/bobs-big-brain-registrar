# Team Mode Onboarding

In team mode every teammate reaches one shared brain over the private network
instead of each running their own local copy. A member's client proxies its
search to the remote governed brain and authenticates with a per-user bearer
token, so there is exactly one system of record rather than many divergent ones.

Onboarding a teammate means minting them a scoped token and pointing their
client at the shared endpoint. The member proposes reads and writes; the server
still disposes, applying the same governance rules centrally so a new joiner
cannot bypass policy from their own machine.
