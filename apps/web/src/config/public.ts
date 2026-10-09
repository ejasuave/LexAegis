import { z } from 'zod';
import { chainIdSchema, evmAddressSchema } from '@lexaegis/protocol';

/** Origin only: scheme and host (and port), no path, query or trailing slash. */
const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}, 'must be an origin such as https://example.com');

/** WebAuthn RP ID is a bare hostname: no scheme, port or path. */
const rpIdSchema = z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'must be a bare hostname');

/**
 * Explicit allowlist of values that may reach the browser. Anything not listed here is not
 * exposed, regardless of what the process environment contains.
 */
export const publicEnvShape = {
  NEXT_PUBLIC_APP_ORIGIN: originSchema,
  NEXT_PUBLIC_VERIFIER_ORIGIN: originSchema,
  NEXT_PUBLIC_WEBAUTHN_RP_ID: rpIdSchema,
  NEXT_PUBLIC_CHAIN_ID: chainIdSchema,
  NEXT_PUBLIC_REGISTRY_ADDRESS: evmAddressSchema,
} as const;

export type PublicEnvKey = keyof typeof publicEnvShape;

export interface PublicConfig {
  readonly appOrigin?: string;
  readonly verifierOrigin?: string;
  readonly webauthnRpId?: string;
  readonly chainId?: string;
  readonly registryAddress?: string;
}

export type PublicConfigResult =
  { ok: true; config: PublicConfig } | { ok: false; invalidKeys: PublicEnvKey[] };

type EnvRecord = Readonly<Record<string, string | undefined>>;

/** Next.js inlines NEXT_PUBLIC_* only for static `process.env.NAME` references. */
export function readPublicEnv(): EnvRecord {
  return {
    NEXT_PUBLIC_APP_ORIGIN: process.env.NEXT_PUBLIC_APP_ORIGIN,
    NEXT_PUBLIC_VERIFIER_ORIGIN: process.env.NEXT_PUBLIC_VERIFIER_ORIGIN,
    NEXT_PUBLIC_WEBAUTHN_RP_ID: process.env.NEXT_PUBLIC_WEBAUTHN_RP_ID,
    NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
    NEXT_PUBLIC_REGISTRY_ADDRESS: process.env.NEXT_PUBLIC_REGISTRY_ADDRESS,
  };
}

/** Empty strings are treated as unset. Malformed values are reported by variable name only. */
export function loadPublicConfig(env: EnvRecord): PublicConfigResult {
  const invalidKeys: PublicEnvKey[] = [];
  const values: Partial<Record<PublicEnvKey, string>> = {};
  for (const key of Object.keys(publicEnvShape) as PublicEnvKey[]) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    if (publicEnvShape[key].safeParse(raw).success) values[key] = raw;
    else invalidKeys.push(key);
  }
  if (invalidKeys.length > 0) return { ok: false, invalidKeys };
  return {
    ok: true,
    config: {
      ...(values.NEXT_PUBLIC_APP_ORIGIN && { appOrigin: values.NEXT_PUBLIC_APP_ORIGIN }),
      ...(values.NEXT_PUBLIC_VERIFIER_ORIGIN && {
        verifierOrigin: values.NEXT_PUBLIC_VERIFIER_ORIGIN,
      }),
      ...(values.NEXT_PUBLIC_WEBAUTHN_RP_ID && { webauthnRpId: values.NEXT_PUBLIC_WEBAUTHN_RP_ID }),
      ...(values.NEXT_PUBLIC_CHAIN_ID && { chainId: values.NEXT_PUBLIC_CHAIN_ID }),
      ...(values.NEXT_PUBLIC_REGISTRY_ADDRESS && {
        registryAddress: values.NEXT_PUBLIC_REGISTRY_ADDRESS,
      }),
    },
  };
}
