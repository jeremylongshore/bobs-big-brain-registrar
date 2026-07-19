# Contributing to Bob's Big Brain Registrar

Thank you for your interest in contributing. This document covers the workflows, conventions, and expectations for contributing to this project.

## Branching Model

| Branch pattern | Purpose                                                      | Merges into |
| -------------- | ------------------------------------------------------------ | ----------- |
| `main`         | Stable, release-ready code. Protected.                       | --          |
| `feat/*`       | New features and capabilities.                               | `main`      |
| `fix/*`        | Bug fixes.                                                   | `main`      |
| `docs/*`       | Documentation-only changes.                                  | `main`      |
| `release/*`    | Release preparation (version bumps, changelog finalization). | `main`      |
| `refactor/*`   | Code restructuring without behavior changes.                 | `main`      |

**Rules:**

- Never commit directly to `main`.
- Feature branches should be short-lived. Merge or close within a week when possible.
- Delete branches after merge.

## Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Every commit message must follow the format:

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

### Required Types

| Type       | When to use                                            |
| ---------- | ------------------------------------------------------ |
| `feat`     | A new feature or capability                            |
| `fix`      | A bug fix                                              |
| `docs`     | Documentation-only changes                             |
| `chore`    | Maintenance tasks (dependency updates, config changes) |
| `refactor` | Code restructuring without changing behavior           |
| `test`     | Adding or modifying tests                              |
| `ci`       | CI/CD pipeline changes                                 |
| `security` | Security-related changes (patches, policy updates)     |

### Guidelines

- **Scope is encouraged** but not mandatory. Use the package or app name: `feat(policy-engine): add secret detection rule`.
- **Body is required for non-trivial changes.** If the diff is more than ~20 lines or changes behavior, explain why in the body.
- **Breaking changes** must include `BREAKING CHANGE:` in the footer or `!` after the type: `feat!: redesign memory candidate schema`.
- Keep the subject line under 72 characters.
- Use imperative mood: "add feature" not "added feature" or "adds feature".

## Pull Request Expectations

Every PR must include:

1. **Description.** What does this change do and why? Not just "fixes stuff."
2. **Link to Beads task.** Reference the task ID that this work addresses.
3. **Passing checks.** `pnpm validate` must pass (format, lint, typecheck, test).
4. **Changelog entry.** Add an entry to the `[Unreleased]` section of `CHANGELOG.md` under the appropriate category.
5. **Test coverage.** New logic requires tests. No exceptions.
6. **Documentation updates.** If you change architecture, behavior, or phase intent, update the relevant docs in `000-docs/`.

### PR Review Process

- At least **one approval** is required before merge.
- **Gemini code review** runs automatically on all PRs via GitHub Actions.
- Address all review comments before merging. Do not dismiss reviews without discussion.
- Squash merge is preferred for feature branches to keep `main` history clean.

## Testing

- All new logic must have corresponding tests.
- Tests run via Vitest: `pnpm test` at the repo root or within a specific package.
- Integration tests belong in `tests/` at the repo root.
- Unit tests belong in `__tests__/` or `*.test.ts` files alongside the code they test.
- Aim for meaningful coverage of behavior, not arbitrary line coverage targets.

## Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

### Categories

| Category       | When to use                        |
| -------------- | ---------------------------------- |
| **Added**      | New features, new capabilities     |
| **Changed**    | Changes to existing functionality  |
| **Fixed**      | Bug fixes                          |
| **Security**   | Security patches or policy changes |
| **Deprecated** | Features marked for future removal |
| **Removed**    | Features removed in this release   |

### Rules

- Every user-facing or developer-facing change gets a changelog entry.
- Write entries for humans, not machines. "Add secret detection to policy engine" not "misc cleanup."
- Entries go in the `[Unreleased]` section. Release prep moves them to a versioned section.
- Docs-only changes (`docs/*` branches) do not require changelog entries.

## Beads Task Tracking

This project uses [Beads](https://github.com/jeremylongshore/beads) (`bd`) for task tracking with post-compaction recovery.

**The rules are non-negotiable:**

1. **Never code without marking a task.** Run `bd update <id> --status in_progress` before starting work.
2. **Never finish without closing.** Run `bd close <id> --reason "evidence of completion"` with concrete evidence.
3. **Always sync.** Run `bd sync` after closing tasks to push state.

Use `bd ready` to see available tasks. Use `bd list --status in_progress` to see what you should be working on.

## After Action Reviews (AARs)

For significant work -- features spanning multiple packages, architectural changes, incident responses, or anything that took more than a day -- produce an After Action Review:

- What was planned vs. what happened
- What went well
- What could be improved
- Lessons to carry forward

AARs belong in `000-docs/` or the relevant task's closing notes.

## Handling Special Cases

### Architecture Changes

Architecture changes require an RFC document in `000-docs/` before implementation begins. The RFC should cover:

- Problem statement and motivation
- Proposed design with alternatives considered
- Impact on existing packages and data
- Migration plan if applicable

Get buy-in on the RFC before writing code.

### Documentation-Only Changes

- Use a `docs/*` branch.
- No changelog entry required.
- Still requires PR review.

### Release Preparation

- Use a `release/*` branch.
- Follow the release process documented in `000-docs/008-OD-RELS-release-versioning-policy.md`.
- Finalize changelog: move `[Unreleased]` entries to a versioned section.
- Bump version numbers in all package.json files.
- Tag the release after merge to `main`.

## Versioning Guidance

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

| Version bump                   | When                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Patch** (0.0.x)              | Bug fixes, documentation corrections, dependency patches. No behavior changes.                      |
| **Minor** (0.x.0)              | New features that are backward-compatible. New API endpoints, new policy rules, new config options. |
| **Major** (x.0.0)              | Breaking changes. Schema migrations, API contract changes, removed features.                        |
| **Prerelease** (x.y.z-alpha.N) | Risky or experimental changes that need validation before stable release.                           |

During pre-1.0 (0.x.y), the API is not considered stable. Minor versions may include breaking changes with appropriate changelog documentation.
