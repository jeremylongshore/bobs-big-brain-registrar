import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { ok, err, type Result } from '@qmd-team-intent-kb/common';
import type { RepoContext, ResolverError } from './types.js';
import { runGit } from './git.js';
import { getDefaultCache, type RepoContextCache } from './cache.js';
import { detectMonorepo } from './monorepo.js';

export interface ResolveOptions {
  /**
   * Override the cache used for this resolution. When omitted, the
   * process-local default cache from `getDefaultCache()` is used.
   * Pass a fresh `RepoContextCache` instance (or `null`) to bypass.
   */
  cache?: RepoContextCache | null;
}

/**
 * Resolve the git repo context enclosing `cwd`.
 *
 * The core resolver handles plain, detached, bare, no-commit, and no-remote
 * cases. Monorepo detection and workspace-package identification are added
 * in a later pass (bead mbd.3) and default to non-monorepo until then.
 *
 * See 000-docs/026-AT-DSGN-repo-resolver-design.md for the full design.
 */
export async function resolveRepoContext(
  cwd: string,
  options: ResolveOptions = {},
): Promise<Result<RepoContext, ResolverError>> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(cwd);
  } catch (e) {
    return err<ResolverError>({
      kind: 'Io',
      path: cwd,
      cause: e instanceof Error ? e.message : String(e),
    });
  }

  const cache = options.cache === undefined ? getDefaultCache() : options.cache;
  if (cache) {
    const cached = cache.getByCwd(canonicalCwd);
    if (cached) return ok(cached);
  }

  // Single consolidated git call — the hot path for warm caches in later beads.
  const probe = await runGit(canonicalCwd, [
    'rev-parse',
    '--show-toplevel',
    '--is-bare-repository',
    'HEAD',
  ]);

  if (probe.exitCode === -1) {
    return err<ResolverError>({ kind: 'GitUnavailable', cause: probe.stderr });
  }

  if (probe.exitCode !== 0) {
    const stderr = probe.stderr.toLowerCase();
    if (stderr.includes('not a git repository')) {
      return err<ResolverError>({ kind: 'NotAGitRepo', cwd: canonicalCwd });
    }
    // git's CVE-2022-24765 mitigation: "fatal: detected dubious ownership in
    // repository at <path>" fires when a repo dir up the tree is owned by a
    // different user than the running process (e.g. a stray repo at a
    // root-owned /tmp, hit by any mktemp dir beneath it). git refuses to
    // operate, so the resolver cannot establish a trusted repo context here —
    // classify as NotAGitRepo (no usable git repo could be resolved) rather
    // than the misleading GitUnavailable, which implies git itself is broken.
    // Bead qmd-team-intent-kb-4gl.
    if (stderr.includes('dubious ownership')) {
      return err<ResolverError>({ kind: 'NotAGitRepo', cwd: canonicalCwd });
    }
    // `--show-toplevel` fails inside a bare repo because there's no working tree.
    if (stderr.includes('must be run in a work tree') || stderr.includes('bare repository')) {
      const gitDir = await runGit(canonicalCwd, ['rev-parse', '--absolute-git-dir']);
      const repoRoot = gitDir.exitCode === 0 ? gitDir.stdout.trim() : canonicalCwd;
      return err<ResolverError>({ kind: 'BareRepo', repoRoot });
    }
    // `git rev-parse HEAD` fails with "unknown revision" when no commits exist.
    if (stderr.includes('unknown revision') || stderr.includes('bad revision')) {
      const top = await runGit(canonicalCwd, ['rev-parse', '--show-toplevel']);
      const repoRoot = top.exitCode === 0 ? top.stdout.trim() : canonicalCwd;
      return err<ResolverError>({ kind: 'NoCommits', repoRoot });
    }
    return err<ResolverError>({ kind: 'GitUnavailable', cause: probe.stderr });
  }

  const lines = probe.stdout.split('\n').filter((l) => l.length > 0);
  if (lines.length < 3) {
    return err<ResolverError>({
      kind: 'GitUnavailable',
      cause: `Unexpected git rev-parse output: ${probe.stdout}`,
    });
  }
  const rawRepoRoot = lines[0];
  const isBareStr = lines[1];
  const commitSha = lines[2];
  if (rawRepoRoot === undefined || isBareStr === undefined || commitSha === undefined) {
    return err<ResolverError>({
      kind: 'GitUnavailable',
      cause: `Unexpected git rev-parse output: ${probe.stdout}`,
    });
  }

  if (isBareStr.trim() === 'true') {
    return err<ResolverError>({ kind: 'BareRepo', repoRoot: rawRepoRoot });
  }

  const repoRoot = rawRepoRoot;

  const [remoteResult, branchResult] = await Promise.all([
    runGit(repoRoot, ['config', '--get', 'remote.origin.url']),
    runGit(repoRoot, ['symbolic-ref', '--short', 'HEAD']),
  ]);

  const remoteUrl = remoteResult.exitCode === 0 ? remoteResult.stdout.trim() || null : null;
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() || null : null;

  const monorepo = detectMonorepo(canonicalCwd, repoRoot);

  const context: RepoContext = {
    repoRoot,
    repoName: basename(repoRoot).toLowerCase(),
    remoteUrl,
    branch,
    commitSha,
    ...monorepo,
  };

  if (cache) {
    cache.set(canonicalCwd, context);
  }

  return ok(context);
}
