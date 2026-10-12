import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Fast checks of the harness itself: part of `pnpm test`. The heavy specs have their own config. */
export default defineConfig({
  test: { name: 'system-harness', environment: 'node', include: ['system/harness/**/*.test.ts'] },
  resolve: {
    alias: { '@': here('../apps/web/src'), 'server-only': here('../test-support/empty.ts') },
  },
});
