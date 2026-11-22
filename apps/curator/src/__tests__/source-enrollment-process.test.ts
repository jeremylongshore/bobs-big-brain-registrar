import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase, MemoryRepository, CandidateRepository } from '@qmd-team-intent-kb/store';
import { makeSourceGovernanceFixture } from './source-governance-fixtures.js';

describe('actual CLI source-enrollment boundary', () => {
  it('keeps required-tenant spool intake reviewable but refuses legacy governance actionably', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-cli-'));
    const path = join(root, 'store.db');
    const spool = join(root, 'spool');
    const f = makeSourceGovernanceFixture();
    try {
      const db = createDatabase({ path });
      db.prepare('INSERT INTO source_classification_authority VALUES (1, ?)').run(
        JSON.stringify(f.registry),
      );
      db.close();
      await mkdir(spool);
      await writeFile(join(spool, 'spool-test.jsonl'), JSON.stringify(f.candidate) + '\n');
      const result = spawnSync(
        process.execPath,
        [
          resolve('apps/curator/dist/main.js'),
          'ingest',
          spool,
          '--tenant',
          f.candidate.tenantId,
          '--db',
          path,
          '--json',
          '--brainignore',
          join(root, 'absent-brainignore'),
        ],
        {
          encoding: 'utf8',
          timeout: 3000,
          env: {
            ...process.env,
            TEAMKB_BASE_PATH: root,
            TEAMKB_ORIGIN_SECRET: 'synthetic-process-origin-key',
          },
        },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        stage: 'govern',
        code: 'SOURCE_ENROLLMENT_REQUIRED',
        error: expect.stringContaining('source-governance v1 API'),
      });
      const check = createDatabase({ path });
      try {
        expect(new MemoryRepository(check).count()).toBe(0);
        expect(new CandidateRepository(check).findById(f.candidate.id)?.status).toBe('inbox');
      } finally {
        check.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
