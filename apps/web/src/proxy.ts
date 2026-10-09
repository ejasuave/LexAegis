import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content Security Policy with a per-request nonce (the official Next.js approach). Scripts run
 * only with the nonce or when loaded by a nonced script; there is no blanket 'unsafe-inline' or
 * 'unsafe-eval' in production. Connections go to this origin only, so provider traffic stays
 * behind server routes. Framing and plugins are blocked.
 *
 * This limits injection. It does not isolate the in-memory signing key from a script that does
 * run on this origin: a compromised page or dependency can still use a live session.
 */
export function buildContentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    "default-src 'self'",
    // React needs eval in development only, for error overlays.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' ${development ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  // Pages carry account state and, later, legal content: never cached or stored by intermediaries.
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
