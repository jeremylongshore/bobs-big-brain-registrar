import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/dist/**',
      '**/node_modules/**',
      '.claude/worktrees/**',
      // L4 integration suite has its own config (vitest.integration.config.ts).
      // It pulls Docker images via testcontainers — keep out of the fast loop.
      'tests/integration/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 75,
        statements: 80,
      },
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        '**/__tests__/**',
        '**/test-fixtures/**',
        '**/*.test.ts',
        '**/*.d.ts',
        '.claude/**',
      ],
    },
  },
});
