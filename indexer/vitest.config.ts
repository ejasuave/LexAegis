import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'indexer',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { ENVIO_INDEX_GENERATION: 'test-generation-0001' },
  },
});
