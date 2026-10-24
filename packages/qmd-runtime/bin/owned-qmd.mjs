#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { verifyRuntime } from '../lib/runtime-inventory.mjs';

/** qmd 2.5.3 parseCLI option metadata; parsing must match its greedy string values. */
const cliOptions = {
  index: { type: 'string' },
  context: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  skill: { type: 'boolean' },
  global: { type: 'boolean' },
  yes: { type: 'boolean' },
  n: { type: 'string' },
  'min-score': { type: 'string' },
  all: { type: 'boolean' },
  full: { type: 'boolean' },
  format: { type: 'string' },
  csv: { type: 'boolean' },
  md: { type: 'boolean' },
  xml: { type: 'boolean' },
  files: { type: 'boolean' },
  json: { type: 'boolean' },
  explain: { type: 'boolean' },
  collection: { type: 'string', short: 'c', multiple: true },
  name: { type: 'string' },
  mask: { type: 'string' },
  force: { type: 'boolean', short: 'f' },
  'max-docs-per-batch': { type: 'string' },
  'max-batch-mb': { type: 'string' },
  pull: { type: 'boolean' },
  refresh: { type: 'boolean' },
  l: { type: 'string' },
  from: { type: 'string' },
  'max-bytes': { type: 'string' },
  'line-numbers': { type: 'boolean' },
  'no-line-numbers': { type: 'boolean' },
  'full-path': { type: 'boolean' },
  'candidate-limit': { type: 'string', short: 'C' },
  'no-rerank': { type: 'boolean', default: false },
  'no-gpu': { type: 'boolean', default: false },
  intent: { type: 'string' },
  'chunk-strategy': { type: 'string' },
  http: { type: 'boolean' },
  daemon: { type: 'boolean' },
  port: { type: 'string' },
};

export function assertOwnedTransportSupported(args) {
  let tokens;
  try {
    ({ tokens } = parseArgs({
      args,
      options: cliOptions,
      allowPositionals: true,
      strict: false,
      tokens: true,
    }));
  } catch {
    // Preserve upstream argument errors rather than introduce another CLI validator.
    return;
  }
  if (tokens.some((token) => token.kind === 'option' && token.name === 'http')) {
    throw new Error('Standalone HTTP is unsupported by the owned qmd launcher; use mcp stdio');
  }
}

/** Mirrors the hash-pinned upstream bin/qmd initialization, before CLI imports. */
export function initializedEnvironment(args, inherited, platform) {
  const env = { ...inherited };
  if (args[0] === 'mcp') {
    env.LLAMA_LOG_LEVEL ||= 'error';
    env.GGML_LOG_LEVEL ||= 'error';
    env.GGML_BACKEND_SILENT ||= '1';
  }
  if (platform === 'darwin' && env.QMD_METAL_KEEP_RESIDENCY !== '1') {
    env.GGML_METAL_NO_RESIDENCY ||= '1';
  }
  // Published dist is the only supported mode; no Bun/source-runner discovery.
  return env;
}

export function launchOwnedQmd(root, args) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Owned qmd candidate requires Node 22 or newer');
  }
  assertOwnedTransportSupported(args);
  const { qmd } = verifyRuntime(root);
  let child;
  let pendingSignal;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map();
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
  for (const signal of signals) {
    const handler = () => {
      pendingSignal = signal;
      if (child?.pid) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    child = spawn(process.execPath, [join(qmd, 'dist/cli/qmd.js'), ...args], {
      shell: false,
      stdio: 'inherit',
      env: initializedEnvironment(args, process.env, process.platform),
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  child.once('spawn', () => {
    if (pendingSignal) child.kill(pendingSignal);
  });
  child.once('error', () => {
    cleanup();
    process.stderr.write('Owned qmd candidate could not start its fixed Node runner\n');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  return child;
}

const modulePath = realpathSync(fileURLToPath(import.meta.url));
function isDirectEntry() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === modulePath;
  } catch {
    // Importing this module must not launch or fail because a caller's argv is unresolved.
    return false;
  }
}

if (isDirectEntry()) {
  try {
    launchOwnedQmd(dirname(dirname(modulePath)), process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Owned qmd candidate refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
