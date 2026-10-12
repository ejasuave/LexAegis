import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/**
 * Runs the vault's crypto, catalog, frozen-review and export tests inside real headless Chromium, so
 * HKDF, AES-GCM and hashing use the browser's own Web Crypto instead of Node's. Test configuration
 * only.
 *
 *   pnpm vault:browser
 */
export default defineConfig({
  test: {
    name: 'vault-browser',
    include: ['src/**/*.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
  },
});
