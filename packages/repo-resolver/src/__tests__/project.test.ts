import { describe, expect, it } from 'vitest';
import { resolveProjectIdentity } from '../project.js';
import { deriveTenantId } from '../tenant.js';
import type { RepoContext } from '../types.js';

function context(remoteUrl: string | null, repoRoot = '/example/checkout'): RepoContext {
  return {
    repoRoot,
    repoName: 'checkout',
    remoteUrl,
    branch: 'main',
    commitSha: 'a'.repeat(40),
    isMonorepo: false,
    workspaceRoot: null,
    workspacePackage: null,
  };
}

const repositories = ['umbrella', 'compiler', 'registrar', 'plugin'].map(
  (repo) => `https://github.com/example/brain-${repo}.git`,
);
const projects = [{ id: 'brain', repositories }];

describe('explicit project identity', () => {
  it.each(repositories)('groups %s into one project', (remote) => {
    expect(resolveProjectIdentity(context(remote), projects)).toEqual({
      ok: true,
      value: { projectId: 'brain', matchedBy: 'origin' },
    });
  });

  it.each([
    'git@github.com:example/brain-compiler.git',
    'ssh://git@github.com/example/brain-compiler.git',
    'git+ssh://git@github.com/example/brain-compiler.git',
    'https://GitHub.com/Example/brain-compiler/',
    'https://user:synthetic-password@github.com/example/brain-compiler.git',
  ])('matches supported transport aliases without exposing user-info: %s', (remote) => {
    const resolved = resolveProjectIdentity(context(remote), projects);
    expect(resolved).toEqual({ ok: true, value: { projectId: 'brain', matchedBy: 'origin' } });
    expect(JSON.stringify(resolved)).not.toContain('synthetic-password');
  });

  it('keeps identity across moved checkouts and branch changes', () => {
    const original = context(repositories[0]!);
    const moved = { ...original, repoRoot: '/another/place', repoName: 'renamed', branch: null };
    expect(resolveProjectIdentity(moved, projects)).toEqual(
      resolveProjectIdentity(original, projects),
    );
  });

  it('does not carry a previous match into an unmapped or no-origin project', () => {
    expect(resolveProjectIdentity(context(repositories[0]!), projects).ok).toBe(true);
    expect(
      resolveProjectIdentity(context('https://github.com/other/brain-umbrella.git'), projects),
    ).toEqual({ ok: false, error: { kind: 'UnmappedRepo' } });
    expect(resolveProjectIdentity(context(null), projects)).toEqual({
      ok: false,
      error: { kind: 'NoRemote' },
    });
  });

  it('keeps hosts and explicit ports distinct', () => {
    for (const remote of [
      'https://gitlab.com/example/brain-compiler.git',
      'ssh://git@github.com:2222/example/brain-compiler.git',
    ]) {
      expect(resolveProjectIdentity(context(remote), projects)).toEqual({
        ok: false,
        error: { kind: 'UnmappedRepo' },
      });
    }
  });

  it('distinguishes a numeric SCP path from an SSH port', () => {
    const definitions = [
      { id: 'numeric-owner', repositories: ['https://github.com/123/repo.git'] },
      { id: 'port', repositories: ['ssh://git@github.com:123/repo.git'] },
    ];
    expect(resolveProjectIdentity(context('git@github.com:123/repo.git'), definitions)).toEqual({
      ok: true,
      value: { projectId: 'numeric-owner', matchedBy: 'origin' },
    });
    expect(
      resolveProjectIdentity(context('ssh://git@github.com:123/repo.git'), definitions),
    ).toEqual({
      ok: true,
      value: { projectId: 'port', matchedBy: 'origin' },
    });
    expect(
      resolveProjectIdentity(context('git@github.com:123/repo.git'), [definitions[1]]),
    ).toEqual({
      ok: false,
      error: { kind: 'UnmappedRepo' },
    });
  });

  it('rejects ambiguity after normalization even for an unrelated lookup', () => {
    const ambiguous = [
      ...projects,
      {
        id: 'other',
        repositories: ['git@github.com:example/brain-compiler.git'],
      },
    ];
    for (const remote of [repositories[0]!, 'https://github.com/example/unrelated.git']) {
      expect(resolveProjectIdentity(context(remote), ambiguous)).toEqual({
        ok: false,
        error: { kind: 'AmbiguousProjects' },
      });
    }
  });

  it('allows equivalent aliases within one project', () => {
    expect(
      resolveProjectIdentity(context(repositories[1]!), [
        {
          id: 'brain',
          repositories: [repositories[1]!, 'git@github.com:example/brain-compiler.git'],
        },
      ]).ok,
    ).toBe(true);
  });

  it.each([
    null,
    {},
    [{ id: '../private', repositories }],
    [{ id: 'brain', repositories: [] }],
    [{ id: 'brain', repositories, tenantId: 'another-tenant' }],
    [...projects, ...projects],
    [{ id: 'brain', repositories: ['/local/repo'] }],
  ])('refuses invalid definitions without echoing their contents', (definitions) => {
    expect(resolveProjectIdentity(context(repositories[0]!), definitions)).toEqual({
      ok: false,
      error: { kind: 'InvalidProjects' },
    });
  });

  it.each([
    '/local/repo',
    'file:///local/repo',
    'https://github.com/example/brain-compiler.git?token=synthetic-password',
    'https://github.com/example/brain-compiler.git#fragment',
    'https://github.com/example/../brain-compiler.git',
    'https://github.com/example/%62rain-compiler.git',
  ])('refuses unsupported origin syntax: %s', (remote) => {
    expect(resolveProjectIdentity(context(remote), projects)).toEqual({
      ok: false,
      error: { kind: 'UnsupportedRemote' },
    });
  });

  it('does not change tenant derivation or mutate the supplied context/map', () => {
    const repo = context(repositories[0]!);
    const before = JSON.stringify({ repo, projects });
    const tenant = deriveTenantId(repo, { explicit: 'authorized-tenant' });
    expect(resolveProjectIdentity(repo, projects).ok).toBe(true);
    expect(deriveTenantId(repo, { explicit: 'authorized-tenant' })).toBe(tenant);
    expect(JSON.stringify({ repo, projects })).toBe(before);
  });
});
