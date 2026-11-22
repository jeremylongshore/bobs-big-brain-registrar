import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../brief-cli.ts', import.meta.url));
function run(input: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli], {
    input,
    encoding: 'utf8',
    timeout: 10000,
  });
}

describe('manual brief stdin boundary', () => {
  it.each(['{malformed', '', 'x'.repeat(262145)])(
    'rejects malformed or oversized input without echoing it',
    (input) => {
      const result = run(input);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('{"ok":false,"error":{"kind":"InvalidInput"}}\n');
    },
  );

  it('emits a bounded result for an explicit valid packet', () => {
    const result = run(
      JSON.stringify({
        repo: {
          repoRoot: '/example',
          repoName: 'example',
          remoteUrl: 'https://github.com/example/repo.git',
          branch: null,
          commitSha: 'a'.repeat(40),
          isMonorepo: false,
          workspaceRoot: null,
          workspacePackage: null,
        },
        projects: [{ id: 'example', repositories: ['https://github.com/example/repo.git'] }],
        task: {
          projectId: 'example',
          id: 'example-1',
          goal: 'Verify',
          status: 'open',
          nextAction: 'Read source',
        },
        constraints: ['No deployment'],
        sources: [{ reference: 'example/source', revision: 'a'.repeat(40) }],
        retrievalStatus: 'not_requested',
        evidence: [],
        maxBytes: 1024,
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).value.projectId).toBe('example');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
  });
});
