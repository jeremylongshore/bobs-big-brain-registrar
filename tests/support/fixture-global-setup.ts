import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    fixtureRunRoot: string;
  }
}

export default function setup(project: TestProject) {
  const root = mkdtempSync(join(tmpdir(), 'teamkb-test-run-'));
  const proofPath = process.env['TEAMKB_TEST_SENTINEL_STATE'];
  project.provide('fixtureRunRoot', root);
  return () => {
    // Global teardown also owns fully skipped files whose afterAll never runs.
    rmSync(root, { recursive: true, force: true });
    if (proofPath?.startsWith('/tmp/teamkb-live-guard-')) {
      appendFileSync(proofPath, JSON.stringify({ phase: 'run-cleaned', root }) + '\n');
    }
  };
}
