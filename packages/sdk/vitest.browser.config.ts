import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/**
 * Interoperability harness: runs the SDK's registry and verification tests, including the shared
 * literal vectors and typed-data fixtures, inside real headless Chromium so hashing and signing
 * data use the browser's own Web Crypto. Test configuration only.
 *
 *   pnpm sdk:browser
 */
export default defineConfig({
  test: {
    name: 'sdk-browser',
    include: ['src/registry/**/*.test.ts', 'src/verification/**/*.test.ts', 'src/ports.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
  },
});
