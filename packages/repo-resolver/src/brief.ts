import { z } from 'zod';
import { err, ok, type Result } from '@qmd-team-intent-kb/common';
import { RepoContext } from './types.js';
import { resolveProjectIdentity } from './project.js';

const Text = z.string().trim().min(1).max(4096);
const ProjectId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const Evidence = z
  .object({
    projectId: ProjectId,
    citation: z
      .string()
      .regex(/^qmd:\/\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._/-]+$/)
      .max(512),
    text: Text,
    state: z.enum(['current', 'historical', 'unverified', 'conflicting', 'superseded']),
  })
  .strict();
const Input = z
  .object({
    repo: RepoContext,
    projects: z.unknown(),
    task: z
      .object({
        projectId: ProjectId,
        id: Text,
        goal: Text,
        status: z.enum(['open', 'in_progress', 'blocked', 'deferred', 'closed']),
        nextAction: Text,
      })
      .strict(),
    constraints: z.array(Text).max(32),
    sources: z
      .array(
        z
          .object({
            reference: Text,
            revision: Text,
          })
          .strict(),
      )
      .min(1)
      .max(32),
    retrievalStatus: z.enum(['available', 'unavailable', 'not_requested']),
    evidence: z.array(Evidence).max(256),
    maxBytes: z.number().int().min(256).max(65536).default(8192),
  })
  .strict();

export interface ProjectBrief {
  version: 1;
  projectId: string;
  inputAuthority: 'caller_asserted';
  evidenceTrust: 'untrusted_data';
  task: z.infer<typeof Input>['task'];
  constraints: string[];
  sources: z.infer<typeof Input>['sources'];
  retrievalStatus: z.infer<typeof Input>['retrievalStatus'];
  requiresReview: boolean;
  evidence: z.infer<typeof Evidence>[];
  omitted: { otherProject: number; superseded: number; budget: number };
}

export type BriefError = {
  kind: 'InvalidInput' | 'UnresolvedProject' | 'TaskProjectMismatch' | 'BudgetExceeded';
};
export type BriefResult = Result<ProjectBrief, BriefError>;

/** This exact serialization, including its newline and result wrapper, is budgeted. */
export function serializeProjectBrief(result: BriefResult): string {
  return JSON.stringify(result) + '\n';
}

/** Compose caller-selected inputs only. Never reads storage or establishes access authority. */
export function buildProjectBrief(input: unknown): BriefResult {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return err({ kind: 'InvalidInput' });
  const data = parsed.data;
  const identity = resolveProjectIdentity(data.repo, data.projects);
  if (!identity.ok) return err({ kind: 'UnresolvedProject' });
  if (data.task.projectId !== identity.value.projectId) return err({ kind: 'TaskProjectMismatch' });
  if (data.retrievalStatus !== 'available' && data.evidence.length > 0) {
    return err({ kind: 'InvalidInput' });
  }

  const relevant = data.evidence.filter((e) => e.projectId === identity.value.projectId);
  const active = relevant.filter((e) => e.state !== 'superseded');
  const conflicts = active.filter((e) => e.state === 'conflicting');
  const optional = active.filter((e) => e.state !== 'conflicting');
  const brief: ProjectBrief = {
    version: 1,
    projectId: identity.value.projectId,
    inputAuthority: 'caller_asserted',
    evidenceTrust: 'untrusted_data',
    task: data.task,
    constraints: data.constraints,
    sources: data.sources,
    retrievalStatus: data.retrievalStatus,
    requiresReview: conflicts.length > 0 || data.retrievalStatus === 'unavailable',
    evidence: [...conflicts],
    omitted: {
      otherProject: data.evidence.length - relevant.length,
      superseded: relevant.length - active.length,
      budget: optional.length,
    },
  };
  const fits = (): boolean =>
    Buffer.byteLength(serializeProjectBrief(ok(brief)), 'utf8') <= data.maxBytes;
  if (!fits()) return err({ kind: 'BudgetExceeded' });
  // Preserve caller order. A later, shorter item may fit even if an earlier one did not.
  for (const item of optional) {
    brief.evidence.push(item);
    brief.omitted.budget -= 1;
    if (!fits()) {
      brief.evidence.pop();
      brief.omitted.budget += 1;
    }
  }
  return ok(brief);
}
