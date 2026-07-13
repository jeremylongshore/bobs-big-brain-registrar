# Confused Deputy Problem

The confused deputy problem is a security anti-pattern where a privileged
service is tricked into misusing its own authority on behalf of a less
privileged caller. The deputy holds credentials for a downstream system and
performs an action the caller could not perform directly, so the caller
smuggles their intent through the trusted intermediary.

In a governed brain the risk shows up when a shared tool holds a broad token
and a request from one tenant causes it to touch another tenant's data. The
fix is to never let the intermediary act on ambient authority: scope every
downstream call to the identity of the original requester and refuse when the
requester's scope does not cover the target.
