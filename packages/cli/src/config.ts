import {
  MONAD_EXECUTION_DELAY_BLOCKS,
  MONAD_EXECUTION_DELAY_REVISION,
  REGISTRY_PROTOCOL_VERSION,
  registryDeploymentSchema,
} from '@lexaegis/sdk/registry';
import { registryPolicySchema, type RegistryPolicy } from '@lexaegis/sdk';
import { parseRpcEndpoint } from '@lexaegis/sdk/verify';
import { readBoundedFile } from './files.js';
import { KNOWN_DEPLOYMENTS } from './known-deployments.generated.js';
import type { CliErrorCode } from './exit.js';

/*
 * Trust configuration. A deployment pin comes from the caller (--deployment) or from the verified
 * public deployment this build ships. It is never taken from an imported package or from the RPC
 * response it would authenticate: an address that merely answers is not registry identity.
 */

/** Largest deployment or reference file accepted. */
export const MAX_SMALL_FILE_BYTES = 64 * 1024;

export const RPC_ENV = 'PROOF_OF_REVIEW_RPC_URL';

export type Configured<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CliErrorCode; readonly subject?: string };

export interface ResolvedPolicy {
  readonly policy: RegistryPolicy;
  readonly source: 'deployment-file' | 'known-deployment';
  /** Public endpoint recorded with a known deployment; used only when the caller names none. */
  readonly publicRpcUrl: string | null;
}

const bad = (code: CliErrorCode, subject?: string): Configured<never> =>
  subject === undefined ? { ok: false, code } : { ok: false, code, subject };

/** Builds the trusted policy from a deployment record or a policy file given with --deployment. */
export async function readDeployment(path: string): Promise<Configured<RegistryPolicy>> {
  const file = await readBoundedFile(path, MAX_SMALL_FILE_BYTES);
  if (!file.ok) return bad(file.code, '--deployment');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
  } catch {
    return bad('DEPLOYMENT_FILE_INVALID', '--deployment');
  }
  const policy = registryPolicySchema.safeParse(parsed);
  if (policy.success) return { ok: true, value: policy.data };

  const record = registryDeploymentSchema.safeParse(parsed);
  if (!record.success) return bad('DEPLOYMENT_FILE_INVALID', '--deployment');
  if (record.data.status !== 'deployed') return bad('DEPLOYMENT_PINS_MISSING', '--deployment');
  // The genesis hash is the pin that distinguishes this chain from another with the same ID.
  if (record.data.genesisHash === undefined) return bad('DEPLOYMENT_PINS_MISSING', '--deployment');
  const candidate = registryPolicySchema.safeParse({
    id: `deployment-file.${record.data.chainId}`,
    chainId: record.data.chainId,
    genesisHash: record.data.genesisHash,
    registryAddress: record.data.registryAddress,
    protocolVersion: REGISTRY_PROTOCOL_VERSION,
    deploymentBlock: record.data.blockNumber,
    deploymentTransactionHash: record.data.transactionHash,
    runtimeCodeKeccak256: record.data.runtimeCodeKeccak256,
    executionDelayBlocks: MONAD_EXECUTION_DELAY_BLOCKS,
    executionDelayRevision: MONAD_EXECUTION_DELAY_REVISION,
  });
  return candidate.success
    ? { ok: true, value: candidate.data }
    : bad('DEPLOYMENT_FILE_INVALID', '--deployment');
}

function knownDeployment(chainId: string, registryAddress: string): ResolvedPolicy | null {
  for (const entry of KNOWN_DEPLOYMENTS) {
    const policy = registryPolicySchema.safeParse(entry.policy);
    if (
      policy.success &&
      policy.data.chainId === chainId &&
      policy.data.registryAddress === registryAddress
    ) {
      return { policy: policy.data, source: 'known-deployment', publicRpcUrl: entry.publicRpcUrl };
    }
  }
  return null;
}

/**
 * Resolves the trusted deployment for the caller's chain and registry. `null` means no pin exists:
 * a live check cannot honestly run. A --deployment that names a different chain or registry than the
 * command line is contradictory configuration, not something to reconcile silently.
 */
export async function resolvePolicy(input: {
  readonly chainId: string;
  readonly registryAddress: string;
  readonly deploymentPath: string | undefined;
}): Promise<Configured<ResolvedPolicy | null>> {
  if (input.deploymentPath !== undefined) {
    const loaded = await readDeployment(input.deploymentPath);
    if (!loaded.ok) return loaded;
    if (
      loaded.value.chainId !== input.chainId ||
      loaded.value.registryAddress !== input.registryAddress
    ) {
      return bad('CONFIG_CONTRADICTORY', '--deployment');
    }
    return {
      ok: true,
      value: { policy: loaded.value, source: 'deployment-file', publicRpcUrl: null },
    };
  }
  return { ok: true, value: knownDeployment(input.chainId, input.registryAddress) };
}

export interface ResolvedRpc {
  readonly url: string;
  readonly source: 'flag' | 'environment' | 'known-public';
}

/**
 * RPC precedence: --rpc, then PROOF_OF_REVIEW_RPC_URL, then the public endpoint recorded with a
 * verified known deployment. There is no invented default and no silent fallback after a bad
 * value: a malformed explicit choice is an error, never replaced by the next source.
 */
export function resolveRpc(input: {
  readonly flag: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly known: ResolvedPolicy | null;
  readonly allowLoopbackHttp: boolean;
}): Configured<ResolvedRpc | null> {
  const choices: readonly (readonly [string | undefined, ResolvedRpc['source'], string])[] = [
    [input.flag, 'flag', '--rpc'],
    [input.env[RPC_ENV], 'environment', RPC_ENV],
    [input.known?.publicRpcUrl ?? undefined, 'known-public', 'known deployment'],
  ];
  for (const [value, source, subject] of choices) {
    if (value === undefined || value === '') continue;
    const endpoint = parseRpcEndpoint(value, { allowLoopbackHttp: input.allowLoopbackHttp });
    // Only the option or variable NAME is reported, never the URL: it may carry a key.
    if (!endpoint.ok) return bad('RPC_ENDPOINT_INVALID', subject);
    return { ok: true, value: { url: endpoint.url, source } };
  }
  return { ok: true, value: null };
}
