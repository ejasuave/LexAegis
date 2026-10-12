import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  reactStrictMode: true,
  // The browser check builds into its own directory so it never replaces the normal build.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  // The production image sets NEXT_OUTPUT=standalone. Route handlers stay on the Node runtime.
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? { output: 'standalone' as const, outputFileTracingRoot: path.resolve(process.cwd(), '../..') }
    : {}),
  transpilePackages: ['@lexaegis/agent', '@lexaegis/protocol', '@lexaegis/sdk', '@lexaegis/vault'],
  turbopack: { root: path.resolve(process.cwd(), '../..') },
  // The nonce-based Content Security Policy is set per request in src/proxy.ts.
  headers: () =>
    Promise.resolve([
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value:
              'publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(self), geolocation=(), payment=()',
          },
        ],
      },
    ]),
};

export default config;
