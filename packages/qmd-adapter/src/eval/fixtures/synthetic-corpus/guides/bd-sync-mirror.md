# bd-sync Three-Layer Mirror

bd-sync is the only tool that mirrors bead state outward: a bead, its GitHub
issue, and its Plane issue form a three-layer mirror where every record carries
the other two ids. Notes and closes flow through bd-sync so no layer silently
drifts.

Raw bd close is mirror-blind — the bead goes terminal but the linked GitHub
issue never hears about it. Every settle therefore uses bd-sync close, and a
periodic bd-sync status sweep surfaces any drift the mirror missed.
