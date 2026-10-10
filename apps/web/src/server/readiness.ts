import 'server-only';
import type { IntegrationState } from '@lexaegis/protocol';
import { enabledFlags, type EffectiveFlags } from '@/config/flags';
import { publicEnvShape, type PublicEnvKey } from '@/config/public';
import {
  capabilityNameSchema,
  type CapabilityName,
  type CapabilityReason,
  type ReadinessReport,
} from '@/lib/readiness-schema';
import { invalidServerKeys, presentServerKeys, type ServerEnvKey } from './env';

type EnvRecord = Readonly<Record<string, string | undefined>>;

export interface CapabilityDefinition {
  readonly name: CapabilityName;
  /** True only once real code for the capability exists. Environment variables never set this. */
  readonly implemented: boolean;
  readonly serverKeys: readonly ServerEnvKey[];
  readonly publicKeys: readonly PublicEnvKey[];
}

/** A capability is `implemented` only once its code exists; chapters flip the flag with that code. */
export const CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    // Passkey accounts and backend sign-in exist. "configured" still needs a real-device check
    // before anything may call it verified.
    name: 'account.mera',
    implemented: true,
    serverKeys: ['DATABASE_URL'],
    publicKeys: ['NEXT_PUBLIC_WEBAUTHN_RP_ID', 'NEXT_PUBLIC_APP_ORIGIN', 'NEXT_PUBLIC_CHAIN_ID'],
  },
  {
    name: 'vault.storage',
    implemented: false,
    serverKeys: [
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_REGION',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ],
    publicKeys: [],
  },
  {
    // The runtime exists. Keys alone make it "configured"; "verified" needs a passing capability
    // record for the exact endpoint, model and output mode (written by pnpm qwen:smoke).
    name: 'assistant.qwen',
    implemented: true,
    serverKeys: ['QWEN_API_KEY', 'QWEN_BASE_URL', 'QWEN_MODEL', 'DATABASE_URL'],
    publicKeys: [],
  },
  { name: 'chain.rpc', implemented: false, serverKeys: ['ALCHEMY_MONAD_RPC_URL'], publicKeys: [] },
  {
    name: 'chain.registry',
    implemented: false,
    serverKeys: [],
    publicKeys: ['NEXT_PUBLIC_CHAIN_ID', 'NEXT_PUBLIC_REGISTRY_ADDRESS'],
  },
  {
    name: 'history.envio',
    implemented: false,
    serverKeys: ['ENVIO_GRAPHQL_URL'],
    publicKeys: [],
  },
  { name: 'database.postgres', implemented: true, serverKeys: ['DATABASE_URL'], publicKeys: [] },
  {
    name: 'storage.s3',
    implemented: false,
    serverKeys: [
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_REGION',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ],
    publicKeys: [],
  },
];

export interface ReadinessInputs {
  readonly env: EnvRecord;
  readonly capabilities?: readonly CapabilityDefinition[];
  /** Capabilities whose live verification has actually succeeded. Chapter 1 has none. */
  readonly verified?: ReadonlySet<CapabilityName>;
  /** Effective feature flags; omitted means every optional feature is off. */
  readonly flags?: EffectiveFlags;
}

function invalidPublicKeys(env: EnvRecord): Set<string> {
  return new Set(
    (Object.keys(publicEnvShape) as PublicEnvKey[]).filter((key) => {
      const raw = env[key];
      return raw !== undefined && raw !== '' && !publicEnvShape[key].safeParse(raw).success;
    }),
  );
}

function evaluate(
  definition: CapabilityDefinition,
  env: EnvRecord,
  invalid: Set<string>,
  presentServer: Set<string>,
  verified: ReadonlySet<CapabilityName>,
): { state: IntegrationState; reason: CapabilityReason } {
  if (!definition.implemented) return { state: 'unimplemented', reason: 'NOT_IMPLEMENTED' };
  const keys = [...definition.serverKeys, ...definition.publicKeys];
  if (keys.some((key) => invalid.has(key))) return { state: 'blocked', reason: 'CONFIG_INVALID' };
  const missing =
    definition.serverKeys.some((key) => !presentServer.has(key)) ||
    definition.publicKeys.some((key) => (env[key] ?? '') === '');
  if (missing) return { state: 'unconfigured', reason: 'NOT_CONFIGURED' };
  // A configured integration is not automatically verified.
  if (!verified.has(definition.name)) return { state: 'configured', reason: 'UNVERIFIED' };
  return { state: 'verified', reason: 'OK' };
}

/**
 * Readiness reflects implementation and verification evidence. The mere presence of an
 * environment variable can at most produce `configured`, never `verified`.
 */
export function buildReadinessReport(inputs: ReadinessInputs, requestId: string): ReadinessReport {
  const { env, capabilities = CAPABILITIES, verified = new Set<CapabilityName>(), flags } = inputs;
  const invalid = new Set<string>([...invalidServerKeys(env), ...invalidPublicKeys(env)]);
  const presentServer = presentServerKeys(env);
  const results = capabilities.map((definition) => ({
    name: capabilityNameSchema.parse(definition.name),
    ...evaluate(definition, env, invalid, presentServer, verified),
  }));
  const allVerified = results.length > 0 && results.every((item) => item.state === 'verified');
  return {
    status: allVerified ? 'ready' : 'unavailable',
    requestId,
    optionalFeatures: flags === undefined ? [] : enabledFlags(flags),
    capabilities: results,
  };
}
