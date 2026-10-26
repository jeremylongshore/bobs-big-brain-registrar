/** Explicit private owned-runtime lane. Never discovers a global qmd or brain. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parse, stringify } from 'yaml';
import {
  RealQmdExecutor,
  getExportableCollections,
  getQmdTenantIndexPath,
  inspectRecoveryQmdRegistry,
  verifyRecoveryQmdRegistry,
  assertRecoveryQmdRegistryBinding,
} from '../dist/index.js';
import { verifyRuntime } from '../../qmd-runtime/lib/runtime-inventory.mjs';

const runtimeRoot = process.env.RECOVERY_OWNED_RUNTIME_ROOT;
const manifestSha256 = process.env.RECOVERY_OWNED_RUNTIME_SHA256;
const proofPath = process.env.RECOVERY_FIXTURE_PROOF;
if (!runtimeRoot || !manifestSha256 || !proofPath)
  throw new Error('Explicit owned runtime and private fixture proof required');
const hash = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(hash(readFileSync(join(runtimeRoot, 'runtime-manifest.json'))), manifestSha256);
const originalRuntime = verifyRuntime(runtimeRoot);
const work = mkdtempSync(join(tmpdir(), 'qmd-owned-registry-proof-'));
appendFileSync(proofPath, JSON.stringify({ phase: 'created', root: work }) + '\n');
const records = [];
try {
  const basePath = join(work, 'brain');
  mkdirSync(basePath, { mode: 0o700 });
  for (const tenantId of ['source-fixture', 'target-fixture']) {
    const exportDir = join(work, tenantId);
    mkdirSync(exportDir, { mode: 0o700 });
    for (const def of getExportableCollections()) mkdirSync(join(exportDir, def.sourceSubdir));
    const content = `---\ntenant_id: "${tenantId}"\n---\n# Synthetic registry proof\n\nThe ${tenantId === 'source-fixture' ? 'heliotrope' : 'saffron'} fixture belongs only to this private tenant.\n`;
    writeFileSync(join(exportDir, 'curated', 'fixture.md'), content);
    const qmdRuntime = { root: runtimeRoot, manifestSha256 };
    const options = { tenantId, basePath, exportDir, qmdRuntime };
    mkdirSync(getQmdTenantIndexPath(tenantId, basePath), { recursive: true, mode: 0o700 });
    const empty = inspectRecoveryQmdRegistry({ ...options, allowPartial: true });
    assert.equal(empty.state, 'partial');
    assert.equal(existsSync(empty.registryPath), false);
    assert.equal(existsSync(empty.indexPath), false);
    const executor = new RealQmdExecutor({
      ownedRuntime: qmdRuntime,
      tenant: { id: tenantId, basePath },
    });
    let added = 0;
    for (const def of getExportableCollections()) {
      inspectRecoveryQmdRegistry({ ...options, allowPartial: true });
      const result = await executor.execute([
        'collection',
        'add',
        join(exportDir, def.sourceSubdir),
        '--name',
        def.name,
      ]);
      assert.equal(result.exitCode, 0, 'Actual owned collection addition failed');
      assert.equal(result.failure, undefined);
      const subset = inspectRecoveryQmdRegistry({ ...options, allowPartial: true });
      assert.equal(subset.collections.length, ++added);
    }
    const before = await verifyRecoveryQmdRegistry(options);
    assert.equal(before.state, 'complete');
    const updated = await executor.execute(['update']);
    assert.equal(updated.exitCode, 0, 'Actual owned update failed');
    assert.equal(updated.failure, undefined);
    const after = await verifyRecoveryQmdRegistry(options, before);
    assertRecoveryQmdRegistryBinding(before, after);
    const db = new Database(after.indexPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          'SELECT d.collection,d.path,c.doc FROM documents d JOIN content c ON c.hash=d.hash WHERE d.active=1',
        )
        .all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].collection, 'kb-curated');
      assert.equal(rows[0].doc, content);
    } finally {
      db.close();
    }
    const registryBytes = readFileSync(after.registryPath);
    const data = parse(registryBytes.toString());
    const foreignRoot = join(work, 'foreign-private');
    mkdirSync(foreignRoot, { recursive: true, mode: 0o700 });
    data.collections['kb-curated'].path = foreignRoot;
    writeFileSync(after.registryPath, stringify(data));
    const databaseBefore = readFileSync(after.indexPath);
    await assert.rejects(verifyRecoveryQmdRegistry(options), /YAML collection binding differs/);
    assert.deepEqual(readFileSync(after.indexPath), databaseBefore);
    writeFileSync(after.registryPath, registryBytes);
    const hookMarker = join(work, 'hook-must-not-run');
    const hooked = parse(registryBytes.toString());
    hooked.collections['kb-curated'].update = `touch ${hookMarker}`;
    writeFileSync(after.registryPath, stringify(hooked));
    await assert.rejects(verifyRecoveryQmdRegistry(options), /YAML collection binding differs/);
    assert.equal(existsSync(hookMarker), false);
    writeFileSync(after.registryPath, registryBytes);
    assertRecoveryQmdRegistryBinding(before, await verifyRecoveryQmdRegistry(options, before));
    records.push({
      tenantId,
      collections: after.collections.length,
      activeDocuments: 1,
      coldInitialization: true,
      foreignPathRefusedBeforeCommand: true,
      updateHookRefusedBeforeCommand: true,
      command: after.command,
    });
  }
  const currentRuntime = verifyRuntime(runtimeRoot);
  assert.deepEqual(currentRuntime.manifest.inventory, originalRuntime.manifest.inventory);
  assert.equal(hash(readFileSync(join(runtimeRoot, 'runtime-manifest.json'))), manifestSha256);
  console.log(
    JSON.stringify({
      passed: true,
      profile: 'qmd-2.5.3',
      fullRuntimeInventoryVerifiedBeforeAndAfter: true,
      tenants: records,
      noModelOrServiceOperation: true,
    }),
  );
} finally {
  rmSync(work, { recursive: true, force: true });
  appendFileSync(
    proofPath,
    JSON.stringify({ phase: 'cleaned', root: work, removed: !existsSync(work) }) + '\n',
  );
}
