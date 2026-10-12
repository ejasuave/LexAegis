import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/protocol',
      'packages/sdk',
      'packages/cli',
      'packages/vault',
      'packages/verify-embed',
      'examples/ai-pr-signoff',
      'packages/agent',
      'apps/web',
      'apps/verifier',
      'examples/document-review',
      'tooling',
      'indexer',
    ],
  },
});
