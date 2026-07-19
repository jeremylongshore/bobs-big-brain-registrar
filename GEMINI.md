# Code Review Style Guide — Bob's Big Brain Registrar (formerly qmd-team-intent-kb)

## Project Context

Governed team memory platform for Claude Code powered by qmd. TypeScript monorepo with
deterministic governance pipeline and curated-only default search.

## Review Priorities

1. **Memory safety**: No secrets in memory candidates
2. **Search isolation**: Default search returns curated content only
3. **Tenant isolation**: Strict project/team memory scoping
4. **Deterministic governance**: Policy engine decides promotion, never LLM
5. **Schema contracts**: Zod schemas are source of truth
6. **Test coverage**: New code needs tests

## Patterns to Enforce

- Zod schemas for all data boundaries
- Adapter pattern for qmd integration
- Repository pattern for data access
- Tenant scoping on all queries
- Secret detection before memory promotion
- Conventional commits with epic/task references

## Anti-patterns to Flag

- Secrets in memory content
- Unscoped qmd queries
- LLM-based governance decisions
- Direct qmd CLI calls outside adapter
- `as any` in production code
- Broad exception catches
