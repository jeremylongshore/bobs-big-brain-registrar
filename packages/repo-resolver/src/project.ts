import { z } from 'zod';
import { err, ok, type Result } from '@qmd-team-intent-kb/common';
import type { RepoContext } from './types.js';
import { normalizeRemoteUrl } from './tenant.js';

/** Caller-owned relevance grouping; never a tenant or an access grant. */
export const ProjectDefinition = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    repositories: z.array(z.string().trim().min(1).max(2048)).min(1).max(128),
  })
  .strict();
export type ProjectDefinition = z.infer<typeof ProjectDefinition>;

const ProjectDefinitions = z.array(ProjectDefinition).max(512);

export interface ProjectIdentity {
  projectId: string;
  matchedBy: 'origin';
}

export type ProjectResolutionError = {
  kind: 'InvalidProjects' | 'AmbiguousProjects' | 'NoRemote' | 'UnsupportedRemote' | 'UnmappedRepo';
};

/** Accept remote URLs, not local paths or basename guesses. Never return raw input. */
function remoteKey(value: string): string | null {
  const remote = value.trim().replace(/\/+$/, '');
  if (/[\s?#%\\]/.test(remote)) return null;
  // A bounded network remote grammar. Credentials may occur only in user-info.
  const network =
    /^(?:https|ssh|git\+ssh):\/\/(?:[^/@]+@)?[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/i;
  const scp = /^(?:[^/@:]+@)?[a-z0-9.-]+:[a-z0-9._/-]+$/i;
  // In SCP syntax the colon ALWAYS starts a path, even a numeric first segment.
  // Convert it before the legacy normalizer can mistake that segment for a port.
  const normalizedInput = network.test(remote)
    ? remote
    : scp.test(remote)
      ? remote.replace(/^((?:[^/@:]+@)?[a-z0-9.-]+):/i, 'ssh://$1/')
      : null;
  if (normalizedInput === null) return null;
  const key = normalizeRemoteUrl(normalizedInput);
  const segments = key.split('/');
  if (segments.length < 2 || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return null;
  }
  return key;
}

/**
 * Resolve one logical project from an explicit, validated repository map.
 * Pure and opt-in: no files, environment, cache, tenant derivation or store reads.
 * Validate the whole map before selecting; ambiguity never picks the first entry.
 */
export function resolveProjectIdentity(
  repo: RepoContext,
  definitions: unknown,
): Result<ProjectIdentity, ProjectResolutionError> {
  const parsed = ProjectDefinitions.safeParse(definitions);
  if (!parsed.success) return err({ kind: 'InvalidProjects' });

  const ids = new Set<string>();
  const projectsByRemote = new Map<string, string>();
  for (const project of parsed.data) {
    if (ids.has(project.id)) return err({ kind: 'InvalidProjects' });
    ids.add(project.id);
    for (const remote of project.repositories) {
      const key = remoteKey(remote);
      if (key === null) return err({ kind: 'InvalidProjects' });
      const owner = projectsByRemote.get(key);
      if (owner !== undefined && owner !== project.id) {
        return err({ kind: 'AmbiguousProjects' });
      }
      projectsByRemote.set(key, project.id);
    }
  }

  if (repo.remoteUrl === null) return err({ kind: 'NoRemote' });
  const key = remoteKey(repo.remoteUrl);
  if (key === null) return err({ kind: 'UnsupportedRemote' });
  const projectId = projectsByRemote.get(key);
  return projectId === undefined
    ? err({ kind: 'UnmappedRepo' })
    : ok({ projectId, matchedBy: 'origin' });
}
