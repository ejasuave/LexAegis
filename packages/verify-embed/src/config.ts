import { z } from 'zod';
import { parseRpcEndpoint } from '@lexaegis/sdk/verify';
import { registryPolicySchema, type RegistryPolicy } from '@lexaegis/sdk/offline';

/*
 * Host configuration: the only source of trust for the widget. Markup (an address, a chain ID, an
 * rpc-url), a package's own declarations and an RPC response can never establish a deployment, an
 * endpoint or an origin. The host passes explicit records; anything missing yields `unknown`.
 */

/** Widget transport limits. They are tighter than or equal to the SDK's own budget, never looser. */
export const EMBED_LIMITS = Object.freeze({
  /** Whole status refresh, in milliseconds. */
  refreshMs: 15_000,
  /** Underlying RPC attempts in one refresh (the SDK allows one transient retry per read). */
  refreshAttempts: 12,
  /** The whole package download, in milliseconds. */
  packageMs: 30_000,
});

const deploymentSchema = z.strictObject({
  /** A deployment record you trust, from your own copy of the deployment record. */
  policy: registryPolicySchema,
  /** The public JSON-RPC endpoint this host uses for that deployment. HTTPS, no credentials. */
  rpcUrl: z.string().min(1).max(2048),
});

export const hostConfigSchema = z.strictObject({
  deployments: z.array(deploymentSchema).min(1).max(8),
  /** Origins an `rpc-url` attribute may name, in addition to the deployments' own endpoints. */
  rpcOrigins: z.array(z.string().min(1).max(2048)).max(8).optional(),
  /** Origins a `package-url` attribute may use. Absent: the Check files action is unavailable. */
  packageOrigins: z.array(z.string().min(1).max(2048)).max(8).optional(),
  /** Local testing only: permits http://127.0.0.1, http://localhost and http://[::1]. */
  allowLoopbackHttp: z.boolean().optional(),
});
export type ProofOfReviewHostConfig = z.input<typeof hostConfigSchema>;

export const CONFIG_REASONS = [
  'CONFIG_MISSING',
  'CONFIG_INVALID',
  'CONFIG_RPC_REJECTED',
  'CONFIG_ORIGIN_REJECTED',
  'CONFIG_DUPLICATE_DEPLOYMENT',
] as const;
export type ConfigReason = (typeof CONFIG_REASONS)[number];

export interface ResolvedDeployment {
  readonly policy: RegistryPolicy;
  readonly rpcUrl: string;
}

/** An immutable, validated snapshot. A refresh captures one and never sees a later change. */
export interface ResolvedConfig {
  readonly deployments: ReadonlyMap<string, ResolvedDeployment>;
  readonly rpcOrigins: ReadonlySet<string>;
  readonly packageOrigins: ReadonlySet<string>;
  readonly allowLoopbackHttp: boolean;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: ResolvedConfig }
  | { readonly ok: false; readonly reason: ConfigReason };

export const deploymentKey = (chainId: string, registryAddress: string): string =>
  `${chainId}:${registryAddress}`;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A bare origin: scheme and host only, no credentials, path, query or fragment. */
export function parseOrigin(value: string, allowLoopbackHttp: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopbackHttp = url.protocol === 'http:' && allowLoopbackHttp && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== ''))
    return null;
  return url.origin;
}

export function resolveHostConfig(input: unknown): ConfigResult {
  if (input === undefined || input === null) return { ok: false, reason: 'CONFIG_MISSING' };
  const parsed = hostConfigSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'CONFIG_INVALID' };
  const allowLoopbackHttp = parsed.data.allowLoopbackHttp === true;
  const deployments = new Map<string, ResolvedDeployment>();
  const rpcOrigins = new Set<string>();
  for (const item of parsed.data.deployments) {
    const endpoint = parseRpcEndpoint(item.rpcUrl, { allowLoopbackHttp });
    if (!endpoint.ok) return { ok: false, reason: 'CONFIG_RPC_REJECTED' };
    const key = deploymentKey(item.policy.chainId, item.policy.registryAddress);
    if (deployments.has(key)) return { ok: false, reason: 'CONFIG_DUPLICATE_DEPLOYMENT' };
    deployments.set(key, Object.freeze({ policy: item.policy, rpcUrl: endpoint.url }));
    rpcOrigins.add(endpoint.origin);
  }
  for (const value of parsed.data.rpcOrigins ?? []) {
    const origin = parseOrigin(value, allowLoopbackHttp);
    if (origin === null) return { ok: false, reason: 'CONFIG_ORIGIN_REJECTED' };
    rpcOrigins.add(origin);
  }
  const packageOrigins = new Set<string>();
  for (const value of parsed.data.packageOrigins ?? []) {
    const origin = parseOrigin(value, allowLoopbackHttp);
    if (origin === null) return { ok: false, reason: 'CONFIG_ORIGIN_REJECTED' };
    packageOrigins.add(origin);
  }
  return {
    ok: true,
    config: Object.freeze({
      deployments,
      rpcOrigins,
      packageOrigins,
      allowLoopbackHttp,
    }),
  };
}

type Listener = () => void;

/**
 * The page-wide configuration holder. Setting it performs no I/O; it only notifies connected
 * elements, which discard older generations and re-read under the new snapshot.
 */
let current: ConfigResult = { ok: false, reason: 'CONFIG_MISSING' };
let revision = 0;
const listeners = new Set<Listener>();

export function setHostConfig(input: unknown): ConfigResult {
  current = resolveHostConfig(input);
  revision += 1;
  for (const listener of [...listeners]) listener();
  return current;
}

export const getHostConfig = (): { readonly result: ConfigResult; readonly revision: number } => ({
  result: current,
  revision,
});

export function subscribeHostConfig(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
