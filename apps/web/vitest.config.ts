import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // tsconfig keeps JSX for Next; tests transform it with the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  test: { name: 'web', environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: {
    alias: {
      '@': here('./src'),
      // `server-only` throws outside a React Server environment; tests exercise the module directly.
      'server-only': here('../../test-support/empty.ts'),
    },
  },
});
