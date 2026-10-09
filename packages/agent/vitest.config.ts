import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'agent', environment: 'node' },
  resolve: {
    // `server-only` throws outside a React Server environment; tests exercise the module directly.
    alias: {
      'server-only': fileURLToPath(new URL('../../test-support/empty.ts', import.meta.url)),
    },
  },
});
