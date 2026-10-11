import {
  decodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from 'viem';

/*
 * Read-only availability probe for the ERC-8004 Identity and Reputation registries. It only issues
 * eth_chainId, eth_getBlockByNumber, eth_getCode, eth_getStorageAt and eth_call. It loads no key,
 * connects no wallet, signs nothing and sends no transaction. Every result is per network and per
 * registry; anything unresolved is "unknown", never "unavailable".
 */

export const EXECUTION_DELAY_BLOCKS = 3;
export const LIMITS = Object.freeze({ callMs: 5_000, attempts: 32, runtimeMs: 120_000 });

const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ERC721_INTERFACE_ID = '0x80ac58cd';
const MAX_UINT256 = 2n ** 256n - 1n;

const identityAbi = parseAbi([
  'function getVersion() pure returns (string)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
]);
const reputationAbi = parseAbi([
  'function getVersion() pure returns (string)',
  'function getIdentityRegistry() view returns (address)',
]);
/** ERC721NonexistentToken(uint256): the implementation's known "no such agent" result. */
export const NONEXISTENT_TOKEN_SELECTOR = toFunctionSelector('ERC721NonexistentToken(uint256)');

export interface Target {
  readonly network: 'monad-testnet' | 'monad-mainnet';
  readonly chainId: number;
  /** Candidate addresses from the dated documentation. They are not assumed to work. */
  readonly identityRegistry: string;
  readonly reputationRegistry: string;
}

export type RegistryStatus = 'verified' | 'absent' | 'incompatible' | 'unknown';

export interface Observation {
  readonly name: string;
  readonly outcome: 'ok' | 'revert' | 'error';
  readonly detail: string;
}

export interface RegistryResult {
  readonly registry: 'identity' | 'reputation';
  readonly address: string;
  readonly status: RegistryStatus;
  readonly reasons: readonly string[];
  readonly codeKeccak256: string | null;
  /** EIP-1967 implementation observation. A proxy-code hash alone does not certify logic. */
  readonly implementation: {
    readonly address: string;
    readonly codeKeccak256: string | null;
  } | null;
  readonly version: string | null;
  readonly linkedIdentityRegistry: string | null;
  readonly observations: readonly Observation[];
}

export interface NetworkResult {
  readonly network: Target['network'];
  readonly chainId: number;
  /** Safe identifier: origin only, never a path, query or credential. */
  readonly endpoint: string;
  readonly status: 'checked' | 'unknown';
  readonly reasons: readonly string[];
  readonly checkpoint: { readonly blockNumber: string; readonly blockHash: string } | null;
  readonly identity: RegistryResult | null;
  readonly reputation: RegistryResult | null;
  /** Both registries verified and correctly related at one checkpoint. */
  readonly full: boolean | 'unknown';
}

export interface Endpoint {
  readonly target: Target;
  readonly url: string;
}

export interface ProbeOptions {
  readonly endpoints: readonly Endpoint[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly allowLoopbackHttp?: boolean;
}

export class Budget {
  attempts = 0;
  readonly started: number;
  constructor(
    private readonly now: () => number,
    readonly deadline = LIMITS.runtimeMs,
  ) {
    this.started = now();
  }
  get exhausted(): string | null {
    if (this.attempts >= LIMITS.attempts) return 'ATTEMPTS_EXHAUSTED';
    if (this.now() - this.started >= this.deadline) return 'RUNTIME_EXHAUSTED';
    return null;
  }
}

class Unknown extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
class Reverted extends Error {
  constructor(readonly data: string | null) {
    super('REVERT');
  }
}

function safeEndpoint(url: string, allowLoopbackHttp: boolean): string | null {
  try {
    const parsed = new URL(url);
    const loopback = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(allowLoopbackHttp && loopback)) return null;
    if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function makeRpc(
  url: string,
  budget: Budget,
  fetchImpl: typeof fetch,
): (method: string, params: readonly unknown[]) => Promise<unknown> {
  let id = 0;
  return async (method, params) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stopped = budget.exhausted;
      if (stopped !== null) throw new Unknown(stopped);
      budget.attempts += 1;
      id += 1;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(LIMITS.callMs),
        });
      } catch {
        // Network failure or timeout: one transient retry, then unknown.
        if (attempt === 0) continue;
        throw new Unknown('RPC_UNREACHABLE_OR_TIMEOUT');
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 0) continue;
        throw new Unknown('RPC_TRANSIENT_FAILURE');
      }
      if (!response.ok) throw new Unknown('RPC_HTTP_ERROR');
      let body: { id?: unknown; result?: unknown; error?: { code?: number; data?: unknown } };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new Unknown('RPC_RESPONSE_INVALID');
      }
      if (body.id !== id) throw new Unknown('RPC_RESPONSE_INVALID');
      if (body.error !== undefined) {
        // eth_call reverts carry data; any other JSON-RPC error is an unknown, not a verdict.
        if (method === 'eth_call' && typeof body.error.data === 'string') {
          throw new Reverted(body.error.data);
        }
        if (method === 'eth_call' && body.error.code === 3) throw new Reverted(null);
        throw new Unknown('RPC_ERROR');
      }
      return body.result;
    }
    throw new Unknown('RPC_UNREACHABLE_OR_TIMEOUT');
  };
}

const hexQuantity = (value: unknown): bigint | null =>
  typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;

type Rpc = ReturnType<typeof makeRpc>;

async function view(
  rpc: Rpc,
  address: string,
  data: Hex,
  block: string,
): Promise<{ kind: 'ok'; data: Hex } | { kind: 'revert'; data: string | null }> {
  try {
    const result = await rpc('eth_call', [{ to: address, data }, block]);
    return typeof result === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(result)
      ? { kind: 'ok', data: result as Hex }
      : (() => {
          throw new Unknown('RPC_RESPONSE_INVALID');
        })();
  } catch (error) {
    if (error instanceof Reverted) return { kind: 'revert', data: error.data };
    throw error;
  }
}

async function probeRegistry(
  rpc: Rpc,
  kind: 'identity' | 'reputation',
  address: string,
  block: string,
  identityAddress: string,
): Promise<RegistryResult> {
  const observations: Observation[] = [];
  const reasons: string[] = [];
  const base = {
    registry: kind,
    address,
    codeKeccak256: null as string | null,
    implementation: null as RegistryResult['implementation'],
    version: null as string | null,
    linkedIdentityRegistry: null as string | null,
  };
  const finish = (status: RegistryStatus): RegistryResult => ({
    ...base,
    status,
    reasons,
    observations,
  });
  const note = (name: string, outcome: Observation['outcome'], detail: string): void => {
    observations.push({ name, outcome, detail });
  };

  try {
    const code = await rpc('eth_getCode', [address, block]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(code)) {
      throw new Unknown('RPC_RESPONSE_INVALID');
    }
    if (code === '0x') {
      reasons.push('NO_CODE_AT_CHECKPOINT');
      note('eth_getCode', 'ok', 'empty');
      return finish('absent');
    }
    base.codeKeccak256 = keccak256(code as Hex);
    note('eth_getCode', 'ok', `${String((code.length - 2) / 2)} bytes`);

    // Proxy observation (EIP-1967). Recorded, never used alone to certify behaviour.
    const slot = await rpc('eth_getStorageAt', [address, EIP1967_IMPLEMENTATION_SLOT, block]);
    const implementation =
      typeof slot === 'string' && /^0x[0-9a-f]{64}$/.test(slot) ? `0x${slot.slice(26)}` : null;
    if (implementation !== null && !/^0x0{40}$/.test(implementation)) {
      const implementationCode = await rpc('eth_getCode', [implementation, block]);
      base.implementation = {
        address: implementation,
        codeKeccak256:
          typeof implementationCode === 'string' && implementationCode !== '0x'
            ? keccak256(implementationCode as Hex)
            : null,
      };
      note('eip1967-implementation', 'ok', implementation);
    }

    const abi = kind === 'identity' ? identityAbi : reputationAbi;
    const versionCall = await view(
      rpc,
      address,
      encodeFunctionData({ abi, functionName: 'getVersion' }),
      block,
    );
    if (versionCall.kind === 'revert') {
      reasons.push('GET_VERSION_REVERTED');
      note('getVersion', 'revert', versionCall.data ?? 'no data');
      return finish('incompatible');
    }
    try {
      [base.version] = decodeAbiParameters([{ type: 'string' }], versionCall.data);
      note('getVersion', 'ok', base.version);
    } catch {
      reasons.push('GET_VERSION_UNDECODABLE');
      note('getVersion', 'error', 'undecodable');
      return finish('incompatible');
    }

    if (kind === 'identity') {
      const erc721 = await view(
        rpc,
        address,
        encodeFunctionData({
          abi: identityAbi,
          functionName: 'supportsInterface',
          args: [ERC721_INTERFACE_ID],
        }),
        block,
      );
      const supports = erc721.kind === 'ok' && /^0x0{63}1$/.test(erc721.data);
      note('supportsInterface(ERC721)', erc721.kind === 'ok' ? 'ok' : 'revert', String(supports));
      if (!supports) {
        reasons.push('ERC721_NOT_SUPPORTED');
        return finish('incompatible');
      }
      const missing = await view(
        rpc,
        address,
        encodeFunctionData({ abi: identityAbi, functionName: 'ownerOf', args: [MAX_UINT256] }),
        block,
      );
      const known =
        missing.kind === 'revert' &&
        missing.data !== null &&
        missing.data.toLowerCase().startsWith(NONEXISTENT_TOKEN_SELECTOR);
      note(
        'ownerOf(nonexistent)',
        missing.kind === 'revert' ? 'revert' : 'ok',
        known ? 'ERC721NonexistentToken' : 'other',
      );
      if (!known) {
        reasons.push('NONEXISTENT_TOKEN_NOT_DECODED');
        return finish('incompatible');
      }
      reasons.push('CODE_ABI_AND_NONEXISTENT_TOKEN_VERIFIED');
      return finish('verified');
    }

    const link = await view(
      rpc,
      address,
      encodeFunctionData({ abi: reputationAbi, functionName: 'getIdentityRegistry' }),
      block,
    );
    if (link.kind === 'revert') {
      reasons.push('GET_IDENTITY_REGISTRY_REVERTED');
      note('getIdentityRegistry', 'revert', link.data ?? 'no data');
      return finish('incompatible');
    }
    const [linked] = decodeAbiParameters([{ type: 'address' }], link.data);
    base.linkedIdentityRegistry = linked.toLowerCase();
    note('getIdentityRegistry', 'ok', base.linkedIdentityRegistry);
    if (base.linkedIdentityRegistry !== identityAddress.toLowerCase()) {
      reasons.push('LINKED_IDENTITY_REGISTRY_DIFFERS');
      return finish('incompatible');
    }
    reasons.push('CODE_ABI_AND_IDENTITY_LINK_VERIFIED');
    return finish('verified');
  } catch (error) {
    if (error instanceof Unknown) {
      reasons.push(error.reason);
      note('probe', 'error', error.reason);
      return finish('unknown');
    }
    throw error;
  }
}

/** true: both verified. false: a required target is demonstrably absent or incompatible. Else unknown. */
export function relation(
  identity: RegistryStatus,
  reputation: RegistryStatus,
): boolean | 'unknown' {
  if (identity === 'verified' && reputation === 'verified') return true;
  const demonstrablyBad = (status: RegistryStatus): boolean =>
    status === 'absent' || status === 'incompatible';
  return demonstrablyBad(identity) || demonstrablyBad(reputation) ? false : 'unknown';
}

export async function probeNetwork(
  endpoint: Endpoint,
  budget: Budget,
  options: Pick<ProbeOptions, 'fetch' | 'allowLoopbackHttp'>,
): Promise<NetworkResult> {
  const { target, url } = endpoint;
  const origin = safeEndpoint(url, options.allowLoopbackHttp === true);
  const base = {
    network: target.network,
    chainId: target.chainId,
    endpoint: origin ?? 'invalid-endpoint',
    identity: null,
    reputation: null,
  } as const;
  const unknown = (reasons: string[]): NetworkResult => ({
    ...base,
    status: 'unknown',
    reasons,
    checkpoint: null,
    full: 'unknown',
  });
  if (origin === null) return unknown(['ENDPOINT_NOT_HTTPS_OR_HAS_CREDENTIALS']);
  const rpc = makeRpc(url, budget, options.fetch ?? fetch);
  try {
    // Chain identity first: nothing below is interpreted on an unverified chain.
    const reported = hexQuantity(await rpc('eth_chainId', []));
    if (reported !== BigInt(target.chainId)) return unknown(['WRONG_CHAIN']);
    const finalized = (await rpc('eth_getBlockByNumber', ['finalized', false])) as {
      number?: string;
    } | null;
    const finalizedNumber = hexQuantity(finalized?.number);
    if (finalizedNumber === null) return unknown(['FINALIZED_BLOCK_UNAVAILABLE']);
    const selected = finalizedNumber - BigInt(EXECUTION_DELAY_BLOCKS);
    if (selected < 0n) return unknown(['CHECKPOINT_BELOW_GENESIS']);
    const block = `0x${selected.toString(16)}`;
    const header = (await rpc('eth_getBlockByNumber', [block, false])) as {
      number?: string;
      hash?: string;
    } | null;
    if (
      header === null ||
      hexQuantity(header.number) !== selected ||
      typeof header.hash !== 'string'
    ) {
      return unknown(['CHECKPOINT_BLOCK_UNAVAILABLE']);
    }
    // The two registries are probed independently at this one checkpoint.
    const identity = await probeRegistry(
      rpc,
      'identity',
      target.identityRegistry,
      block,
      target.identityRegistry,
    );
    const reputation = await probeRegistry(
      rpc,
      'reputation',
      target.reputationRegistry,
      block,
      target.identityRegistry,
    );
    // A reorganisation or a pruned node would make the pair incoherent: re-read the header.
    const after = (await rpc('eth_getBlockByNumber', [block, false])) as { hash?: string } | null;
    if (after?.hash !== header.hash) return unknown(['CHECKPOINT_BLOCK_CHANGED']);
    return {
      ...base,
      identity,
      reputation,
      status: 'checked',
      reasons: [],
      checkpoint: { blockNumber: selected.toString(), blockHash: header.hash },
      full: relation(identity.status, reputation.status),
    };
  } catch (error) {
    if (error instanceof Unknown) return unknown([error.reason]);
    throw error;
  }
}

export interface ProbeReport {
  readonly networks: readonly NetworkResult[];
  readonly durationMs: number;
  readonly attempts: number;
}

export async function probeAll(options: ProbeOptions): Promise<ProbeReport> {
  const now = options.now ?? Date.now;
  const budget = new Budget(now);
  const networks: NetworkResult[] = [];
  for (const endpoint of options.endpoints) {
    networks.push(
      await probeNetwork(endpoint, budget, {
        ...(options.fetch !== undefined && { fetch: options.fetch }),
        ...(options.allowLoopbackHttp !== undefined && {
          allowLoopbackHttp: options.allowLoopbackHttp,
        }),
      }),
    );
  }
  return { networks, durationMs: now() - budget.started, attempts: budget.attempts };
}

/** features.agentIdentity.availableOnTestnet: true only for both registries verified and linked. */
export function testnetAvailability(report: ProbeReport): boolean | 'unknown' {
  const testnet = report.networks.find((network) => network.network === 'monad-testnet');
  if (testnet === undefined || testnet.status !== 'checked') return 'unknown';
  return testnet.full;
}
