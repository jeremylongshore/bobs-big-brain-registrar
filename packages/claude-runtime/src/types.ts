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
