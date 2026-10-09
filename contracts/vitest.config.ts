import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Local compatibility harness: runs the TypeScript SDK against the compiled registry on a
 * throwaway Anvil chain. It needs the pinned Foundry toolchain, so it is not part of `pnpm test`.
 *
 *   pnpm test:contracts:integration
 */
export default defineConfig({
  // The account-signing test drives the web application's account modules, which use its alias.
  resolve: {
    alias: { '@': here('../apps/web/src'), 'server-only': here('../test-support/empty.ts') },
  },
  test: {
    name: 'contracts-integration',
    environment: 'node',
    include: ['integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
