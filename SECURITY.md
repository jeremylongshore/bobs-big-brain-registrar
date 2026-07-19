# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Bob's Big Brain Registrar (formerly qmd-team-intent-kb), please report it responsibly:

- **Email:** [security@jeremylongshore.com](mailto:security@jeremylongshore.com)
- **GitHub Security Advisory:** Open a [private security advisory](https://github.com/jeremylongshore/bobs-big-brain-registrar/security/advisories/new) on this repository.

Do not open a public issue for security vulnerabilities.

### Response Timeline

| Action                                 | Timeline                 |
| -------------------------------------- | ------------------------ |
| Acknowledge receipt                    | Within 48 hours          |
| Initial triage and severity assessment | Within 1 week            |
| Patch development (critical/high)      | Within 2 weeks of triage |
| Patch development (medium/low)         | Within 30 days of triage |
| Public disclosure                      | After patch is released  |

## Supported Versions

| Version                 | Supported |
| ----------------------- | --------- |
| Latest minor (0.x.y)    | Yes       |
| Previous minor releases | No        |

Only the latest minor release receives security patches. Upgrade to stay protected.

## Project-Specific Threat Model

Bob's Big Brain Registrar operates at the intersection of AI-generated content, team knowledge, and local development environments. This creates a unique threat surface that generic security guidance does not cover.

### 1. Secret Leakage into Memory Candidates

**Threat:** Claude Code sessions frequently involve API keys, tokens, database credentials, and other secrets. Memory capture can inadvertently promote secrets into the knowledge base.

**Mitigation:** The `packages/policy-engine` must implement secret detection as a mandatory pre-promotion filter. Memory candidates containing patterns matching known secret formats (API keys, tokens, connection strings, private keys) must be rejected before reaching curated status. This is a hard gate, not a warning.

### 2. Untrusted MCP Server Risk

**Threat:** MCP (Model Context Protocol) servers can inject arbitrary content into Claude Code sessions. A malicious or compromised MCP server could inject crafted content designed to be captured as memory, poisoning the team knowledge base.

**Mitigation:** Memory originating from MCP server interactions must be tagged with its source and treated as untrusted by default. The policy engine must apply stricter validation to MCP-sourced candidates. MCP provenance must be preserved in memory metadata for audit purposes.

### 3. Prompt and Hook Over-Trust

**Threat:** Claude Code hooks (pre/post session hooks) could be configured to auto-approve memory promotion, bypassing governance. An overly permissive hook configuration could allow unvetted content to reach curated status.

**Mitigation:** Memory promotion must always flow through the deterministic policy engine. Hooks may propose candidates but must never have authority to promote directly. The architecture enforces this by requiring all promotions to pass through `apps/curator`.

### 4. Archive and Inbox Leakage into Default Retrieval

**Threat:** Raw, unvetted candidates in the inbox or retired memories in the archive could appear in default search results, presenting unverified or outdated information as team knowledge.

**Mitigation:** This is an architectural invariant. Default search in `packages/qmd-adapter` must scope queries exclusively to curated-status memories. Inbox and archive content requires explicit, intentional access through separate query parameters. This must be enforced at the adapter level, not left to application code.

### 5. Cross-Project Contamination

**Threat:** In multi-tenant or multi-project environments, memories from one project could leak into another project's search results. This violates confidentiality boundaries and can cause confusion.

**Mitigation:** Strict tenant isolation is enforced by `packages/repo-resolver` and the policy engine. Every memory is scoped to a project/team at capture time. Search queries must be scoped to the requesting project's tenant boundary. Cross-project queries require explicit authorization.

### 6. Local Index Isolation

**Threat:** qmd indexes on a developer's machine could be shared across repositories, allowing one project's memories to appear in another project's local searches.

**Mitigation:** `packages/qmd-adapter` must create and manage indexes on a per-project basis. Index paths must be derived from project identity, not shared across repos. The edge daemon must enforce index isolation during sync.

### 7. Governance Bypass for Curated vs. Raw Memory

**Threat:** Without strict enforcement, raw memory candidates could be promoted to curated status through code paths that skip policy evaluation -- direct database writes, API misuse, or race conditions.

**Mitigation:** Memory promotion requires deterministic validation through the policy engine. There must be no code path that transitions a memory from inbox to curated without passing through `apps/curator` and `packages/policy-engine`. This is enforced architecturally, not by convention.

### 8. Enterprise Managed Settings

**Threat:** Organizations using Claude Code with managed settings may have policies about data retention, approved integrations, and content boundaries. Ignoring these settings could violate organizational policy.

**Mitigation:** The system must read and respect organization-level Claude Code settings. Enterprise managed settings take precedence over local configuration. The control plane API must expose managed settings compliance status.

### 9. Plugin and Hook Policy Risk

**Threat:** Third-party plugins or hooks integrated with the memory platform could compromise memory integrity -- injecting false memories, exfiltrating knowledge, or bypassing governance.

**Mitigation:** Plugins and hooks must operate within a defined permission model. No plugin should have direct write access to curated memory. All plugin-originated content enters the standard inbox-to-curation pipeline. Plugin provenance must be tracked in memory metadata.

### 10. Release Artifact Trust

**Threat:** Compromised build artifacts could introduce malicious code into deployments.

**Mitigation:** Signed releases and reproducible builds are planned for production releases. CI/CD pipeline integrity is enforced through GitHub Actions with pinned action versions. Dependency updates are reviewed via Dependabot PRs.

### 11. Auditability

**Threat:** Without audit trails, it becomes impossible to determine how a piece of knowledge entered the curated set, who approved it, or what policy version evaluated it.

**Mitigation:** All memory promotions must be traceable to their source: the originating session, the policy version that evaluated them, the timestamp of promotion, and the governance rules that were satisfied. The `apps/reporting` service must provide audit query capabilities.

## Secret Handling

- **Never commit `.env` files.** The `.gitignore` excludes them. Use `.env.example` files as templates with placeholder values.
- **Use GitHub Secrets for CI.** All credentials used in GitHub Actions workflows must be stored as repository or environment secrets.
- **Rotate secrets on exposure.** If a secret is committed to version control, even in a branch, treat it as compromised. Rotate immediately.
- **No secrets in memory candidates.** The policy engine enforces this, but developers should also avoid pasting secrets into Claude Code sessions when memory capture is active.

## Dependency Hygiene

- **Dependabot is enabled.** Automated PRs are created for dependency updates.
- **Review all dependency updates.** Do not auto-merge Dependabot PRs. Review changelogs and diffs, especially for major version bumps.
- **Prefer well-maintained packages.** Before adding a dependency, check its maintenance status, download count, and known vulnerabilities.
- **Pin GitHub Actions versions** to full commit SHAs, not tags.

## Local Development Safety

- Use `.env.example` files as templates. Copy to `.env` and fill in real values locally.
- Never store real credentials, API keys, or tokens in the repository.
- Keep local qmd indexes outside of version-controlled directories.
- Use separate development and production credentials.
