// Real transitive dependency contracts. All mutable data lives in argv[3].
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const [mode, scratch] = process.argv.slice(2);
const requireQmd = createRequire(import.meta.resolve('@tobilu/qmd'));
const requireLlama = createRequire(requireQmd.resolve('node-llama-cpp'));

function packageAt(requireFrom, name) {
  let root = dirname(requireFrom.resolve(name));
  for (;;) {
    const manifest = join(root, 'package.json');
    if (existsSync(manifest)) {
      const info = JSON.parse(readFileSync(manifest, 'utf8'));
      if (info.name === name) return { root, info };
    }
    const parent = dirname(root);
    if (parent === root) throw new Error('Cannot find package ' + name);
    root = parent;
  }
}
function importEntry(pkg) {
  let entry = pkg.info.exports?.['.']?.import ?? pkg.info.module ?? pkg.info.main;
  while (typeof entry === 'object') entry = entry.default;
  return pathToFileURL(join(pkg.root, entry)).href;
}
function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(GIT_|TEAMKB_|QMD_|SSH_)/i.test(key) && !/^(EDITOR|VISUAL|PAGER|INDEX_PATH)$/i.test(key),
    ),
  );
}

async function gitContract(attack) {
  const selected = packageAt(requireLlama, 'simple-git');
  const { simpleGit, GitPluginError } = await import(importEntry(selected));
  const log = join(scratch, 'git-invocations.jsonl');
  const marker = join(scratch, 'marker');
  const hooks = join(scratch, 'empty-hooks');
  mkdirSync(hooks);
  const emptyConfig = join(scratch, 'empty-config');
  writeFileSync(emptyConfig, '');
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(realGit.status, 0);
  const binary = join(scratch, 'git');
  // Configuration isolation happens AFTER simple-git's environment guard. No
  // unsafe allowance is enabled in the library, including in attack cases.
  writeFileSync(
    binary,
    [
      '#!' + process.execPath,
      "const fs = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      'fs.appendFileSync(' +
        JSON.stringify(log) +
        ', JSON.stringify(process.argv.slice(2)) + "\\n");',
      'const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: ' +
        JSON.stringify(emptyConfig) +
        ', GIT_CONFIG_SYSTEM: ' +
        JSON.stringify(emptyConfig) +
        ' };',
      'const args = ["-c", ' +
        JSON.stringify('core.hooksPath=' + hooks) +
        ', "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...process.argv.slice(2)];',
      'const result = spawnSync(' +
        JSON.stringify(realGit.stdout.trim()) +
        ', args, { env, stdio: "inherit" });',
      'process.exit(result.status ?? 1);',
    ].join('\n'),
    { mode: 0o700 },
  );
  const make = (baseDir, extra = {}) => simpleGit({ baseDir, binary, ...extra });
  const source = join(scratch, 'source');
  mkdirSync(source);
  const git = make(source);
  await git.init();
  await git.addConfig('user.name', 'Owned fixture');
  await git.addConfig('user.email', 'fixture@example.invalid');
  await git.addConfig('commit.gpgsign', 'false');
  writeFileSync(join(source, 'data.txt'), 'first\n');
  await git.add(['--force', 'data.txt']);
  await git.commit('first fixture commit');
  writeFileSync(join(source, 'data.txt'), 'second\n');
  await git.add(['--force', 'data.txt']);
  await git.commit('second fixture commit');
  await git.branch(['-M', 'main']);
  await git.tag(['fixture-release']);
  if (attack) {
    const helper = join(scratch, 'marker-helper');
    writeFileSync(
      helper,
      '#!' +
        process.execPath +
        '\n' +
        'require("node:fs").writeFileSync(' +
        JSON.stringify(marker) +
        ', "owned marker");\n',
      { mode: 0o700 },
    );
    const before = readFileSync(log, 'utf8');
    if (attack === 'trailer') {
      const input = join(scratch, 'message');
      writeFileSync(input, 'synthetic message\n');
      for (const key of ['trailer.audit.cmd', 'trailer.audit.command']) {
        for (const style of ['config', 'inline', 'write']) {
          const instance = make(source, style === 'config' ? { config: [key + '=' + helper] } : {});
          const command =
            style === 'config'
              ? ['interpret-trailers', '--trailer', 'audit:fixture', input]
              : style === 'inline'
                ? [
                    '-c',
                    key + '=' + helper,
                    'interpret-trailers',
                    '--trailer',
                    'audit:fixture',
                    input,
                  ]
                : ['config', key, helper];
          await assert.rejects(instance.raw(command), GitPluginError);
        }
      }
    } else {
      await assert.rejects(
        make(source).env({ VISUAL: helper }).raw(['var', 'GIT_EDITOR']),
        GitPluginError,
      );
    }
    assert.equal(existsSync(marker), false);
    assert.equal(
      readFileSync(log, 'utf8'),
      before,
      'unsafe request must be refused before Git spawn',
    );
    return { version: selected.info.version, refusedBeforeSpawn: true, markerAbsent: true };
  }
  const bundle = join(scratch, 'fixture.bundle');
  await git.raw(['bundle', 'create', bundle, 'HEAD']);
  const fromBundle = join(scratch, 'from-bundle');
  await make(scratch, { progress() {} }).clone(bundle, fromBundle, { '--quiet': null });
  await make(fromBundle).removeRemote('origin');
  assert.equal(readFileSync(join(fromBundle, 'data.txt'), 'utf8'), 'second\n');
  const shallow = join(scratch, 'shallow');
  await make(scratch, {
    progress({ progress }) {
      assert.equal(typeof progress, 'number');
    },
  }).clone(pathToFileURL(source).href, shallow, {
    '--depth': 1,
    '--branch': 'fixture-release',
    '--recursive': null,
    '--quiet': null,
  });
  const clone = make(shallow);
  await clone.addConfig('user.name', 'Owned fixture');
  await clone.addConfig('user.email', 'fixture@example.invalid');
  await clone.addConfig('commit.gpgsign', 'false');
  await clone.fetch(['--unshallow']);
  assert.equal((await clone.log(['-1'])).all[0].message, 'second fixture commit');
  assert.equal(
    (await clone.listRemote(['--get-url', 'origin'])).trim(),
    pathToFileURL(source).href,
  );
  await clone.removeRemote('origin');
  await clone.addRemote('origin', source);
  await clone.checkout(['-B', 'fixture-working']);
  await clone.branch(['-M', 'main']);
  await clone.branch(['temporary']);
  assert.ok((await clone.branch()).all.includes('temporary'));
  await clone.branch(['--delete', 'temporary']);
  assert.ok((await clone.tags()).all.includes('fixture-release'));
  await clone.tag(['--delete', 'fixture-release']);
  await clone.tag(['replacement']);
  assert.equal((await clone.revparse(['--abbrev-ref', 'HEAD'])).trim(), 'main');
  assert.equal((await clone.tag(['--points-at', 'HEAD'])).trim(), 'replacement');
  const sha = (await clone.raw(['commit-tree', 'HEAD^{tree}', '-m', 'squashed fixture'])).trim();
  await clone.reset(['--hard', sha]);
  assert.equal((await clone.log(['-1'])).all[0].message, 'squashed fixture');
  await clone.raw(['gc', '--aggressive', '--prune=all']);
  const outputBundle = join(scratch, 'squashed.bundle');
  await clone.raw(['bundle', 'create', outputBundle, 'HEAD']);
  assert.match(await clone.raw(['bundle', 'list-heads', outputBundle]), new RegExp(sha));
  assert.equal(readFileSync(join(shallow, 'data.txt'), 'utf8'), 'second\n');
  return { version: selected.info.version, consumerOperations: true, bundleVerified: true };
}

async function nanoidContract() {
  const selected = packageAt(requireLlama, 'nanoid');
  const { nanoid, customAlphabet } = await import(
    pathToFileURL(join(selected.root, 'non-secure/index.js')).href
  );
  assert.equal(nanoid(-1), '');
  assert.equal(customAlphabet('ab')(-1), '');
  assert.equal(nanoid(8).length, 8);
  assert.match(customAlphabet('ab', 8)(), /^[ab]{8}$/);
  return { version: selected.info.version, negativeSizesTerminate: true };
}
function header(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.fill(32, 148, 156);
  h.write(type, 156);
  h.write('ustar\0', 257);
  const sum = h.reduce((n, b) => n + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function padded(data) {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
async function tarContract() {
  const requireCmake = createRequire(requireLlama.resolve('cmake-js'));
  const selected = packageAt(requireCmake, 'tar');
  const tar = await import(importEntry(selected));
  const longName = Buffer.from('a/'.repeat(12_000) + 'entry.txt\0');
  const archive = join(scratch, 'selected-long-path.tar.gz');
  writeFileSync(
    archive,
    gzipSync(
      Buffer.concat([
        header('././@LongLink', longName.length, 'L'),
        padded(longName),
        header('entry.txt', 0),
        Buffer.alloc(1024),
      ]),
    ),
  );
  // Nonmatching selection is the original deep-parent-recursion crash case.
  const nonmatching = [];
  await tar.t({ file: archive, gzip: true, onReadEntry: (entry) => nonmatching.push(entry.path) }, [
    'selected.txt',
  ]);
  assert.deepEqual(nonmatching, []);
  const actualPath = longName.subarray(0, -1).toString();
  const matching = [];
  await tar.t({ file: archive, gzip: true, onReadEntry: (entry) => matching.push(entry.path) }, [
    actualPath,
  ]);
  assert.deepEqual(matching, [actualPath]);
  const content = Buffer.from('owned fixture\n');
  const valid = join(scratch, 'valid.tar');
  writeFileSync(
    valid,
    Buffer.concat([header('selected.txt', content.length), padded(content), Buffer.alloc(1024)]),
  );
  const output = join(scratch, 'extracted');
  mkdirSync(output);
  await tar.x({ file: valid, cwd: output }, ['selected.txt']);
  assert.equal(readFileSync(join(output, 'selected.txt'), 'utf8'), content.toString());
  return {
    version: selected.info.version,
    selectedLongPathSurvives: true,
    selectedLongPathEmitted: true,
    validExtraction: true,
  };
}

try {
  let result;
  if (mode === 'git-normal') result = await gitContract();
  else if (mode === 'git-trailer') result = await gitContract('trailer');
  else if (mode === 'git-visual') result = await gitContract('visual');
  else if (mode === 'nanoid') result = await nanoidContract();
  else if (mode === 'tar') result = await tarContract();
  else throw new Error('Unknown fixture mode');
  appendFileSync(join(scratch, 'receipt.json'), JSON.stringify(result));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
