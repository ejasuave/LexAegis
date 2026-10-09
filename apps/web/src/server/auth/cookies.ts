/** Cookie handling for backend login. The session cookie is opaque: it cannot sign or decrypt anything. */

export interface CookieNames {
  readonly session: string;
  readonly preauth: string;
}

/**
 * `__Host-` names (which browsers accept only with Secure, Path=/ and no Domain) on HTTPS. The
 * plain names exist solely for http://localhost development, where `__Host-` cannot be set.
 */
export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { session: '__Host-lexaegis_session', preauth: '__Host-lexaegis_preauth' }
    : { session: 'lexaegis_session', preauth: 'lexaegis_preauth' };
}

const TOKEN = /^[0-9a-f]{64}$/;

/** Reads only well-formed 256-bit hex tokens; anything else is treated as absent. */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null || header.length > 8192) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return TOKEN.test(value) ? value : null;
  }
  return null;
}

/** HttpOnly, SameSite=Strict, Path=/, no Domain; Secure whenever the origin is HTTPS. */
export function serializeCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${String(maxAgeSeconds)}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', 0, secure);
}
