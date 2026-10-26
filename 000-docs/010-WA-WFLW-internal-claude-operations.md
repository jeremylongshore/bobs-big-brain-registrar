# Internal Claude Operations

> Documents the internal Claude Code workflows, skills, and operational patterns used in this repository. These are conventions for how Claude Code sessions interact with the project — not user-facing features.

---

## /doc-filing

The `/doc-filing` operation governs how durable documentation is created and maintained in this repository.

### Where Docs Live

All durable documentation lives flat in `000-docs/` with numeric prefixes. There are no subdirectories.

### Naming Convention

```
NNN-descriptive-name.md
```

- `NNN` is a zero-padded 3-digit number (e.g., `001`, `012`, `099`)
- `descriptive-name` uses kebab-case
- Always `.md` extension

### Assigning the Next Number

Before creating a new document:

1. List existing files in `000-docs/`
2. Find the highest existing number
3. Use the next sequential number

Never reuse numbers, even if a document has been removed. Numbers are permanent identifiers.

### What Goes in 000-docs

| Category                    | Examples                                                   |
| --------------------------- | ---------------------------------------------------------- |
| Architecture docs           | System overview, component design, integration patterns    |
| Phase plans                 | Implementation roadmap, milestone definitions              |
| After Action Reviews (AARs) | Post-milestone retrospectives                              |
| Risk registers              | Active risks, mitigations, status tracking                 |
| Policy docs                 | Release policy, security policy, contribution guidelines   |
| Strategy docs               | Technical strategy, technology choices, trade-off analyses |
| Data model docs             | Domain model drafts, schema documentation                  |
| RFCs                        | Proposals for architectural changes                        |

### What Does NOT Go in 000-docs

| Category             | Where It Goes Instead                           |
| -------------------- | ----------------------------------------------- |
| Ephemeral task notes | Beads task descriptions                         |
| Meeting notes        | Local notes or external tool                    |
| Scratch work         | Local files, not committed                      |
| Generated API docs   | `docs/` directory (generated, not hand-written) |
| README files         | Project root or package root                    |

### Filing a New Document

1. Determine the category (architecture, phase plan, AAR, policy, etc.)
2. Assign the next available number
3. Write with a clear title as the first line (`# Title`)
4. Include a brief description/purpose statement after the title
5. Write durable content — this document should be useful months from now

### Updating Existing Documents

- Edit in place. Do not create a new document to "update" an existing one.
- If a document is superseded, add a deprecation notice at the top pointing to the replacement.
- Keep the old document for historical reference — do not delete.

---

## /beads

The `/beads` operation manages task tracking and provides post-compaction recovery for Claude Code sessions.

### Purpose

Beads (via the `bd` CLI) tracks work across Claude Code sessions. When context is compacted or a session ends, Beads provides the recovery path — the next session can run `/beads` to understand what was in progress, what was completed, and what comes next.

### Session Start

Always run `/beads` at the start of a Claude Code session. This loads:

- Current epic and task context
- In-progress tasks that need continuation
- Ready tasks that can be picked up
- Recent completions for context

### Core Workflow

```bash
# See what's ready to work on
bd ready

# Start working on a task
bd update <task-id> --status in_progress

# ... do the work ...

# Close the task with evidence of completion
bd close <task-id> --reason "description of what was done and evidence it works"

# Sync state
bd sync
```

### Epic Structure

The project is organized into 10 top-level epics covering the full implementation story. Each epic contains multiple tasks with tracked dependencies.

The epic structure is defined during project setup and evolves as the project progresses. See the Beads board for the current state.

### Task Naming

Use natural, readable language for task names:

- Good: "Define MemoryCandidate Zod schema with validation tests"
- Bad: "BZ-1.1 schema impl"

### Dependencies

Dependencies are tracked between epics and between tasks. Beads enforces that dependent tasks cannot start until their dependencies are resolved.

### Rules

1. **Never code without a task.** If there is no task for what you are doing, create one.
2. **Never finish without closing.** Every completed task must be closed with evidence.
3. **Always sync.** After closing tasks, run `bd sync` to persist state.
4. **Evidence is required.** The `--reason` on close must describe what was done and how you know it works (test output, PR number, verification steps).

---

## /release

The `/release` operation provides a guided release preparation workflow.

### Purpose

Ensures releases are prepared consistently, following the policies in [008-release-and-versioning-policy.md](./008-OD-RELS-release-versioning-policy.md).

### What It Does

When invoked, the `/release` skill walks through:

1. **Changelog validation**: Ensures `[Unreleased]` section has entries and they follow the format rules
2. **Version determination**: Based on the changes, suggests the correct semver bump
3. **Version update**: Updates `package.json` versions across the workspace
4. **Changelog migration**: Moves `[Unreleased]` entries to a versioned section with today's date
5. **Full validation**: Runs `pnpm validate` to ensure everything passes
6. **Release PR creation**: Creates a `release/vX.Y.Z` branch and opens a PR to main
7. **Post-merge tagging**: After the PR is merged, tags the commit and creates a GitHub release

### When to Use

- Before any release (standard or hotfix)
- Use this instead of manually performing release steps — the skill ensures nothing is missed

---

## /repo-sweep

The `/repo-sweep` operation performs general repository hygiene.

### Purpose

Keeps the repository clean by handling stale branches, pending PRs, and other maintenance tasks. Run before starting significant new work to ensure a clean starting state.

### What It Does

1. **Stale branch cleanup**: Identifies branches that have been merged or abandoned, and deletes them (with confirmation)
2. **PR triage**: Lists open PRs, checks for approved-but-unmerged PRs, identifies stale PRs
3. **Dependency check**: Flags outdated dependencies or security advisories
4. **General hygiene**: Checks for large uncommitted files, stale lockfiles, or other repo health issues

### When to Use

- Before starting a new epic or significant phase of work
- After completing a milestone
- When the branch list or PR list feels cluttered

---

## AAR (After Action Review)

After Action Reviews are produced after significant work milestones to capture lessons learned.

### Purpose

AARs provide honest retrospectives on what happened during a milestone. They are not celebrations or status reports — they are learning documents.

### When to Produce

- After completing a phase (as defined in [004-phase-plan.md](./004-PP-RMAP-phase-plan.md))
- After a significant incident or unexpected difficulty
- After completing a complex epic
- At any point where there are meaningful lessons to capture

### Structure

Every AAR follows this structure:

```markdown
# AAR — [Milestone Name]

## Context

What was the goal? What was the starting state?

## What Was Done

Factual summary of what was accomplished. Be specific.

## What Went Well

What worked? What should we keep doing?

## What Could Improve

What was harder than expected? What would we do differently?
Be honest. This section is the most valuable part of an AAR.

## Risks Identified

New risks discovered during this work. Reference 011-risk-register.md.

## Action Items

Specific, actionable next steps arising from this review.

## Next Steps

What comes next in the project plan?
```

### Filing

AARs are filed in `000-docs/` as the next numbered document:

```
012-initial-aar.md
017-aar-phase-1-schema.md
023-aar-mcp-integration.md
```

### Tone

- **Honest**, not self-congratulatory
- **Specific**, not vague ("the schema design took longer than expected because we underestimated the complexity of tenant isolation" vs. "some things were harder than expected")
- **Forward-looking** — every observation should connect to a lesson or action item
- **Blame-free** — focus on systems and processes, not individuals
