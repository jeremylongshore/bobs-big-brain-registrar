#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyRuntime } from '../lib/runtime-inventory.mjs';

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
