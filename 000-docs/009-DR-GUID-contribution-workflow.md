# Contribution Workflow

> Step-by-step guide for contributing to qmd-team-intent-kb. Covers the full lifecycle from picking up a task through submitting a PR, merging, and cleanup.

---

## Starting Work

### 1. Find or Create a Task

- Check open issues on GitHub and the Beads board (`bd ready`)
- Look at the current phase in [004-phase-plan.md](./004-PP-RMAP-phase-plan.md) for prioritized work
- If no existing task covers what you want to do, create one in Beads

### 2. Claim the Task

Mark the task as in progress so others know it is being worked on:

```bash
bd update <task-id> --status in_progress
```

### 3. Create a Feature Branch

Branch from the appropriate base:

```bash
# For features and enhancements
git checkout -b feat/descriptive-name develop

# For bug fixes
git checkout -b fix/descriptive-name develop

# For documentation
git checkout -b docs/descriptive-name develop

# For hotfixes (branch from main)
git checkout -b fix/critical-issue main
```

**Branch naming conventions**:

| Prefix      | Use For                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `feat/`     | New features, new capabilities                                                                               |
| `fix/`      | Bug fixes                                                                                                    |
| `docs/`     | Documentation-only changes                                                                                   |
| `refactor/` | Code restructuring without behavior change                                                                   |
| `test/`     | Test additions or improvements                                                                               |
| `chore/`    | Build, CI, dependency updates                                                                                |
| `release/`  | Release preparation (see [008-release-and-versioning-policy.md](./008-OD-RELS-release-versioning-policy.md)) |

---

## During Development

### Write Code, Tests, and Docs Together

Do not treat tests and documentation as afterthoughts. A feature is not done until:

- The code works
- Tests verify it works
- Documentation explains how it works

### Follow Conventional Commits

Every commit message follows the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Types**: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `perf`, `style`

**Scopes**: Package or app name (`schema`, `curator`, `qmd-adapter`, `mcp-server`, `cli`, `docs`)

**Examples**:

```
feat(schema): add MemoryCandidate Zod schema with validation
fix(curator): resolve false positive in dedup content hash comparison
docs: update architecture overview with MCP integration details
test(qmd-adapter): add integration tests for search query building
chore(ci): add Gemini code review to PR workflow
```

### Keep Commits Focused and Atomic

Each commit should represent one logical change. If you find yourself writing "and" in a commit message, consider splitting it into two commits.

**Good**:

- `feat(schema): add CuratedMemory Zod schema`
- `test(schema): add validation tests for CuratedMemory`

**Bad**:

- `feat(schema): add CuratedMemory schema and fix linting and update docs`

### Validate Before Pushing

Run the full validation suite before pushing:

```bash
pnpm validate
```

This runs, in order:

1. `pnpm lint` — ESLint across all packages
2. `pnpm format:check` — Prettier formatting verification
3. `pnpm typecheck` — TypeScript compilation check
4. `pnpm test` — Vitest test suite

All four must pass. Do not push code that fails validation.

---

## Submitting a Pull Request

### 1. Push Your Branch

```bash
git push -u origin feat/descriptive-name
```

### 2. Open a PR

Open a pull request against `develop` (or `main` for hotfixes).

Use the PR template. Every PR must include:

- **Summary**: What this PR does and why (1-3 bullet points)
- **Test plan**: How to verify the changes work
- **Changelog entry**: If user-facing, what was added to `CHANGELOG.md`

### 3. Add a Changelog Entry

If the PR includes user-facing changes, add an entry to the `[Unreleased]` section of `CHANGELOG.md`. See [008-release-and-versioning-policy.md](./008-OD-RELS-release-versioning-policy.md) for format and rules.

Changes that do NOT need a changelog entry:

- Internal refactoring with no behavior change
- Test-only changes
- Documentation-only changes (unless they document a new feature)
- CI/build configuration changes

### 4. Ensure CI Passes

The CI pipeline runs automatically on every PR. All checks must pass:

| Check         | What It Validates                              |
| ------------- | ---------------------------------------------- |
| Lint          | No ESLint errors or warnings                   |
| Format        | All files match Prettier formatting            |
| Typecheck     | No TypeScript compilation errors               |
| Test          | All Vitest tests pass                          |
| Gemini Review | Automated code review (advisory, not blocking) |

If CI fails, fix the issue and push again. Do not ask reviewers to look at a failing PR.

### 5. Request Review

- Assign at least one reviewer
- Add relevant labels (e.g., `schema`, `governance`, `mcp`, `docs`)
- If the PR is large (>400 lines changed), consider splitting it or adding a detailed walkthrough in the description

---

## Code Review Standards

### For Authors

- Respond to all review comments, even if just to acknowledge
- Do not dismiss comments without discussion
- Push fixes as new commits during review (do not force-push during review)
- If a review comment leads to a larger discussion, open an issue for follow-up rather than blocking the PR

### For Reviewers

- Review within 24 hours of being assigned (or reassign if you cannot)
- Be specific in feedback — point to the line, explain the concern, suggest an alternative
- Distinguish between blocking issues ("this must change") and suggestions ("consider this approach")
- Approve when you are confident the change is correct and complete

---

## After Merge

### 1. Close the Beads Task

Close the task with evidence of completion:

```bash
bd close <task-id> --reason "merged in PR #N"
```

### 2. Sync Beads

Push the task state update:

```bash
bd sync
```

### 3. Delete the Feature Branch

GitHub can auto-delete branches after merge. If not configured, clean up manually:

```bash
git branch -d feat/descriptive-name
git push origin --delete feat/descriptive-name
```

---

## Architecture Changes

Changes that affect the system architecture require an RFC (Request for Comments) before implementation.

### What Qualifies as an Architecture Change

- New packages or apps in the monorepo
- Changes to the domain model (new entities, field changes)
- Changes to the governance pipeline flow
- New external dependencies or integrations
- Changes to the tenant isolation model
- Changes to the MCP protocol usage

### RFC Process

1. **Write an RFC document** in `000-docs/` using the next available number
   - Title: `NNN-rfc-descriptive-name.md`
   - Include: Problem statement, proposed solution, alternatives considered, migration plan (if applicable)
2. **Open a PR with just the RFC** for discussion
   - Label with `rfc`
   - Allow at least 48 hours for feedback
3. **After approval**, implement in separate PR(s)
   - Reference the RFC document in implementation PRs
4. **Update related docs** after implementation:
   - [002-architecture-overview.md](./002-AT-ARCH-architecture-overview.md)
   - [004-phase-plan.md](./004-PP-RMAP-phase-plan.md)
   - [007-data-model-draft.md](./007-AT-DSGN-data-model-draft.md) (if schema changes)

---

## Documentation-Only Changes

For changes that only affect documentation:

- Use a `docs/*` branch
- No changelog entry needed
- Still requires review (documentation errors can be just as harmful as code bugs)
- PR description should explain what was incorrect or missing

---

## Release Preparation

When it is time to ship a release:

1. Review [008-release-and-versioning-policy.md](./008-OD-RELS-release-versioning-policy.md) for the full process
2. Create a `release/*` branch
3. Use the `/release` skill for guided execution
4. Follow the release checklist in the policy document

---

## Quick Reference

```
# Start work
bd update <id> --status in_progress
git checkout -b feat/descriptive-name develop

# Develop
# ... write code, tests, docs ...
pnpm validate

# Submit
git push -u origin feat/descriptive-name
# Open PR on GitHub

# After merge
bd close <id> --reason "merged in PR #N"
bd sync
git branch -d feat/descriptive-name
```
