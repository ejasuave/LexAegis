import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/**
 * Interoperability harness: runs the v1 protocol tests, including the shared literal vectors,
 * inside real headless Chromium so hashing uses the browser's own Web Crypto. It is a test
 * configuration only and is not part of any application route or bundle.
 *
 *   pnpm test:protocol:browser
 */
export default defineConfig({
  test: {
    name: 'protocol-browser',
    include: ['src/v1/**/*.test.ts', 'src/portable/**/*.test.ts', 'src/interop/**/*.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
  },
});
