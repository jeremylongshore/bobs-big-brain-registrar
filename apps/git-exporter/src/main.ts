#!/usr/bin/env node
/**
 * Binary entry for `exporter-cli`.
 *
 * Wires the real database factory (`createDatabase`) and delegates to the
 * pure dispatch function in `./cli.ts`. Tests invoke `dispatch` directly
 * with an in-memory / shared db factory — see `__tests__/cli.test.ts`.
 *
 * Used by ICO's `scripts/demo-e2e.sh` stage 5 (`qmd-team-intent-kb-e3q`).
 *
 * @module main
 */

import { createDatabase } from '@qmd-team-intent-kb/store';

import { dispatch } from './cli.js';

async function main(): Promise<void> {
  const exitCode = await dispatch(process.argv.slice(2), {
    createDb: ({ dbPath }) => createDatabase({ path: dbPath ?? ':memory:' }),
  });
  process.exit(exitCode);
}

void main();
