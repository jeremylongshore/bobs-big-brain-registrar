#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hostPlatform,
  inventory,
  projectLock,
  sha256,
  verifyGraph,
  verifyLayout,
  verifyRuntime,
} from '../packages/qmd-runtime/lib/runtime-inventory.mjs';

import { copyRuntimeClosure } from './lib/copy-qmd-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePaths = [
  'pnpm-lock.yaml',
  'package.json',
  'scripts/stage-qmd-runtime.mjs',
  'scripts/lib/copy-qmd-runtime.mjs',
  'packages/qmd-runtime/package.json',
  'packages/qmd-runtime/README.md',
  'packages/qmd-runtime/bin/owned-qmd.mjs',
  'packages/qmd-runtime/lib/runtime-inventory.mjs',
];
const hashes = () =>
  Object.fromEntries(sourcePaths.map((p) => [p, sha256(readFileSync(join(root, p)))]));
const git = (...args) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot identify registrar source');
  return result.stdout.trim();
};
const platform = hostPlatform();

function packageContents(base, graph) {
  return Object.fromEntries(
    Object.entries(graph.directories).map(([id, paths]) => {
      const copies = paths.map((path) => inventory(join(base, path), { omit: ['node_modules'] }));
      if (!copies.every((copy) => JSON.stringify(copy) === JSON.stringify(copies[0]))) {
        throw new Error('Same selected snapshot has differing installed content');
      }
      return [id, copies[0]];
    }),
  );
}

function stage() {
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw new Error('Staging requires Node>=22');
  const before = hashes();
  const sourceHead = git('rev-parse', 'HEAD');
  const workingTreeStatus = git('status', '--porcelain', '--untracked-files=normal');
  // Metadata/parser only: no qmd CLI or native package entrypoint is loaded.
  const qmdRequire = createRequire(
    realpathSync(join(root, 'node_modules/@tobilu/qmd/package.json')),
  );
  const { parse } = qmdRequire('yaml');
  const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const projection = projectLock(lock, 'packages/qmd-runtime');
  const sourceGraph = verifyGraph(root, projection, platform, { sourceWorkspace: true });
  const sourceContents = packageContents(root, sourceGraph);
  const sourceBytes = Object.values(sourceContents).reduce((sum, entry) => sum + entry.bytes, 0);
  if (sourceBytes > 2 * 1024 ** 3) throw new Error('Source closure exceeds 2 GiB staging budget');
  const scratch = mkdtempSync(join(tmpdir(), 'bbb-qmd-runtime-candidate-'));
  const target = join(scratch, 'candidate');
  let packaging;
  let phase = 'copy';
  try {
    packaging = copyRuntimeClosure({ sourceRoot: root, target, projection, graph: sourceGraph });
    for (const file of [
      'package.json',
      'README.md',
      'bin/owned-qmd.mjs',
      'lib/runtime-inventory.mjs',
    ]) {
      const source = join(root, 'packages/qmd-runtime', file);
      const destination = join(target, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      chmodSync(destination, statSync(source).mode & 0o777);
      if (sha256(readFileSync(destination)) !== before[`packages/qmd-runtime/${file}`]) {
        throw new Error('Owned runtime file differs from frozen source');
      }
    }
    phase = 'inventory';
    const files = inventory(target);
    phase = 'graph';
    const graph = verifyGraph(target, projection, platform);
    phase = 'layout';
    verifyLayout(files, graph);
    phase = 'source-content';
    const contents = packageContents(target, graph);
    if (JSON.stringify(contents) !== JSON.stringify(sourceContents)) {
      throw new Error('Staged dependency content differs from installed source closure');
    }
    phase = 'source-guards';
    if (
      git('rev-parse', 'HEAD') !== sourceHead ||
      git('status', '--porcelain', '--untracked-files=normal') !== workingTreeStatus ||
      JSON.stringify(hashes()) !== JSON.stringify(before)
    ) {
      throw new Error('Source or lock changed during candidate staging');
    }
    const freshSourceGraph = verifyGraph(root, projection, platform, { sourceWorkspace: true });
    if (JSON.stringify(freshSourceGraph) !== JSON.stringify(sourceGraph)) {
      throw new Error('Installed source dependency edges changed during staging');
    }
    if (
      JSON.stringify(packageContents(root, freshSourceGraph)) !== JSON.stringify(sourceContents)
    ) {
      throw new Error('Installed source dependency content changed during staging');
    }
    const nativeFiles = Object.entries(files.entries)
      .filter(([name]) => /\.(?:node|so|dylib|dll)(?:\.|$)/.test(name))
      .map(([name, entry]) => ({ path: name, sha256: entry.sha256 }));
    const manifest = {
      schema: 'bbb-qmd-runtime/v1',
      sourceSnapshot: {
        baseCommit: sourceHead,
        uncommittedCandidate: workingTreeStatus !== '',
        workingTreeStatusSha256: sha256(workingTreeStatus),
        meaning:
          'Base commit plus explicit working-tree source hashes; the base commit alone may not contain candidate files.',
      },
      sourceHead,
      sourceFiles: before,
      lockSha256: before['pnpm-lock.yaml'],
      projection,
      graph,
      inventory: files,
      platform,
      nodeVersion: process.versions.node,
      nodeAbi: process.versions.modules,
      sourceInstalledPackageInventorySha256: sha256(JSON.stringify(sourceContents)),
      stagedMatchesSourceInstalledContent: true,
      packaging,
      packagingRationale:
        'pnpm9 deploy produced a workspace alias and omitted the installed native addon; copy only verified installed files and projected edges, with no dependency resolution or lifecycle scripts.',
      nativeFiles,
      limits: [
        'Host-specific source/artifact candidate; not configured or deployed serving identity.',
        'Lock integrities are expected archive metadata, not registry archive verification.',
        'Copied native file hashes match the installed source; no lifecycle hooks run, and copying does not prove ABI compatibility.',
        'Manifest detects changes relative to this receipt; it is not a signature or independent trust anchor.',
      ],
    };
    writeFileSync(join(target, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    phase = 'manifest-verification';
    verifyRuntime(target);
    process.stdout.write(
      `${JSON.stringify({ target, bytes: files.bytes, manifestSha256: sha256(readFileSync(join(target, 'runtime-manifest.json'))) })}\n`,
    );
  } catch (error) {
    let diagnostic;
    try {
      diagnostic = mkdtempSync(join(tmpdir(), 'bbb-qmd-runtime-stage-failure-'));
      writeFileSync(
        join(diagnostic, 'receipt.json'),
        JSON.stringify(
          {
            phase,
            error: {
              name: error.name,
              message: error.message,
              code: error.code,
              offender: error.offender,
            },
            packaging,
            sourceBefore: before,
            sourceAfter: hashes(),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } finally {
      // Only this invocation's newly created scratch tree is removed.
      rmSync(scratch, { recursive: true, force: true });
    }
    throw new Error(`Owned candidate rejected during ${phase}; private receipt: ${diagnostic}`, {
      cause: error,
    });
  }
}

try {
  stage();
} catch (error) {
  process.stderr.write(`Owned qmd staging refused: ${error.message}\n`);
  process.exitCode = 1;
}
