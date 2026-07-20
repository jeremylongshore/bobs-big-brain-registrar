/**
 * brainignore — the deterministic import exclusion ruleset (bead
 * qmd-team-intent-kb-5kw.1).
 *
 * The 2026-07-16 whole-machine digestion promoted vendored third-party docs
 * (node_modules-style package docs, license boilerplate, lockfiles, minified
 * bundles) into the curated brain because import had no `.gitignore`
 * equivalent. This module is that equivalent: a committed DEFAULT ruleset of
 * gitignore-like path patterns plus deterministic content heuristics, with a
 * per-brain override file (`~/.teamkb/brainignore`) merged on top at intake.
 *
 * ## Pattern format (gitignore-like subset — documented deviations)
 *
 *  - One pattern per line; `#` starts a comment; blank lines are ignored.
 *  - `*` matches any run of characters EXCEPT `/`; `**` matches across
 *    segments (including `/`); `?` matches one non-`/` character.
 *  - A pattern containing no `/` matches the path BASENAME (like gitignore).
 *  - A pattern containing `/` matches anywhere in the path unless it starts
 *    with `/`, which anchors it at the start of the path.
 *  - `!pattern` NEGATES (re-includes). The LAST matching pattern wins, so an
 *    override-file `!` line can re-admit something a default excludes.
 *  - DEVIATION from gitignore: matching is CASE-INSENSITIVE (`LICENSE`,
 *    `License.txt` and `license` are the same boilerplate), and there are no
 *    trailing-slash directory semantics (candidate `metadata.filePaths` are
 *    file paths, not directory listings).
 *
 * ## Honesty note — deterministic != perfect
 *
 * Every rule here is a pure function of the candidate's bytes: same input,
 * same verdict, no model, no network, no clock. That makes rejections
 * receiptable and reproducible — it does NOT make them omniscient. The
 * heuristics have documented false-positive and false-negative modes (see
 * each `analyzeContent` check); the escape hatch for a false positive is a
 * `!pattern` line in the per-brain override file, or hand-promotion through
 * the admin path after review. A rejection here is "this matched a committed
 * exclusion rule", never "a model judged this worthless".
 *
 * @module import-exclusion/brainignore
 */

/** One compiled brainignore pattern. */
export interface BrainignorePattern {
  /** The raw pattern text as written (without any `!` prefix). */
  readonly pattern: string;
  /** True when the line was `!pattern` — a match RE-INCLUDES the path. */
  readonly negated: boolean;
  /** Where the pattern came from — the committed defaults or an override file. */
  readonly source: 'default' | 'override';
  /** Compiled matcher (case-insensitive). */
  readonly regex: RegExp;
  /** True when the pattern contains no `/` and therefore matches basenames. */
  readonly basenameOnly: boolean;
}

/** A parsed ruleset: ordered patterns (later entries win) + provenance. */
export interface BrainignoreRuleset {
  readonly patterns: readonly BrainignorePattern[];
  /** Absolute path of the override file merged in, or null when defaults-only. */
  readonly overridePath: string | null;
}

/** Verdict for one path / content check. */
export interface BrainignoreMatch {
  /** Stable machine-readable code (lands in receipts verbatim). */
  readonly code:
    | 'brainignore_path'
    | 'brainignore_minified_content'
    | 'brainignore_generated_content'
    | 'brainignore_license_boilerplate'
    | 'brainignore_untitled_title';
  /** Human-readable evidence: the matched pattern + path, or the measured heuristic values. */
  readonly evidence: string;
}

/**
 * The committed default path patterns. Ordered; an override file's patterns
 * are appended AFTER these, so an operator `!` line always wins (last match
 * wins). Grouped by junk class from the 2026-07-16 cleanup:
 */
export const DEFAULT_BRAINIGNORE_PATTERNS: readonly string[] = [
  // -- vendored / generated directory trees ---------------------------------
  '**/node_modules/**',
  '**/site-packages/**',
  '**/bower_components/**',
  '**/vendor/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.git/**',
  '**/.next/**',
  '**/coverage/**',
  '**/dist/**',
  '**/build/**',
  // -- minified / generated file names --------------------------------------
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.bundle.js',
  '*.chunk.js',
  // -- lockfiles (machine-written dependency state, never knowledge) --------
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  // -- repo boilerplate templates (CoC / SECURITY / SUPPORT / license) ------
  'CODE_OF_CONDUCT*',
  'SECURITY.md',
  'SUPPORT.md',
  'PULL_REQUEST_TEMPLATE*',
  '**/ISSUE_TEMPLATE/**',
  'LICENSE*',
  'LICENCE*',
  'NOTICE*',
  'PATENTS*',
];

/**
 * Compile one gitignore-like pattern into a case-insensitive RegExp.
 * Deterministic translation, no backtracking traps: only `*`, `**`, `?` are
 * special; everything else is escaped literally.
 */
export function compilePattern(
  raw: string,
  source: 'default' | 'override',
): BrainignorePattern | null {
  let pattern = raw.trim();
  if (pattern === '' || pattern.startsWith('#')) return null;

  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1).trim();
    if (pattern === '') return null;
  }

  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);
  const basenameOnly = !pattern.includes('/');

  // Translate glob → regex. `**` first (crosses `/`), then `*` and `?`.
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i += 2;
      // Collapse a following `/` into the `.*` so `**/x` also matches `x` at
      // the path root (gitignore semantics).
      if (pattern[i] === '/') i += 1;
    } else if (ch === '*') {
      re += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }

  // Basename patterns match the final segment; path patterns match the whole
  // normalized path (optionally anchored at the start).
  const full = basenameOnly ? `^${re}$` : anchored ? `^${re}$` : `^(?:.*/)?${re}$`;
  return {
    pattern: raw.trim().replace(/^!/, '').trim(),
    negated,
    source,
    regex: new RegExp(full, 'i'),
    basenameOnly,
  };
}

/** Parse the text of a brainignore file into compiled patterns (in order). */
export function parseBrainignore(
  text: string,
  source: 'default' | 'override',
): BrainignorePattern[] {
  const out: BrainignorePattern[] = [];
  for (const line of text.split('\n')) {
    const compiled = compilePattern(line, source);
    if (compiled !== null) out.push(compiled);
  }
  return out;
}

/** The committed defaults, compiled once at module load. */
export const DEFAULT_BRAINIGNORE_RULESET: BrainignoreRuleset = {
  patterns: DEFAULT_BRAINIGNORE_PATTERNS.map((p) => {
    const compiled = compilePattern(p, 'default');
    /* istanbul ignore next -- the committed defaults are all valid patterns */
    if (compiled === null) throw new Error(`invalid default brainignore pattern: ${p}`);
    return compiled;
  }),
  overridePath: null,
};

/** Normalize a candidate filePath for matching: forward slashes, no `./`. */
function normalizePath(p: string): string {
  let n = p.replace(/\\/g, '/');
  while (n.startsWith('./')) n = n.slice(2);
  while (n.startsWith('/')) n = n.slice(1);
  return n;
}

/**
 * Match one path against the ruleset. Gitignore semantics: every pattern is
 * consulted in order and the LAST match decides — a later `!pattern`
 * (typically from the override file, which is appended after the defaults)
 * re-includes a path a default excluded.
 *
 * @returns the deciding pattern when the path is EXCLUDED, or null.
 */
export function matchPath(path: string, ruleset: BrainignoreRuleset): BrainignorePattern | null {
  const normalized = normalizePath(path);
  const basename = normalized.split('/').pop() ?? normalized;
  let decision: BrainignorePattern | null = null;
  for (const p of ruleset.patterns) {
    const subject = p.basenameOnly ? basename : normalized;
    if (p.regex.test(subject)) decision = p;
  }
  return decision !== null && !decision.negated ? decision : null;
}

// ---------------------------------------------------------------------------
// Content heuristics
// ---------------------------------------------------------------------------

/** A single line longer than this with almost no whitespace reads as minified. */
const MINIFIED_LINE_LENGTH = 1000;
/** Whitespace ratio below this on a long line reads as minified (prose ≈ 0.15–0.20). */
const MINIFIED_WHITESPACE_RATIO = 0.1;
/** Content shorter than this is never entropy-classified (too little signal). */
const ENTROPY_MIN_LENGTH = 1024;
/** Shannon entropy (bits/char) above this reads as encoded/generated content.
 *  English prose ≈ 4.2–4.8; base64 ≈ 6.0; source code ≈ 4.5–5.1. */
const ENTROPY_THRESHOLD = 5.2;
/** How much of the head of the content is scanned for license boilerplate. */
const LICENSE_SCAN_WINDOW = 600;

/** Case-insensitive markers that identify license boilerplate text. */
const LICENSE_MARKERS: readonly string[] = [
  'apache license',
  'mit license',
  'gnu general public license',
  'gnu lesser general public license',
  'mozilla public license',
  'permission is hereby granted, free of charge',
  'redistribution and use in source and binary forms',
];

/** Titles that mark a candidate as having no real title. */
const UNTITLED_TITLES: ReadonlySet<string> = new Set(['untitled', 'untitled document', 'no title']);

/** Shannon entropy in bits per character. Pure and deterministic. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Deterministic content heuristics for machine-written content that path
 * patterns can miss (a minified bundle imported under an innocent name, a
 * license pasted into a markdown note). Each check is honest about its
 * limits:
 *
 *  - **minified**: any line > {@link MINIFIED_LINE_LENGTH} chars whose
 *    whitespace ratio is < {@link MINIFIED_WHITESPACE_RATIO}. Catches minified
 *    JS/CSS (whitespace ≈ 0.01–0.05). False negative: minified code split
 *    into short lines. False positive: none known for prose (unwrapped
 *    markdown paragraphs keep a ≈0.15+ space ratio).
 *  - **generated/encoded**: content ≥ {@link ENTROPY_MIN_LENGTH} chars with
 *    Shannon entropy > {@link ENTROPY_THRESHOLD} bits/char — base64 blobs,
 *    packed sourcemaps. False negative: hex dumps (entropy 4.0). False
 *    positive: none known for natural-language notes.
 *  - **license boilerplate**: a known license marker phrase inside the first
 *    {@link LICENSE_SCAN_WINDOW} chars. Catches vendored LICENSE copies
 *    imported under any filename. False positive: a genuine note ABOUT
 *    licensing that opens by quoting a license header — re-admit via review.
 *  - **untitled**: the normalized title is a known placeholder. Catches the
 *    empty/untitled documents class from the 2026-07-16 digestion.
 */
export function analyzeContent(content: string, title: string): BrainignoreMatch | null {
  const normalizedTitle = title.trim().toLowerCase();
  if (UNTITLED_TITLES.has(normalizedTitle)) {
    return {
      code: 'brainignore_untitled_title',
      evidence: `title "${title.trim()}" is a placeholder, not a real title`,
    };
  }

  const head = content.slice(0, LICENSE_SCAN_WINDOW).toLowerCase();
  for (const marker of LICENSE_MARKERS) {
    if (head.includes(marker)) {
      return {
        code: 'brainignore_license_boilerplate',
        evidence: `license marker "${marker}" found in the first ${LICENSE_SCAN_WINDOW} chars`,
      };
    }
  }

  for (const line of content.split('\n')) {
    if (line.length > MINIFIED_LINE_LENGTH) {
      const whitespace = line.length - line.replace(/\s/g, '').length;
      const ratio = whitespace / line.length;
      if (ratio < MINIFIED_WHITESPACE_RATIO) {
        return {
          code: 'brainignore_minified_content',
          evidence:
            `line of ${line.length} chars with whitespace ratio ${ratio.toFixed(3)} ` +
            `(> ${MINIFIED_LINE_LENGTH} chars and < ${MINIFIED_WHITESPACE_RATIO} reads as minified)`,
        };
      }
    }
  }

  if (content.length >= ENTROPY_MIN_LENGTH) {
    const entropy = shannonEntropy(content);
    if (entropy > ENTROPY_THRESHOLD) {
      return {
        code: 'brainignore_generated_content',
        evidence:
          `Shannon entropy ${entropy.toFixed(2)} bits/char over ${content.length} chars ` +
          `(> ${ENTROPY_THRESHOLD} reads as encoded/generated, prose is ≈ 4.2–4.8)`,
      };
    }
  }

  return null;
}

/**
 * Evaluate a candidate's paths + content against the ruleset. Path patterns
 * first (cheap, and the deciding evidence names the exact path + pattern),
 * then the content heuristics.
 */
export function evaluateBrainignore(
  filePaths: readonly string[],
  content: string,
  title: string,
  ruleset: BrainignoreRuleset,
): BrainignoreMatch | null {
  for (const path of filePaths) {
    const match = matchPath(path, ruleset);
    if (match !== null) {
      return {
        code: 'brainignore_path',
        evidence: `path "${path}" matches ${match.source} pattern "${match.pattern}"`,
      };
    }
  }
  return analyzeContent(content, title);
}
