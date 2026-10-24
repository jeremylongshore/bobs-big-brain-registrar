import { defineConfig } from 'vitest/config';

// Explicit invocation only. No opt-in flags or live paths are supplied here:
// each selected suite must receive and validate its own operator configuration.
export default defineConfig({
  test: {
    include: [
      'packages/qmd-adapter/src/__tests__/dense-live-integration.test.ts',
      'packages/qmd-adapter/src/__tests__/rerank-live-integration.test.ts',
      'packages/qmd-adapter/src/__tests__/eval-retrieval-live.test.ts',
    ],
    env: { TEAMKB_TEST_LIVE_LANE: '1' },
  },
});
