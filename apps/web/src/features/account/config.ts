import type { PublicConfig } from '@/config/public';
import { failWith, succeed, type AccountResult } from './errors';

/** Validated relying-party and chain configuration for the account feature. */
export interface AccountConfig {
  /** Exact application origin, including any port. */
  readonly origin: string;
  /** WebAuthn relying-party ID: exactly the origin's hostname, never a parent domain. */
  readonly rpId: string;
  readonly rpName: string;
  readonly chainId: string;
  /** Lowercase registry address, or null until a registry is deployed and configured. */
  readonly registryAddress: string | null;
}

const LOCALHOST = 'localhost';

/**
 * Derives the account configuration from the public configuration. The rpId must be the exact
 * hostname of the configured origin (ports belong to the origin, never to the rpId), HTTPS is
 * required except on localhost, and when the page's real origin is known it must equal the
 * configured one. A passkey made for one rpId does not recover on another.
 */
export function resolveAccountConfig(
  publicConfig: PublicConfig,
  actualOrigin?: string,
): AccountResult<AccountConfig> {
  const { appOrigin, webauthnRpId, chainId, registryAddress } = publicConfig;
  if (appOrigin === undefined || webauthnRpId === undefined || chainId === undefined) {
    return failWith('CONFIG_INVALID');
  }
  let url: URL;
  try {
    url = new URL(appOrigin);
  } catch {
    return failWith('CONFIG_INVALID');
  }
  if (url.origin !== appOrigin) return failWith('CONFIG_INVALID');
  if (url.hostname !== webauthnRpId) return failWith('CONFIG_INVALID');
  const local = url.hostname === LOCALHOST;
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return failWith('CONFIG_INVALID');
  }
  if (actualOrigin !== undefined && actualOrigin !== appOrigin) return failWith('CONFIG_INVALID');
  return succeed({
    origin: appOrigin,
    rpId: webauthnRpId,
    rpName: 'LexAegis',
    chainId,
    registryAddress: registryAddress === undefined ? null : registryAddress.toLowerCase(),
  });
}
