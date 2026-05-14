/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  reporters: ['clear-text', 'html', 'json'],
  thresholds: {
    high: 80,
    low: 70,
    break: 70,
  },
  mutate: [
    'packages/*/src/**/*.ts',
    'apps/*/src/**/*.ts',
    '!**/__tests__/**',
    '!**/test-fixtures/**',
    '!**/*.test.ts',
    '!**/*.d.ts',
    '!**/index.ts',
  ],
  timeoutMS: 30000,
  concurrency: 4,
};
