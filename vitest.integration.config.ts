/**
 * vitest.integration.config.ts — separate config for L4 integration tests.
 *
 * Lives at repo root. Tests under tests/integration/ are excluded from the
 * fast `pnpm test` run (which uses vitest.config.ts) and only run via
 * `pnpm test:integration`. CI runs them in a separate job ('integration')
 * gated on Docker availability.
 *
 * Why a second config rather than `--testPathPattern`: integration tests
 * have different timeout, isolation, and concurrency requirements
 * (container startup is slow; tests in this directory are serialized).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
    // Container startup + image pull on cold runners can take 30s+; give
    // each test a generous ceiling.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Run integration suites serially. Multiple containers per test file
    // racing on the same host can exhaust Docker's port range and produce
    // confusing intermittent failures.
    fileParallelism: false,
  },
});
