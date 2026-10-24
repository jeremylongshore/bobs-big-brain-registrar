import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const prettyRequire = createRequire(require.resolve('pino-pretty'));
const { createCopier } = prettyRequire('fast-copy');
const filterLog = prettyRequire('./lib/utils/filter-log.js');

function nested(depth: number): object {
  let value: object = { leaf: 'synthetic' };
  for (let i = 0; i < depth; i++) value = { nested: value };
  return value;
}

function errorName(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) return error.name;
    throw error;
  }
  return undefined;
}

describe('pino-pretty selected copier depth and compatibility', () => {
  it('rejects a small value at a configured depth before native stack exhaustion', () => {
    // GHSA-jggr-w7fw-pc2j; five levels suffice for a maxDepth of three.
    const copy = createCopier({ maxDepth: 3 });
    expect(errorName(() => copy(nested(5)))).toBe('MaxDepthExceededError');
  });

  it('bounds the default copier used by actual pino-pretty filtering', () => {
    // Bounded construction: about one thousand one-property objects, no timing test.
    const context = { ignoreKeys: new Set<string>() };
    expect(errorName(() => filterLog({ log: nested(1020), context }))).toBe(
      'MaxDepthExceededError',
    );
    expect(filterLog({ log: { msg: 'still usable' }, context })).toEqual({ msg: 'still usable' });
  });

  it('preserves normal filtering, input independence and circular cloning', () => {
    const log = { msg: 'fixture', private: 'omit', detail: { count: 1 } };
    const result = filterLog({ log, context: { ignoreKeys: new Set(['private']) } });
    expect(result).toEqual({ msg: 'fixture', detail: { count: 1 } });
    result.detail.count = 2;
    expect(log).toEqual({ msg: 'fixture', private: 'omit', detail: { count: 1 } });
    expect(filterLog({ log, context: { includeKeys: new Set(['msg']) } })).toEqual({
      msg: 'fixture',
    });
    const circular: { self?: object } = {};
    circular.self = circular;
    const copy = createCopier({})(circular);
    expect(copy).not.toBe(circular);
    expect(copy.self).toBe(copy);
  });
});
