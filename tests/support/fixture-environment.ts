import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, inject } from 'vitest';

const liveFlags = ['DENSE', 'RERANK', 'RETRIEVAL'];
const requested = liveFlags.some((kind) => process.env[`TEAMKB_TEST_LIVE_${kind}`] === '1');
if (requested && process.env['TEAMKB_TEST_LIVE_LANE'] !== '1') {
  throw new Error('Explicit live tests require --config vitest.live.config.ts');
}
if (process.env['TEAMKB_TEST_LIVE_LANE'] !== '1') {
  // Only documented routing/auth overrides are reset. HOME and toolchain stay
  // unchanged; individual tests may still set and restore their own settings.
  const keys = [
    'TEAMKB_BASE_PATH',
    'TEAMKB_HOME',
    'TEAMKB_BRAINIGNORE',
    'TEAMKB_EXPORT_DIR',
    'TEAMKB_API_URL',
    'TEAMKB_API_TOKEN',
    'TEAMKB_API_KEY',
    'TEAMKB_ORIGIN_SECRET',
    'TEAMKB_QMD_BIN',
    'BBB_QMD_BIN',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'INDEX_PATH',
    'QMD_CONFIG_DIR',
  ];
  const originalHome = process.env['HOME'];
  const proofPath = process.env['TEAMKB_TEST_SENTINEL_STATE'];
  const proof = (entry: object) => {
    if (proofPath?.startsWith('/tmp/teamkb-live-guard-'))
      appendFileSync(proofPath, JSON.stringify(entry) + '\n');
  };
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const runRoot = inject('fixtureRunRoot');
  if (typeof runRoot !== 'string')
    throw new Error('Fixture run root must be provided by global setup');
  const scratch = mkdtempSync(join(runRoot, 'worker-'));
  proof({ phase: 'created', root: scratch });
  for (const key of keys) delete process.env[key];
  for (const name of ['brain', 'config', 'cache']) mkdirSync(join(scratch, name));
  process.env['TEAMKB_BASE_PATH'] = join(scratch, 'brain');
  process.env['TEAMKB_BRAINIGNORE'] = join(scratch, 'brainignore');
  process.env['XDG_CONFIG_HOME'] = join(scratch, 'config');
  process.env['XDG_CACHE_HOME'] = join(scratch, 'cache');
  writeFileSync(process.env['TEAMKB_BRAINIGNORE'], '');
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(scratch, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    proof({
      phase: 'cleaned',
      root: scratch,
      environmentRestored: keys.every((key) => process.env[key] === previous[key]),
      homeUnchanged: process.env['HOME'] === originalHome,
    });
  };
  // Active files restore environment here. Global teardown owns skipped-file
  // scratch cleanup when Vitest terminates a worker without running hooks.
  process.once('exit', cleanup);
  afterAll(() => {
    cleanup();
    process.removeListener('exit', cleanup);
  });
}
