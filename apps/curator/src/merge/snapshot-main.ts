#!/usr/bin/env node
import { runSnapshotCommand } from './snapshot-command.js';

process.exitCode = runSnapshotCommand(process.argv.slice(2), {
  output: (value) => process.stdout.write(JSON.stringify(value) + '\n'),
});
