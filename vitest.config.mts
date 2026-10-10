import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/protocol',
      'packages/sdk',
      'packages/vault',
      'packages/agent',
      'apps/web',
      'tooling',
      'indexer',
    ],
  },
});
