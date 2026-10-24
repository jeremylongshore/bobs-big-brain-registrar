import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Socket } from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { expect, it } from 'vitest';

it('refuses synthetic operations in the actual Vitest worker', async () => {
  const root = process.env['TEAMKB_TEST_SYNTHETIC_ROOT'];
  if (!root?.startsWith('/tmp/teamkb-live-guard-')) throw new Error('Synthetic root required');
  expect(() => existsSync(join(root, 'protected', 'absent'))).toThrow(
    'sentinel refused operator-path',
  );
  expect(() => execFileSync(join(root, 'bin', 'qmd'))).toThrow('sentinel refused qmd-execution');
  const socket = new Socket();
  socket.on('error', () => undefined);
  try {
    expect(() => socket.connect({ path: join(root, 'absent.sock') })).toThrow(
      'sentinel refused service-connection',
    );
  } finally {
    socket.destroy();
  }
  const requireAdapter = createRequire(
    new URL('../../../packages/qmd-adapter/package.json', import.meta.url),
  );
  await expect(
    import(pathToFileURL(requireAdapter.resolve('better-sqlite3')).href),
  ).rejects.toThrow('sentinel refused native-import');
});
