import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The system specs: real services (PostgreSQL, S3-compatible server, Anvil), the production web
 * build and real headless Chromium. Serialized: specs share accounts, nonces and a build.
 *
 *   pnpm test:system
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    name: 'system',
    environment: 'node',
    include: ['system/**/*.spec.ts', 'privacy/**/*.spec.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
  resolve: {
    alias: { '@': here('../apps/web/src'), 'server-only': here('../test-support/empty.ts') },
  },
});
