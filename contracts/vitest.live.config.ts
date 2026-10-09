import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * LIVE Monad-testnet run (Chapter 6, Task 15). Spends test MON through the configured Alchemy
 * endpoint, so it is opt-in and never part of `pnpm test`:
 *
 *   LEXAEGIS_LIVE=1 pnpm test:chain:live        (env from .env, exported by the caller)
 */
export default defineConfig({
  resolve: {
    alias: { '@': here('../apps/web/src'), 'server-only': here('../test-support/empty.ts') },
  },
  test: {
    name: 'chain-live',
    environment: 'node',
    include: ['live/**/*.live.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 180_000,
  },
});
