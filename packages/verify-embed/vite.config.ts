import { defineConfig } from 'vite';

/**
 * Two self-contained ES modules for plain HTML: a readable one and a minified one. Everything the
 * widget needs (protocol, SDK, zod, viem's encoding helpers) is bundled; nothing is fetched from a
 * CDN at run time. `emptyOutDir` is off for the second pass, so the build script runs both.
 */
const minify = process.env.EMBED_MINIFY === '1';

export default defineConfig({
  logLevel: 'warn',
  build: {
    target: 'es2022',
    lib: {
      entry: 'src/browser.ts',
      formats: ['es'],
      fileName: () => (minify ? 'proof-of-review-embed.min.js' : 'proof-of-review-embed.js'),
    },
    minify,
    sourcemap: false,
    emptyOutDir: !minify,
  },
});
