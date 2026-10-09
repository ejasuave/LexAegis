import 'server-only';
import { z } from 'zod';

type EnvRecord = Readonly<Record<string, string | undefined>>;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** HTTPS endpoint without embedded credentials; plain HTTP only for loopback development. */
function isAllowedEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

const endpointSchema = z.string().refine(isAllowedEndpoint, 'must be an https URL');
const secretSchema = z.string().min(8).max(4096);
const nameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const databaseUrlSchema = z.string().refine((value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    return false;
  }
}, 'must be a postgres URL');
const flagSchema = z.enum(['true', 'false']);
/** Decimal MON amount with at most 18 fractional digits, e.g. "0.2". */
const monSchema = z.string().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,18})?$/);
const modelSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/** Single source of truth for server-only variables. Every variable is optional so shells can boot. */
export const serverEnvShape = {
  QWEN_API_KEY: secretSchema,
  QWEN_BASE_URL: endpointSchema,
  QWEN_MODEL: modelSchema,
  ALCHEMY_MONAD_RPC_URL: endpointSchema,
  ENVIO_GRAPHQL_URL: endpointSchema,
  ENVIO_API_TOKEN: secretSchema,
  DATABASE_URL: databaseUrlSchema,
  S3_ENDPOINT: endpointSchema,
  S3_BUCKET: nameSchema,
  S3_REGION: nameSchema,
  S3_ACCESS_KEY_ID: secretSchema,
  S3_SECRET_ACCESS_KEY: secretSchema,
  TESTNET_FUNDER_PRIVATE_KEY: secretSchema,
  TESTNET_DEPLOYER_PRIVATE_KEY: secretSchema,
  TESTNET_FUNDING_ENABLED: flagSchema,
  TESTNET_FUNDING_GRANT_MON: monSchema,
  TESTNET_FUNDING_DAILY_BUDGET_MON: monSchema,
  TESTNET_FUNDING_MAX_FEE_MON: monSchema,
  TESTNET_REGISTRY_MAX_FEE_MON: monSchema,
  TESTNET_DEPLOY_MAX_FEE_MON: monSchema,
  AUTH_SESSION_SECRET: secretSchema,
} as const;

export type ServerEnvKey = keyof typeof serverEnvShape;

export interface ServerConfig {
  readonly qwen: { apiKey?: string; baseUrl?: string; model?: string };
  readonly alchemy: { rpcUrl?: string };
  readonly envio: { graphqlUrl?: string; apiToken?: string };
  readonly database: { url?: string };
  readonly storage: {
    endpoint?: string;
    bucket?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  readonly funding: {
    testnetFunderPrivateKey?: string;
    enabled?: string;
    grantMon?: string;
    dailyBudgetMon?: string;
    maxFeeMon?: string;
  };
  readonly deployment: { deployerPrivateKey?: string; maxFeeMon?: string };
  readonly registryFee: { maxFeeMon?: string };
  readonly auth: { sessionSecret?: string };
}

export type ServerConfigResult =
  { ok: true; config: ServerConfig } | { ok: false; invalidKeys: ServerEnvKey[] };

/** Variable names that carry a non-empty value (empty string counts as unset). */
export function presentServerKeys(env: EnvRecord): Set<string> {
  return new Set(Object.keys(serverEnvShape).filter((key) => (env[key] ?? '') !== ''));
}

/** Variable names whose supplied value is malformed. Values are never returned. */
export function invalidServerKeys(env: EnvRecord): ServerEnvKey[] {
  return (Object.keys(serverEnvShape) as ServerEnvKey[]).filter((key) => {
    const raw = env[key];
    return raw !== undefined && raw !== '' && !serverEnvShape[key].safeParse(raw).success;
  });
}

function pick(env: EnvRecord, key: ServerEnvKey): string | undefined {
  const raw = env[key];
  return raw === undefined || raw === '' ? undefined : raw;
}

function defined<T extends Record<string, string | undefined>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: string;
  };
}

/**
 * Validates the supplied environment. Missing future-integration credentials are permitted;
 * malformed supplied values are rejected and reported by variable name only. The configured
 * model is used exactly as given and is never substituted.
 */
export function loadServerConfig(env: EnvRecord): ServerConfigResult {
  const invalidKeys = invalidServerKeys(env);
  if (invalidKeys.length > 0) return { ok: false, invalidKeys };
  return {
    ok: true,
    config: {
      qwen: defined({
        apiKey: pick(env, 'QWEN_API_KEY'),
        baseUrl: pick(env, 'QWEN_BASE_URL'),
        model: pick(env, 'QWEN_MODEL'),
      }),
      alchemy: defined({ rpcUrl: pick(env, 'ALCHEMY_MONAD_RPC_URL') }),
      envio: defined({
        graphqlUrl: pick(env, 'ENVIO_GRAPHQL_URL'),
        apiToken: pick(env, 'ENVIO_API_TOKEN'),
      }),
      database: defined({ url: pick(env, 'DATABASE_URL') }),
      storage: defined({
        endpoint: pick(env, 'S3_ENDPOINT'),
        bucket: pick(env, 'S3_BUCKET'),
        region: pick(env, 'S3_REGION'),
        accessKeyId: pick(env, 'S3_ACCESS_KEY_ID'),
        secretAccessKey: pick(env, 'S3_SECRET_ACCESS_KEY'),
      }),
      funding: defined({
        testnetFunderPrivateKey: pick(env, 'TESTNET_FUNDER_PRIVATE_KEY'),
        enabled: pick(env, 'TESTNET_FUNDING_ENABLED'),
        grantMon: pick(env, 'TESTNET_FUNDING_GRANT_MON'),
        dailyBudgetMon: pick(env, 'TESTNET_FUNDING_DAILY_BUDGET_MON'),
        maxFeeMon: pick(env, 'TESTNET_FUNDING_MAX_FEE_MON'),
      }),
      deployment: defined({
        deployerPrivateKey: pick(env, 'TESTNET_DEPLOYER_PRIVATE_KEY'),
        maxFeeMon: pick(env, 'TESTNET_DEPLOY_MAX_FEE_MON'),
      }),
      registryFee: defined({ maxFeeMon: pick(env, 'TESTNET_REGISTRY_MAX_FEE_MON') }),
      auth: defined({ sessionSecret: pick(env, 'AUTH_SESSION_SECRET') }),
    },
  };
}
