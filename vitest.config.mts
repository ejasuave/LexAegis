import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Half the cores. One Chapter 8 comparison test measures a real 2-second diff limit and
    // reports "timeout" instead of "edit distance" when every core is busy; its assertion is
    // unchanged, the suite is simply not run at full contention.
    maxWorkers: '50%',
    projects: [
      'packages/protocol',
      'packages/sdk',
      'packages/vault',
      'packages/agent',
      'apps/web',
      'tooling',
    ],
  },
});
