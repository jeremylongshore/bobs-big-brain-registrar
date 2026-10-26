import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const rootRequire = createRequire(join(repo, 'package.json'));
const strykerRequire = createRequire(rootRequire.resolve('@stryker-mutator/core'));
const clientRequire = createRequire(strykerRequire.resolve('typed-rest-client'));
const qs = clientRequire('qs');
const client = clientRequire('./Util.js');
const appRequire = createRequire(join(repo, 'apps/mcp-server/package.json'));
const qmdRequire = createRequire(realpathSync(join(repo, 'node_modules/@tobilu/qmd/package.json')));
const sdkRequires = [appRequire, qmdRequire].map((require) =>
  createRequire(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')),
);
const apiRequire = createRequire(join(repo, 'apps/api/package.json'));
const fastifyRequire = createRequire(apiRequire.resolve('fastify'));
const uriParents = [
  { label: 'Stryker AJV', consumer: strykerRequire, name: 'ajv', major: 3, range: '^3.0.1' },
  { label: 'app SDK AJV', consumer: sdkRequires[0]!, name: 'ajv', major: 3, range: '^3.0.1' },
  { label: 'qmd SDK AJV', consumer: sdkRequires[1]!, name: 'ajv', major: 3, range: '^3.0.1' },
  {
    label: 'Fastify validator',
    consumer: fastifyRequire,
    name: '@fastify/ajv-compiler',
    major: 4,
    range: '^4.0.0',
  },
  {
    label: 'Fastify serializer',
    consumer: fastifyRequire,
    name: 'fast-json-stringify',
    major: 4,
    range: '^4.0.0',
  },
  {
    label: 'Swagger resolver',
    consumer: createRequire(apiRequire.resolve('@fastify/swagger')),
    name: 'json-schema-resolver',
    major: 3,
    range: '^3.0.5',
  },
].map(({ consumer, name, ...contract }) => {
  const metadata = consumer(`${name}/package.json`);
  const require = createRequire(consumer.resolve(`${name}/package.json`));
  return { ...contract, metadata, require };
});

describe('Stryker-selected qs security and URL compatibility', () => {
  it('preserves repeated query values and scalar encoding through the real client', () => {
    expect(
      client.getUrl('/fixture', 'https://fixture.invalid', {
        params: { tag: ['one', 'two'], name: 'a b' },
      }),
    ).toBe('https://fixture.invalid/fixture?tag=one&tag=two&name=a%20b');
  });

  it.each([null, undefined])('serializes comma entries containing %s', (value) => {
    // GHSA-q8mj-m7cp-5q26; the real client sets encodeValuesOnly.
    expect(
      client.getUrl('/fixture', 'https://fixture.invalid', {
        params: { tag: [value, 'two'] },
        options: { arrayFormat: 'comma' },
      }),
    ).toBe('https://fixture.invalid/fixture?tag=,two');
  });

  it('enforces the bracket-key comma limit with only four elements', () => {
    // GHSA-x5fp-wj9c-mxmx is the later bracket-key bypass, not an alias of
    // GHSA-w7fw-mjwx-w883's earlier flat-key comma bypass.
    const options = { comma: true, arrayLimit: 3, throwOnLimitExceeded: true };
    expect(() => qs.parse('tag=a,b,c,d', options)).toThrow(RangeError);
    expect(() => qs.parse('tag[]=a,b,c,d', options)).toThrow(RangeError);
  });

  it('round-trips an untrusted constructor key as data', () => {
    // GHSA-4mjr-xmp4-gh2g; no attacker callable or prototype mutation.
    const parsed = qs.parse('item[constructor][isBuffer]=value', { plainObjects: true });
    expect(qs.stringify(parsed)).toBe('item%5Bconstructor%5D%5BisBuffer%5D=value');
  });
});

describe('actual parent-selected URI parser bindings', () => {
  it.each(uriParents)('$label keeps its requested patched parser major', (parent) => {
    expect(parent.metadata.dependencies['fast-uri']).toBe(parent.range);
    const version: string = parent.require('fast-uri/package.json').version;
    const [major, minor, patch] = version.split('.').map(Number);
    expect(major).toBe(parent.major);
    const [floorMinor, floorPatch] = parent.major === 3 ? [1, 9] : [2, 3];
    expect(minor! > floorMinor! || (minor === floorMinor && patch! >= floorPatch!)).toBe(true);
    const sameMajor = uriParents.find((other) => other.major === parent.major)!;
    expect(parent.require.resolve('fast-uri')).toBe(sameMajor.require.resolve('fast-uri'));
    expect(parent.require('fast-uri')).toBe(sameMajor.require('fast-uri'));
  });

  it('keeps the independently selected major lines distinct', () => {
    expect(uriParents[0]!.require.resolve('fast-uri')).not.toBe(
      uriParents[3]!.require.resolve('fast-uri'),
    );
  });
});

// Exercise every existing advisory assertion on each actual selected major.
// The six parent bindings above separately prove which consumer receives it.
describe.each([uriParents[0]!, uriParents[3]!])('$label URI parser contracts', (parent) => {
  const uri = parent.require('fast-uri');

  it.each(['%6Aavascript:alert(1)', '%u006Aavascript:alert(1)'])(
    'does not activate an encoded scheme (%s)',
    (input) => {
      // GHSA-w74x-v6f9-j3xg.
      expect(uri.parse(input).error).toBeTruthy();
      expect(uri.normalize(input)).toBe(input);
      expect(uri.equal('%68ttp://fixture.invalid/', 'http://fixture.invalid/')).toBe(false);
    },
  );

  it('keeps a relative reference pointed at the same resource after normalization', () => {
    // GHSA-xhq7-xmqj-769h.
    const base = 'https://fixture.invalid/a/b/';
    expect(uri.resolve(base, uri.normalize('../x'))).toBe(uri.resolve(base, '../x'));
    expect(uri.resolve(base, uri.normalize('a/../b'))).toBe(uri.resolve(base, 'a/../b'));
  });

  it.each([
    'http://a@b@evil.invalid/',
    'http://fi\txture.invalid/',
    'http://fi\rxture.invalid/',
    'http://fi\nxture.invalid/',
  ])('refuses a host that another parser would silently rewrite (%j)', (input) => {
    // GHSA-wjr9-j795-jxcr; this never performs a request.
    expect(uri.parse(input).error).toBeTruthy();
    expect(uri.normalize(input)).toBe(input);
  });

  it.each([undefined, 'fixture'])(
    'escapes the first-segment colon in a suffix reference (%s)',
    (scheme) => {
      // GHSA-333x-w4r6-6crp.
      const result = uri.serialize(
        { scheme, path: 'javascript:alert(1)' },
        { reference: 'suffix' },
      );
      expect(result).toBe('javascript%3Aalert(1)');
      expect(uri.parse(result).scheme).toBeUndefined();
    },
  );

  it('preserves ordinary absolute and relative URI behavior', () => {
    expect(uri.normalize('HTTPS://FIXTURE.INVALID/a')).toBe('https://fixture.invalid/a');
    expect(uri.resolve('https://fixture.invalid/schema/root.json', './value.json')).toBe(
      'https://fixture.invalid/schema/value.json',
    );
  });
});

describe('SDK-selected IPv6 dependency security and parent compatibility', () => {
  it.each(['app', 'qmd'])(
    'rejects a tiny adversarial zone without the vulnerable scan (%s)',
    (name) => {
      const index = name === 'app' ? 0 : 1;
      const require = sdkRequires[index]!;
      const rateRequire = createRequire(require.resolve('express-rate-limit'));
      const addressEntry = rateRequire.resolve('ip-address');
      const worker = fileURLToPath(new URL('./fixtures/ip-zone-security.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [worker, addressEntry], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        forbiddenScans: 0,
        constructorAddressError: true,
        invalidRejected: true,
        restored: true,
        normalZone: true,
      });
    },
  );

  it.each(sdkRequires)('preserves actual rate-limit IPv6 key behavior', (require) => {
    const rate = require('express-rate-limit');
    expect(rate.ipKeyGenerator('192.0.2.1')).toBe('192.0.2.1');
    expect(rate.ipKeyGenerator('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(rate.ipKeyGenerator('2001:db8:abcd:12ff::1', 56)).toBe('2001:db8:abcd:1200::/56');
    // net.isIPv6 prefilters malformed strings before Address6 in this parent.
    // The direct-dependency regression above is not a BBB HTTP exposure claim.
    expect(rate.ipKeyGenerator('%%%\n')).toBe('%%%\n');
  });
});
