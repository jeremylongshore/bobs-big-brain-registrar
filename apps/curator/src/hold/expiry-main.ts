#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runHoldExpiryWorker } from './expiry-worker.js';

export async function holdExpiryMain(args: readonly string[]): Promise<number> {
  if (
    (args.length !== 2 && args.length !== 3) ||
    args[0] !== '--config' ||
    !args[1] ||
    (args.length === 3 && args[2] !== '--apply')
  ) {
    process.stderr.write(
      'Usage: curator-hold-expiry --config /absolute/private/worker.json [--apply]\nDefault: preview only; no sender or receipt writes.\n',
    );
    return 2;
  }
  const result = await runHoldExpiryWorker(args[1], args[2] === '--apply');
  process.stdout.write(JSON.stringify(result) + '\n');
  return !result.ok ? 1 : result.reconciliationRequired.length ? 3 : 0;
}
function direct(): boolean {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
if (direct()) process.exitCode = await holdExpiryMain(process.argv.slice(2));
