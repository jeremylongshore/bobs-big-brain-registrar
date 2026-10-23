#!/usr/bin/env tsx
/** Estate evaluation launcher: isolate every writable index before searching. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { getTeamKbBasePath } from '../packages/common/src/paths.js';
import { withEstateEvalSnapshot } from './lib/estate-eval-snapshot.js';

async function main(): Promise<void> {
  const sourceBase = resolve(getTeamKbBasePath());
  if (!existsSync(join(sourceBase, 'teamkb.db'))) {
    console.error(`no store at ${join(sourceBase, 'teamkb.db')}`);
    process.exitCode = 2;
    return;
  }
  const tenant = process.env['TEAMKB_TENANT'] ?? 'intent-solutions';
  const cancellation = new AbortController();
  let child: ChildProcess | undefined;
  let interruptedCode: number | undefined;
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const handler = () => {
      interruptedCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal];
      cancellation.abort();
      child?.kill(signal);
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    const code = await withEstateEvalSnapshot(
      sourceBase,
      tenant,
      async (snapshot) => {
        const worker = join(dirname(resolve(process.argv[1]!)), 'eval-estate-onboarding-worker.ts');
        const loader = createRequire(resolve(process.argv[1]!)).resolve('tsx');
        const index = join(snapshot.base, 'qmd-index', tenant);
        return await new Promise<number>((resolveExit, reject) => {
          child = spawn(process.execPath, ['--import', loader, worker, ...process.argv.slice(2)], {
            cwd: snapshot.base,
            stdio: 'inherit',
            env: {
              ...process.env,
              TEAMKB_BASE_PATH: snapshot.base,
              INDEX_PATH: join(index, 'cache', 'qmd', 'index.sqlite'),
              QMD_CONFIG_DIR: join(index, 'config', 'qmd'),
              PWD: snapshot.base,
              TMPDIR: snapshot.base,
              TSX_DISABLE_CACHE: '1',
              TEAMKB_EVAL_EXPORT_DIR: snapshot.exportDir,
              TEAMKB_EVAL_SNAPSHOT: JSON.stringify({
                indexes: snapshot.indexes,
                startedAt: snapshot.startedAt,
                completedAt: snapshot.completedAt,
              }),
            },
          });
          child.once('error', reject);
          child.once('close', (exitCode) => resolveExit(exitCode ?? interruptedCode ?? 1));
        });
      },
      cancellation.signal,
    );
    process.exitCode = interruptedCode ?? code;
  } catch (err) {
    if (interruptedCode === undefined) throw err;
    process.exitCode = interruptedCode;
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
