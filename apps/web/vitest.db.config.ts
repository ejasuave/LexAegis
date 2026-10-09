import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Tests against a real PostgreSQL server (embedded-postgres, or TEST_DATABASE_URL when set).
 * Kept out of `pnpm test` because it starts a database:  pnpm test:auth:db
 */
export default defineConfig({
  test: {
    name: 'web-db',
    environment: 'node',
    include: ['src/**/*.pgtest.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: { '@': here('./src'), 'server-only': here('../../test-support/empty.ts') },
  },
});
