import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeContentHash, deriveMemoryId } from '@qmd-team-intent-kb/common';
import {
  AuditRepository,
  MemoryRepository,
  PolicyRepository,
  createDatabase,
  generateActorKeypair,
  openExistingDatabase,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';
import { makeMemory, makePolicy, TENANT } from './fixtures.js';
import { exportSourceSnapshot } from '../merge/source-snapshot.js';
import { SignedSourceSnapshot } from '../merge/source-snapshot-schema.js';
import { acquireRecoveryWriteLock, inspectRecoveryStore } from '../recovery/filesystem-boundary.js';

const cli = resolve('apps/curator/dist/merge/snapshot-main.js');
const destination = 'destination';
const content = 'A synthetic orchard convention for pruning trees.';
let root: string;
let sourcePath: string;
let targetPath: string;
let artifactPath: string;
let pinsPath: string;
let requestPath: string;
let planPath: string;
let exportRequestPath: string;
let keyPath: string;
let keys: ReturnType<typeof generateActorKeypair>;
let snapshot: SignedSourceSnapshot;
function put(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}
function run(args: string[]) {
  const child = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe('');
  const output = JSON.parse(child.stdout) as Record<string, unknown>;
  expect(child.stdout).not.toContain(content);
  expect(child.stdout).not.toContain(keys.privateKeyHex);
  expect(child.stdout).not.toContain(root);
  return { code: child.status, output };
}
function state(path = targetPath) {
  const db = openExistingDatabase({ path, readonly: true });
  try {
    return {
      memories: new MemoryRepository(db).findByTenant(destination),
      audit: new AuditRepository(db).findAllChronological(),
      rows: db.prepare('SELECT * FROM curated_memories ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}
function preview(extra: string[] = []) {
  return run([
    'preview',
    '--request',
    requestPath,
    '--checkpoints',
    pinsPath,
    '--out',
    planPath,
    ...extra,
  ]);
}
function plan() {
  const result = preview();
  expect(result.code).toBe(0);
  return result.output['reviewedDigest'] as string;
}
function apply(digest: string, extra: string[] = []) {
  return run([
    'apply',
    '--plan',
    planPath,
    '--digest',
    digest,
    '--checkpoints',
    pinsPath,
    ...extra,
  ]);
}
function pins(change: Record<string, unknown> = {}) {
  put(pinsPath, [
    {
      sourceId: snapshot.payload.sourceId,
      sourceTenantId: TENANT,
      destinationTenantId: destination,
      sequence: snapshot.payload.sequence,
      keyId: snapshot.payload.keyId,
      publicKeyHex: keys.publicKeyHex,
      snapshotDigest: snapshot.digest,
      validFrom: snapshot.payload.issuedAt,
      validUntil: snapshot.payload.expiresAt,
      revoked: false,
      ...change,
    },
  ]);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'snapshot-command-'));
  const sourceRoot = join(root, 'source');
  const targetRoot = join(root, 'target');
  mkdirSync(sourceRoot, { mode: 0o700 });
  mkdirSync(targetRoot, { mode: 0o700 });
  sourcePath = join(sourceRoot, 'teamkb.db');
  targetPath = join(targetRoot, 'teamkb.db');
  artifactPath = join(root, 'snapshot.json');
  pinsPath = join(root, 'pins.json');
  requestPath = join(root, 'request.json');
  planPath = join(root, 'plan.json');
  exportRequestPath = join(root, 'export.json');
  keyPath = join(root, 'key');
  keys = generateActorKeypair();
  const source = createDatabase({ path: sourcePath });
  const candidateId = randomUUID();
  const contentHash = computeContentHash(content);
  new MemoryRepository(source).insert(
    makeMemory({
      candidateId,
      id: deriveMemoryId(candidateId, contentHash),
      content,
      contentHash,
      tenantId: TENANT,
      sensitivity: 'confidential',
      metadata: { audience: 'owner', filePaths: [], tags: [] },
    }),
  );
  const options = {
    sourceId: 'orchard',
    sourceTenantId: TENANT,
    destinationTenantId: destination,
    sequence: 1,
    issuedAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  snapshot = SignedSourceSnapshot.parse(
    JSON.parse(exportSourceSnapshot(source, options, keys.privateKeyHex)),
  );
  source.close();
  createDatabase({ path: targetPath }).close();
  put(artifactPath, snapshot);
  pins();
  put(requestPath, { storePath: targetPath, tenantId: destination, artifactPaths: [artifactPath] });
  put(exportRequestPath, { storePath: sourcePath, options });
  writeFileSync(keyPath, keys.privateKeyHex, { mode: 0o600 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('protected snapshot operator CLI', () => {
  it('exports without changing source rows or receipts and creates a private signed artifact', () => {
    const before = state(sourcePath);
    const out = join(root, 'exported.json');
    const result = run([
      'export',
      '--request',
      exportRequestPath,
      '--private-key-file',
      keyPath,
      '--out',
      out,
    ]);
    expect(result).toMatchObject({
      code: 0,
      output: { ok: true, sourceModified: false, snapshotDigest: snapshot.digest, items: 1 },
    });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(snapshot);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(state(sourcePath)).toEqual(before);
  });
  it('previews read-only, applies retained floors and receipts, then replays without writes', () => {
    const sourceBefore = state(sourcePath);
    rmSync(artifactPath);
    expect(
      run([
        'export',
        '--request',
        exportRequestPath,
        '--private-key-file',
        keyPath,
        '--out',
        artifactPath,
      ]).code,
    ).toBe(0);
    const before = state();
    const digest = plan();
    expect(state()).toEqual(before);
    expect(statSync(planPath).mode & 0o777).toBe(0o600);
    expect(apply(digest)).toMatchObject({
      code: 0,
      output: {
        committed: true,
        alreadyApplied: false,
        settlement: { promoted: 1 },
        postcommit: { index: 'not_verified' },
      },
    });
    const after = state();
    expect(after.memories).toHaveLength(1);
    expect(after.memories[0]).toMatchObject({
      sensitivity: 'confidential',
      metadata: { audience: 'owner', filePaths: [], tags: [] },
    });
    expect(
      after.audit.map((event) => (JSON.parse(event.details_json) as { kind?: string }).kind),
    ).toContain('imported-sensitivity-floor-v1');
    const db = openExistingDatabase({ path: targetPath, readonly: true });
    expect(verifyAuditChain(new AuditRepository(db))).toMatchObject({
      breaks: [],
      unverifiedRows: 0,
    });
    db.close();
    expect(apply(digest)).toMatchObject({
      code: 0,
      output: { committed: false, alreadyApplied: true },
    });
    expect(state()).toEqual(after);
    rmSync(planPath);
    expect(state(sourcePath)).toEqual(sourceBefore);
    expect(preview()).toMatchObject({
      code: 0,
      output: { alreadyApplied: true, committed: false },
    });
  });
  it('uses stored policy and retains restrictions when it rejects admission', () => {
    const db = openExistingDatabase({ path: targetPath, readonly: false });
    new PolicyRepository(db).insert(
      makePolicy({
        tenantId: destination,
        rules: [
          {
            id: 'sensitivity',
            type: 'sensitivity_gate',
            action: 'reject',
            enabled: true,
            parameters: { blockedLevels: ['confidential'] },
          },
        ],
      }),
    );
    db.close();
    expect(apply(plan())).toMatchObject({
      code: 0,
      output: { committed: true, settlement: { rejected: 1 } },
    });
    expect(state().memories).toHaveLength(0);
    expect(
      state().audit.some(
        (event) =>
          (JSON.parse(event.details_json) as { kind?: string }).kind ===
          'imported-sensitivity-floor-v1',
      ),
    ).toBe(true);
  });
  it.each(['bare', 'signature', 'floor', 'inventory', 'checkpoint-in-artifact'])(
    'refuses stripped or substituted protected evidence: %s',
    (mode) => {
      const before = state();
      const copy = structuredClone(snapshot);
      if (mode === 'bare')
        put(
          artifactPath,
          copy.payload.items.map((item) => item.memory),
        );
      else if (mode === 'signature') {
        delete (copy as Partial<SignedSourceSnapshot>).signature;
        put(artifactPath, copy);
      } else if (mode === 'floor') {
        copy.payload.items[0]!.minimumSensitivity = 'public';
        put(artifactPath, copy);
      } else if (mode === 'inventory') {
        copy.payload.items = [];
        copy.payload.itemCount = 0;
        put(artifactPath, copy);
      } else {
        put(artifactPath, { ...copy, checkpoints: JSON.parse(readFileSync(pinsPath, 'utf8')) });
      }
      expect(preview().code).toBe(1);
      expect(existsSync(planPath)).toBe(false);
      expect(state()).toEqual(before);
    },
  );
  it.each(['revoked', 'expired', 'wrong-tenant', 'wrong-key', 'wrong-sequence'])(
    'rechecks authority at apply: %s',
    (mode) => {
      const digest = plan();
      const before = state();
      const changes = {
        revoked: { revoked: true },
        expired: { validUntil: new Date(Date.now() - 1000).toISOString() },
        'wrong-tenant': { destinationTenantId: 'other' },
        'wrong-key': { publicKeyHex: generateActorKeypair().publicKeyHex },
        'wrong-sequence': { sequence: 2 },
      };
      pins(changes[mode as keyof typeof changes]);
      expect(apply(digest).code).toBe(1);
      expect(state()).toEqual(before);
    },
  );
  it('refuses a different checkpoint provider path even with identical contents', () => {
    const digest = plan();
    const alternate = join(root, 'alternate-pins.json');
    put(alternate, JSON.parse(readFileSync(pinsPath, 'utf8')));
    expect(
      run(['apply', '--plan', planPath, '--digest', digest, '--checkpoints', alternate]),
    ).toMatchObject({ code: 1, output: { committed: false } });
    expect(state().audit).toHaveLength(0);
  });
  it('refuses changed artifacts after review', () => {
    const digest = plan();
    put(artifactPath, []);
    expect(apply(digest).code).toBe(1);
    expect(state().audit).toHaveLength(0);
  });
  it('refuses a changed applicable pin even when its extended validity still verifies the artifact', () => {
    const digest = plan();
    pins({ validUntil: new Date(Date.parse(snapshot.payload.expiresAt) + 60000).toISOString() });
    const before = state();
    expect(apply(digest).code).toBe(1);
    expect(state()).toEqual(before);
  });
  it('accepts a private checkpoint file rewrite with identical trusted pin values', () => {
    const digest = plan();
    writeFileSync(
      pinsPath,
      JSON.stringify(JSON.parse(readFileSync(pinsPath, 'utf8')), null, 2) + '\n',
    );
    expect(apply(digest)).toMatchObject({ code: 0, output: { committed: true } });
    expect(state().memories[0]!.sensitivity).toBe('confidential');
  });
  it('refuses a policy registered after preview', () => {
    const digest = plan();
    const db = openExistingDatabase({ path: targetPath, readonly: false });
    new PolicyRepository(db).insert(makePolicy({ tenantId: destination }));
    db.close();
    const before = state();
    expect(apply(digest).code).toBe(1);
    expect(state()).toEqual(before);
  });
  it('rechecks destination permissions during apply after a valid preview', () => {
    const digest = plan();
    const before = state();
    chmodSync(targetPath, 0o644);
    expect(apply(digest)).toMatchObject({ code: 1, output: { committed: false } });
    expect(state()).toEqual(before);
  });
  it.each(['digest', 'envelope', 'physical-store', 'destination-state'])(
    'refuses stale review binding: %s',
    (mode) => {
      let digest = plan();
      if (mode === 'digest') digest = '0'.repeat(64);
      if (mode === 'envelope') {
        const envelope = JSON.parse(readFileSync(planPath, 'utf8'));
        envelope.plan.tenantId = 'other';
        put(planPath, envelope);
      }
      if (mode === 'physical-store') {
        renameSync(targetPath, targetPath + '.old');
        createDatabase({ path: targetPath }).close();
      }
      if (mode === 'destination-state') {
        const db = openExistingDatabase({ path: targetPath, readonly: false });
        new MemoryRepository(db).insert(makeMemory({ tenantId: destination }));
        db.close();
      }
      const before = state();
      expect(apply(digest).code).toBe(1);
      expect(state()).toEqual(before);
    },
  );
  it('uses the shared kernel write lock', () => {
    const digest = plan();
    const lock = acquireRecoveryWriteLock(inspectRecoveryStore(targetPath), 0);
    try {
      expect(apply(digest, ['--lock-timeout-ms', '0'])).toMatchObject({
        code: 1,
        output: { committed: false },
      });
      expect(state().audit).toHaveLength(0);
    } finally {
      lock.release();
    }
    expect(apply(digest).code).toBe(0);
  });
  it.each([
    'public-request',
    'public-artifact',
    'public-pins',
    'symlink',
    'hardlink',
    'oversize',
    'public-store',
  ])('refuses unsafe inputs: %s', (mode) => {
    if (mode === 'public-request') chmodSync(requestPath, 0o644);
    if (mode === 'public-artifact') chmodSync(artifactPath, 0o644);
    if (mode === 'public-pins') chmodSync(pinsPath, 0o644);
    if (mode === 'symlink') {
      renameSync(artifactPath, artifactPath + '.real');
      symlinkSync(artifactPath + '.real', artifactPath);
    }
    if (mode === 'hardlink') linkSync(artifactPath, artifactPath + '.link');
    if (mode === 'oversize') writeFileSync(artifactPath, ' '.repeat(8 * 1024 * 1024 + 1));
    if (mode === 'public-store') chmodSync(targetPath, 0o644);
    expect(preview().code).toBe(1);
    expect(existsSync(planPath)).toBe(false);
  });
  it.each([
    'public-key',
    'malformed-key',
    'missing-store',
    'existing-output',
    'public-output-directory',
  ])('refuses unsafe export without source mutation: %s', (mode) => {
    const before = state(sourcePath);
    let out = join(root, 'exported.json');
    if (mode === 'public-key') chmodSync(keyPath, 0o644);
    if (mode === 'malformed-key')
      writeFileSync(keyPath, 'private material is deliberately invalid');
    if (mode === 'missing-store') {
      const request = JSON.parse(readFileSync(exportRequestPath, 'utf8'));
      request.storePath = join(root, 'missing.db');
      put(exportRequestPath, request);
    }
    if (mode === 'existing-output') put(out, { preserved: true });
    if (mode === 'public-output-directory') {
      const dir = join(root, 'public');
      mkdirSync(dir, { mode: 0o755 });
      out = join(dir, 'out.json');
    }
    expect(
      run(['export', '--request', exportRequestPath, '--private-key-file', keyPath, '--out', out])
        .code,
    ).toBe(1);
    expect(state(sourcePath)).toEqual(before);
    expect(existsSync(join(root, 'missing.db'))).toBe(false);
    if (mode === 'existing-output')
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ preserved: true });
  });
  it.each(
    [
      ['preview'],
      ['apply'],
      ['--help', '--unexpected'],
      ['merge-govern'],
      ['preview', '--private-key', 'raw-key'],
      ['preview', '--request', 'one', '--request', 'two'],
    ].map((args) => ({ args })),
  )('fails invalid usage without fallback: $args', ({ args }) => {
    expect(run(args)).toMatchObject({ code: 1, output: { ok: false, committed: false } });
    expect(state().audit).toHaveLength(0);
  });
  it('provides help and exports protected library functions alongside the legacy alias', async () => {
    expect(run(['--help']).code).toBe(0);
    const api = await import('../index.js');
    expect(api.legacyMergeGovern).toBe(api.mergeGovern);
    expect(api.applySourceImport).toBeTypeOf('function');
    expect(api.verifySourceSnapshot).toBeTypeOf('function');
  });
});
