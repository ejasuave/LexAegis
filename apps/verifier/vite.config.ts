import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * The page's Content-Security-Policy is built from the same public list of registry endpoints the
 * app allows, so the policy and the app cannot disagree and a script cannot reach elsewhere.
 * Only VITE_-prefixed values reach the bundle; none of them may be secret.
 */
function contentSecurityPolicy(origins: readonly string[]): Plugin {
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "worker-src 'self'",
    "img-src 'self' data:",
    `connect-src ${["'self'", ...origins].join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return {
    name: 'verifier-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'VITE_');
  const defaultRpc = new URL(env.VITE_RPC_URL ?? 'https://testnet-rpc.monad.xyz/').origin;
  const listed = (env.VITE_RPC_ALLOWED_ORIGINS ?? '')
    .split(/[\s,]+/)
    .filter((item) => /^https:\/\/[^/?#@]+$/.test(item));
  return {
    plugins: [react(), contentSecurityPolicy([...new Set([defaultRpc, ...listed])])],
    envDir: '../..',
    server: { host: '127.0.0.1' },
    worker: { format: 'es' },
    build: { sourcemap: false },
  };
});
