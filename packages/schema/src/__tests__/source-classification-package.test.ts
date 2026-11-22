import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('ships an independently consumable canonical signing protocol in the schema tarball', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'bbb-protocol-package-'));
  try {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    execFileSync('pnpm', ['pack', '--pack-destination', temporary], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 20_000,
      stdio: 'pipe',
    });
    const archive = readdirSync(temporary).find((name) => name.endsWith('.tgz'));
    expect(archive).toBeDefined();
    const installed = join(temporary, 'node_modules/@qmd-team-intent-kb/schema');
    mkdirSync(installed, { recursive: true });
    execFileSync('tar', [
      '-xzf',
      join(temporary, archive!),
      '--strip-components=1',
      '-C',
      installed,
    ]);
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
      license: string;
    };
    expect(manifest.license).toBe('Apache-2.0');
    expect(readFileSync(join(installed, 'LICENSE'), 'utf8')).toBe(
      readFileSync(join(packageRoot, '../../LICENSE'), 'utf8'),
    );
    const require = createRequire(import.meta.url);
    const zodRoot = dirname(realpathSync(require.resolve('zod/package.json')));
    cpSync(zodRoot, join(temporary, 'node_modules/zod'), { recursive: true });
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import { generateKeyPairSync, verify } from 'node:crypto';
      import {
        classificationCanonicalJson, classificationHash, sourceProfileDigest,
        sourceClassificationSigningBytes, signSourceClassification,
        SourceClassificationPayload, SignedSourceClassification,
      } from '@qmd-team-intent-kb/schema/source-classification';
      const profile = {
        id: 'synthetic-profile', revision: 1, producerId: 'compiler',
        receiverId: 'registrar', tenantId: 'synthetic',
        context: { source: 'manual', channel: 'fixture', repository: null, principalBinding: null },
        minimumSensitivity: 'confidential',
      };
      const payload = {
        version: 1, purpose: 'source-classification-assertion-v1',
        assertionId: '22222222-2222-4222-8222-222222222222',
        producerId: 'compiler', keyId: 'fixture-key', receiverId: 'registrar', tenantId: 'synthetic',
        candidateId: '11111111-1111-4111-8111-111111111111',
        capturedAt: '2026-11-22T09:00:00.000Z',
        contentHash: classificationHash('synthetic body'), titleHash: classificationHash('fixture'),
        context: profile.context, profileId: profile.id, profileRevision: 1,
        profileDigest: sourceProfileDigest(profile),
        issuedAt: '2026-11-22T09:01:00.000Z', expiresAt: '2026-11-22T09:10:00.000Z',
      };
      assert.equal(classificationCanonicalJson({ z: [{ b: 2, a: 1 }], a: null }),
        '{"a":null,"z":[{"a":1,"b":2}]}');
      const keys = generateKeyPairSync('ed25519');
      const wire = signSourceClassification(payload, keys.privateKey);
      const signed = SignedSourceClassification.parse(JSON.parse(wire));
      assert.ok(verify(null, sourceClassificationSigningBytes(payload), keys.publicKey, Buffer.from(signed.signature, 'hex')));
      assert.equal(signSourceClassification(Object.fromEntries(Object.entries(payload).reverse()), keys.privateKey), wire);
      assert.ok(!verify(null, sourceClassificationSigningBytes({ ...payload, titleHash: classificationHash('changed') }), keys.publicKey, Buffer.from(signed.signature, 'hex')));
      assert.throws(() => SourceClassificationPayload.parse({ ...payload, selectedRole: 'admin' }));
      assert.throws(() => signSourceClassification(payload, keys.publicKey));
      console.log('isolated protocol package passed');
    `,
      ],
      { cwd: temporary, encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.trim()).toBe('isolated protocol package passed');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 30_000);
