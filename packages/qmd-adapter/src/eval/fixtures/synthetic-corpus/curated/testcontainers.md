# Testcontainers-Based Testing

Testcontainers spins up real dependencies — a genuine database, a message
broker — inside disposable containers for the duration of a test run. Rather
than substituting a hand-written stand-in for the datastore, the suite talks to
the same engine that runs in production.

Using real containers instead of mocks catches integration bugs that a fake
would paper over: dialect quirks, constraint violations, and transaction
behavior. The container is created before the tests and torn down afterward, so
each run starts from a clean, reproducible state.
