// Synthetic collection guard: record and refuse before any protected operation.
import * as fs from 'node:fs';
import * as child from 'node:child_process';
import * as net from 'node:net';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import Module, { register, syncBuiltinESMExports } from 'node:module';

const log = process.env.TEAMKB_TEST_SENTINEL_LOG;
if (!log?.startsWith('/tmp/teamkb-live-guard-')) throw new Error('Owned sentinel log required');
const append = fs.appendFileSync;
const refuse = (kind) => {
  append(log, JSON.stringify({ kind }) + '\n');
  throw new Error('Synthetic sentinel refused ' + kind);
};
const protectedRoots = [join(homedir(), '.teamkb'), join(homedir(), '.claude', 'settings.json')];
const synthetic = process.env.TEAMKB_TEST_SYNTHETIC_ROOT;
if (synthetic?.startsWith('/tmp/teamkb-live-guard-'))
  protectedRoots.push(join(synthetic, 'protected'));
for (const name of [
  'existsSync',
  'statSync',
  'lstatSync',
  'readFileSync',
  'openSync',
  'mkdirSync',
]) {
  const original = fs.default[name];
  fs.default[name] = function (path, ...args) {
    const value =
      path instanceof URL ? path.pathname : typeof path === 'string' ? resolve(path) : '';
    if (protectedRoots.some((root) => value === root || value.startsWith(root + '/')))
      refuse('operator-path');
    return original.call(this, path, ...args);
  };
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = child.default[name];
  child.default[name] = function (file, ...args) {
    if (typeof file === 'string' && /^qmd(?:\.cmd)?$/.test(basename(file))) refuse('qmd-execution');
    return original.call(this, file, ...args);
  };
}
net.Socket.prototype.connect = function () {
  return refuse('service-connection');
};
// register() is supported throughout Node22; registerHooks() needs >=22.15.
register(new URL('./live-native-loader.mjs', import.meta.url));
const originalLoad = Module._load;
Module._load = function (specifier, ...args) {
  if (/(?:^|[/\\])(?:better-sqlite3|sqlite-vec)(?:[/\\]|$)/.test(specifier))
    refuse('native-import');
  return originalLoad.call(this, specifier, ...args);
};
syncBuiltinESMExports();
