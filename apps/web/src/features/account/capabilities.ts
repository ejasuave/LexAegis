export interface CapabilityReport {
  readonly state: 'available' | 'unsupported';
  readonly missing: readonly (
    'secure-context' | 'credentials' | 'public-key-credential' | 'web-crypto'
  )[];
}

interface CapabilityScope {
  readonly isSecureContext?: boolean;
  readonly navigator?: { readonly credentials?: unknown };
  readonly PublicKeyCredential?: unknown;
  readonly crypto?: { readonly getRandomValues?: unknown; readonly subtle?: unknown };
}

/**
 * Preliminary feature detection only. "available" means a passkey ceremony can be attempted;
 * only a completed ceremony shows that PRF actually works. No platform-authenticator probe is
 * made, so an external or synced passkey is never rejected up front.
 */
export function detectCapabilities(scope: CapabilityScope = globalThis): CapabilityReport {
  const missing: CapabilityReport['missing'][number][] = [];
  if (scope.isSecureContext !== true) missing.push('secure-context');
  if (scope.navigator?.credentials === undefined) missing.push('credentials');
  if (typeof scope.PublicKeyCredential !== 'function') missing.push('public-key-credential');
  if (typeof scope.crypto?.getRandomValues !== 'function' || scope.crypto.subtle === undefined) {
    missing.push('web-crypto');
  }
  return { state: missing.length === 0 ? 'available' : 'unsupported', missing };
}
