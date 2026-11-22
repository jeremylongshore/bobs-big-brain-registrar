export { RepoContext, ResolverError } from './types.js';
export { resolveRepoContext, type ResolveOptions } from './resolver.js';
export {
  RepoContextCache,
  clearCache,
  getDefaultCache,
  setCacheTtl,
  setDefaultCache,
} from './cache.js';
export { detectMonorepo } from './monorepo.js';
export type { MonorepoInfo } from './monorepo.js';
export { deriveTenantId, normalizeRemoteUrl } from './tenant.js';
export type { TenantOverrides } from './tenant.js';
export { ProjectDefinition, resolveProjectIdentity } from './project.js';
export type { ProjectIdentity, ProjectResolutionError } from './project.js';
export { buildProjectBrief, serializeProjectBrief } from './brief.js';
export type { ProjectBrief, BriefError, BriefResult } from './brief.js';

export const name = '@qmd-team-intent-kb/repo-resolver';
