import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stockRoot = join(repo, 'node_modules/@intentsolutions/audit-harness');
const original = [
  '.dependency-cruiser.cjs',
  'scripts/crap-score.ts',
  'stryker.config.mjs',
  'tests/JOURNEYS.md',
  'tests/PERSONAS.md',
  'tests/RTM.md',
  'tests/TESTING.md',
  'vitest.config.ts',
];
const required = [
  ...new Set([
    ...original,
    'package.json',
    'scripts/harness-pin.sh',
    'scripts/harness-pin.node-test.mjs',
    '.harness-hash-extra-patterns',
    ...readdirSync(join(repo, '.github/workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => `.github/workflows/${name}`),
  ]),
].sort();
const manifestPaths = readFileSync(join(repo, '.harness-hash'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.trim().split(/\s+/, 2)[1])
  .sort();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'registrar-pin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [...required, '.harness-hash']) {
    const dest = join(root, path);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(join(repo, path))) copyFileSync(join(repo, path), dest);
    else if (path === '.harness-hash-extra-patterns')
      writeFileSync(dest, '# no extras configured\n');
    else assert.fail(`Required source artifact missing: ${path}`);
  }
  const script = join(root, 'node_modules/@intentsolutions/audit-harness/scripts/harness-hash.sh');
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(join(stockRoot, 'scripts/harness-hash.sh'), script);
  return root;
}

function verify(root, stock = false, overrides = {}) {
  const env = { ...process.env, ROOT: root, ...overrides };
  if (!Object.hasOwn(overrides, 'MANIFEST')) delete env.MANIFEST;
  const command = stock ? process.execPath : 'bash';
  const args = stock
    ? [join(stockRoot, 'bin/audit-harness.js'), 'verify']
    : [join(root, 'scripts/harness-pin.sh'), '--verify'];
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  return result;
}

test('manifest retains all eight original policy paths and adds stock/enforcement inputs', () => {
  assert.deepEqual(manifestPaths, required);
});

test('owning wrapper and stock CLI accept the same intact private fixture', (t) => {
  const root = fixture(t);
  for (const stock of [false, true]) {
    const result = verify(root, stock);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
});

for (const path of required) {
  test(`both verifiers reject changed protected bytes: ${path}`, (t) => {
    const root = fixture(t);
    writeFileSync(
      join(root, path),
      readFileSync(join(root, path), 'utf8') + '\n# synthetic pin mutation\n',
    );
    for (const stock of [false, true]) {
      const result = verify(root, stock);
      assert.equal(result.status, 2, result.stderr + result.stdout);
    }
  });
}

test('removing an extra pattern cannot silently drop an original policy pin', (t) => {
  const root = fixture(t);
  const extras = join(root, '.harness-hash-extra-patterns');
  writeFileSync(extras, readFileSync(extras, 'utf8').replace(/^tests\/RTM\.md\n/m, ''));
  for (const stock of [false, true]) assert.equal(verify(root, stock).status, 2);
});

test('verification refuses missing manifests without creating one', (t) => {
  const root = fixture(t);
  rmSync(join(root, '.harness-hash'));
  for (const stock of [false, true]) assert.equal(verify(root, stock).status, 3);
  assert.equal(existsSync(join(root, '.harness-hash')), false);
});

test('wrapper refuses alternate MANIFEST rather than checking another authority', (t) => {
  const root = fixture(t);
  const alternate = join(root, 'alternate-manifest');
  const result = verify(root, false, { MANIFEST: alternate });
  assert.equal(result.status, 4);
  assert.equal(existsSync(alternate), false);
});

test('wrapper refuses a missing installed verifier without provisioning it', (t) => {
  const root = fixture(t);
  rmSync(join(root, 'node_modules'), { recursive: true });
  assert.equal(verify(root).status, 3);
  assert.equal(existsSync(join(root, 'node_modules')), false);
});
