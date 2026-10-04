import { SECRET_PATTERNS, scanForSecrets } from '@qmd-team-intent-kb/claude-runtime';

/**
 * The governance secret scan — ONE deterministic function shared by the
 * promote-time `secret_detection` rule and the curator's whole-brain
 * `secret-sweep`, so the periodic sweep can never drift from the admission gate.
 *
 * A finding names the pattern and where it fired. It never carries the matched
 * text: a finding is safe to log, print, and store in an audit reason.
 */
export interface SecretFinding {
  /** Stable pattern id, e.g. `prose-password`, `base64-wrapped:aws-key`. */
  patternId: string;
  /** Human-readable pattern name, e.g. `Password Stated in Prose`. */
  patternName: string;
  /** 1-based lines the pattern fired on, ascending. Best-effort: a hit found
   *  only in the newline-collapsed view reports line 1. */
  lines: number[];
}

/**
 * Scan `text` for secrets and return one finding per pattern, sorted by pattern
 * id. Pure and deterministic — no model, no I/O.
 */
export function scanTextForSecrets(text: string): SecretFinding[] {
  const byPattern = new Map<string, { patternName: string; lines: Set<number> }>();
  for (const match of scanForSecrets(text)) {
    const entry = byPattern.get(match.patternId) ?? {
      patternName: match.patternName,
      lines: new Set<number>(),
    };
    entry.lines.add(match.line);
    byPattern.set(match.patternId, entry);
  }
  return [...byPattern.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([patternId, { patternName, lines }]) => ({
      patternId,
      patternName,
      lines: [...lines].sort((a, b) => a - b),
    }));
}

/** Every pattern id the governance secret scan can report, sorted. */
export function listSecretPatternIds(): string[] {
  return SECRET_PATTERNS.map((pattern) => pattern.id).sort((a, b) => a.localeCompare(b));
}
