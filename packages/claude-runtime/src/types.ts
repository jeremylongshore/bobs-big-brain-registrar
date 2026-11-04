import type { MemorySource, MemoryCategory, TrustLevel } from '@qmd-team-intent-kb/schema';

/** Raw capture event from a Claude Code session */
export interface RawCaptureEvent {
  content: string;
  title: string;
  source: MemorySource;
  category: MemoryCategory;
  trustLevel?: TrustLevel;
  sessionId?: string;
  filePaths?: string[];
  language?: string;
  projectContext?: string;
}

/** Git context resolved at capture time */
export interface GitContext {
  repoUrl: string;
  branch: string;
  userName: string;
  tenantId: string;
  /** Lowercased repo basename, populated when resolved via repo-resolver */
  repoName?: string;
  /** HEAD commit SHA (40-char hex), populated when resolved via repo-resolver */
  commitSha?: string;
}

/** A named secret detection pattern */
export interface SecretPattern {
  id: string;
  name: string;
  regex: RegExp;
  description: string;
  /**
   * Optional context gate. When present, `regex` matching a value is NOT enough:
   * the SAME scan window (the line / collapsed view / decoded blob the value was
   * found in) must ALSO match `requiresContext` for the hit to count. Used to
   * disambiguate a structurally-ambiguous value (e.g. a bare UUID, which is a
   * Heroku API key only when a `heroku` / `api` / `key` / `token` keyword or an
   * assignment is nearby) so the scanner does not over-flag ordinary prose.
   *
   * This RAISES precision without lowering recall for the specific pattern: a
   * real key in a key-context still fires; a bare id in prose does not. It never
   * relaxes any OTHER pattern — every context-free rule keeps firing unchanged.
   */
  requiresContext?: RegExp;
  /**
   * Optional value predicate. When present, a `regex` match only counts when
   * `accept` returns true for it; the scanner then looks at EVERY match in the
   * window (not just the first) and reports the first accepted one. Receives the
   * match as `[fullMatch, ...captureGroups]`.
   *
   * Used where the SHAPE is right but the value may be a documentation
   * placeholder (`scheme://username:password@host`, `password is "<your
   * password>"`): the regex finds the shape, `accept` rejects the placeholder.
   * Must be pure and deterministic, and must never log or return the value.
   */
  accept?: (match: readonly (string | undefined)[]) => boolean;
  /**
   * When true the pattern is NOT run against the whitespace-stripped view of the
   * newline-collapsed pre-pass (it still runs per line and against the
   * single-space view). For patterns whose precision depends on whitespace —
   * a quoted value containing spaces is prose, not a password, and stripping the
   * spaces would turn it into a password-shaped token.
   */
  skipWhitespaceStrippedView?: boolean;
  /**
   * Rejoin only whitespace runs containing a line separator in the additional
   * split-token view, preserving ordinary horizontal word boundaries. Excludes
   * this pattern from the fully whitespace-stripped view; per-line, single-space
   * and encoded scans retain their existing behavior.
   */
  lineWrapOnly?: boolean;
  /**
   * In the whitespace-stripped view, validate a token at the ORIGINAL source
   * position after joining line-wrap whitespace. Horizontal fragments remain
   * accepted unless the prefix is immediately preceded by an ASCII letter.
   * A newline is a boundary, so unrelated preceding prose cannot hide a key;
   * ambiguous soft-wrapped prose can remain suspicious. Other scan passes and
   * value/context predicates retain their existing behavior.
   */
  requiresSourceToken?: boolean;
}

/** A match found by the secret scanner */
export interface SecretMatch {
  patternId: string;
  patternName: string;
  line: number;
  column: number;
  matchLength: number;
}

/** Interface for providing repo context — integration seam for Phase 5 repo-resolver */
export interface RepoContextProvider {
  resolveGitContext(cwd?: string): Promise<GitContext | null>;
}
