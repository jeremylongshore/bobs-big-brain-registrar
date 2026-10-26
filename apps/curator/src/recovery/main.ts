#!/usr/bin/env node
import { runRecoveryCommand } from './command.js';

process.exitCode = runRecoveryCommand(process.argv.slice(2), {
  output: (value) => process.stdout.write(JSON.stringify(value) + '\n'),
});
