#!/usr/bin/env node
/**
 * Binary entry for `curator-cli`.
 *
 * Wires the real database factory (`createDatabase` from
 * `@qmd-team-intent-kb/store`) and delegates to the pure dispatch
 * function in `./cli.ts`. Tests invoke `dispatch` directly with an
 * in-memory db factory (`createTestDatabase`) — see
 * `__tests__/cli.test.ts`.
 *
 * Used by ICO's `scripts/demo-e2e.sh` stage 5 once bead `9jx` lands.
 *
 * @module main
 */

import { createDatabase, createTestDatabase } from '@qmd-team-intent-kb/store';

import { dispatch } from './cli.js';

async function main(): Promise<void> {
  const exitCode = await dispatch(process.argv.slice(2), {
    createDb: ({ dbPath, readonly }) =>
      dbPath !== undefined
        ? createDatabase({ path: dbPath, readonly: readonly ?? false })
        : createTestDatabase(),
  });
  process.exit(exitCode);
}

void main();
