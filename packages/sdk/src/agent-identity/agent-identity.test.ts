import { encodeAbiParameters, keccak256, toFunctionSelector, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  agentIdentityResolutionSchema,
  buildRegistrationFile,
  registrationFileSchema,
  resolveAgentIdentity,
  type AgentIdentityChainClient,
} from './index';

const REGISTRY = '0x8004a818bfb912233c491871b3d84c89a494bd9e';
const OWNER = `0x${'22'.repeat(20)}`;
const GENESIS = `0x${'09'.repeat(32)}`;
const URI = 'https://lexaegis.example.test/api/agent-card';
const policy = {
  id: 'test.erc8004',
  chainId: '10143',
  genesisHash: GENESIS,
  identityRegistry: REGISTRY,
  executionDelayBlocks: 3,
};
const reference = {
  standard: 'erc-8004',
  chainId: '10143',
  identityRegistry: REGISTRY,
  agentId: '7',
  cardUri: URI,
};
const hash = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const sel = (s: string) => toFunctionSelector(s);
const str = (t: string) => encodeAbiParameters([{ type: 'string' }], [t]);

interface World {
  chain?: number;
  genesis?: Hex;
  code?: Hex;
  owners?: Record<string, string>;
  uri?: string;
  versionRevert?: boolean;
  otherRevert?: boolean;
  fail?: boolean;
  reorg?: boolean;
  finalized?: boolean;
}
function client(world: World, calls: string[] = []): AgentIdentityChainClient {
  let reads = 0;
  const down = () => (world.fail ? Promise.reject(new Error('down')) : null);
  return {
    getChainId: () => down() ?? Promise.resolve(world.chain ?? 10143),
    getBlock: (s) => {
      calls.push('block');
      const failure = down();
      if (failure) return failure;
      if ('blockTag' in s)
        return Promise.resolve(
          world.finalized === false ? null : { number: 100n, hash: hash(100n), timestamp: 1n },
        );
      if (s.blockNumber === 0n)
        return Promise.resolve({
          number: 0n,
          hash: world.genesis ?? (GENESIS as Hex),
          timestamp: 0n,
        });
      reads += 1;
      return Promise.resolve({
        number: s.blockNumber,
        hash: world.reorg && reads > 1 ? hash(999n) : hash(s.blockNumber),
        timestamp: 1n,
      });
    },
    getCode: ({ address }) => {
      calls.push('code');
      return Promise.resolve(address === REGISTRY ? (world.code ?? '0x6080') : '0x6001');
    },
    getStorageAt: () => Promise.resolve(`0x${'00'.repeat(12)}${'ab'.repeat(20)}` as Hex),
    read: ({ data }) => {
      calls.push('read');
      if (world.otherRevert) return Promise.resolve({ kind: 'revert', data: '0x08c379a0' });
      if (data.startsWith(sel('getVersion()'))) {
        return Promise.resolve(
          world.versionRevert ? { kind: 'revert', data: null } : { kind: 'ok', data: str('2.0.0') },
        );
      }
      const id = BigInt(`0x${data.slice(10)}`).toString();
      if (data.startsWith(sel('ownerOf(uint256)'))) {
        const owner = (world.owners ?? { '7': OWNER })[id];
        return Promise.resolve(
          owner === undefined
            ? {
                kind: 'revert',
                data: `${sel('ERC721NonexistentToken(uint256)')}${'0'.repeat(63)}7` as Hex,
              }
            : { kind: 'ok', data: encodeAbiParameters([{ type: 'address' }], [owner as Hex]) },
        );
      }
      return Promise.resolve({ kind: 'ok', data: str(world.uri ?? URI) });
    },
  };
}
const resolve = (world: World, extra: Record<string, unknown> = {}) =>
  resolveAgentIdentity({
    reference,
    policy,
    transport: { kind: 'client', client: client(world) },
    now: () => new Date('2026-10-11T12:00:00Z'),
    ...extra,
  });

describe('resolveAgentIdentity', () => {
  it('registered: owner, URI and checkpoint come from one verified read; schema-valid', async () => {
    const r = await resolve({});
    expect(agentIdentityResolutionSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({
      status: 'registered',
      reason: 'REGISTERED',
      checkpoint: { blockNumber: '97' },
      agent: { owner: OWNER, uri: { changed: false, transport: 'https' } },
      registry: { version: '2.0.0', codeKeccak256: keccak256('0x6080') },
    });
  });
  it('the known nonexistent-token answer is notFound; every other failure is unavailable', async () => {
    expect((await resolve({ owners: {} })).status).toBe('notFound');
    for (const [world, reason] of [
      [{ otherRevert: true }, 'ABI_UNSUPPORTED'],
      [{ versionRevert: true }, 'ABI_UNSUPPORTED'],
      [{ code: '0x' as Hex }, 'REGISTRY_CODE_MISSING'],
      [{ fail: true }, 'RPC_UNAVAILABLE'],
      [{ chain: 1 }, 'WRONG_CHAIN'],
      [{ genesis: hash(5n) }, 'GENESIS_MISMATCH'],
      [{ reorg: true }, 'BLOCK_CHANGED'],
      [{ finalized: false }, 'FINALIZED_UNAVAILABLE'],
    ] as const) {
      const r = await resolve(world);
      expect(r.status, reason).toBe('unavailable');
      expect(r.reason).toBe(reason);
    }
  });
  it('a changed URI is a separate observation; the registration still exists', async () => {
    const r = await resolve({ uri: 'ipfs://bafy' });
    expect(r).toMatchObject({
      status: 'registered',
      agent: { uri: { changed: true, transport: 'unsupported', captured: URI } },
    });
  });
  it('only the configured network resolves: another chain or registry is never looked up', async () => {
    const calls: string[] = [];
    for (const bad of [
      { ...reference, chainId: '143' },
      { ...reference, identityRegistry: `0x${'11'.repeat(20)}` },
    ]) {
      const r = await resolveAgentIdentity({
        reference: bad,
        policy,
        transport: { kind: 'client', client: client({}, calls) },
      });
      expect(r).toMatchObject({ status: 'unavailable', reason: 'NETWORK_NOT_CONFIGURED' });
    }
    expect(calls).toEqual([]);
  });
  it('invalid input, a pre-aborted signal and the generation tag', async () => {
    expect((await resolve({}, { reference: { ...reference, agentId: 7 } })).reason).toBe(
      'REFERENCE_INVALID',
    );
    expect((await resolve({}, { policy: {} })).reason).toBe('POLICY_INVALID');
    const controller = new AbortController();
    controller.abort();
    expect((await resolve({}, { signal: controller.signal })).reason).toBe('ABORTED');
    expect((await resolve({}, { generation: 4 })).generation).toBe(4);
  });
  it('a pinned proxy code hash that differs is unavailable', async () => {
    const r = await resolve({}, { policy: { ...policy, proxyCodeKeccak256: hash(1n) } });
    expect(r.reason).toBe('REGISTRY_CODE_MISMATCH');
  });
  it('sends only public parameters over RPC and only read methods', async () => {
    const bodies: string[] = [];
    const fetchStub = ((_u: string, init: { body: string }) => {
      bodies.push(init.body);
      const request = JSON.parse(init.body) as { id: number };
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000 } })),
      );
    }) as never;
    const r = await resolveAgentIdentity({
      reference,
      policy,
      transport: { kind: 'rpc', url: 'https://rpc.example.invalid/', fetch: fetchStub },
    });
    expect(r.status).toBe('unavailable');
    for (const body of bodies)
      expect([
        'eth_chainId',
        'eth_getBlockByNumber',
        'eth_getCode',
        'eth_getStorageAt',
        'eth_call',
      ]).toContain((JSON.parse(body) as { method: string }).method);
  });
});

describe('registration file', () => {
  it('builds a card with only real capabilities and no predicted registration', () => {
    const card = buildRegistrationFile({ origin: 'https://lexaegis.example.test' });
    expect(card.registrations).toEqual([]);
    expect(card.services).toEqual([{ name: 'web', endpoint: 'https://lexaegis.example.test/' }]);
    expect(card.x402Support).toBe(false);
    expect(JSON.stringify(card)).not.toMatch(/mcp|a2a|supportedTrust|validation/i);
    expect(card.description.length).toBeLessThanOrEqual(500);
    expect(() => buildRegistrationFile({ origin: 'http://localhost:3000' })).toThrow();
  });
  it('after a confirmed registration the tuple is the actual one, and unsafe IDs are rejected not rounded', () => {
    const card = buildRegistrationFile({
      origin: 'https://lexaegis.example.test',
      registration: { agentId: 7, chainId: '10143', identityRegistry: REGISTRY },
    });
    expect(card.registrations).toEqual([{ agentId: 7, agentRegistry: `eip155:10143:${REGISTRY}` }]);
    expect(
      registrationFileSchema.safeParse({
        ...card,
        registrations: [{ agentId: 2 ** 60, agentRegistry: `eip155:10143:${REGISTRY}` }],
      }).success,
    ).toBe(false);
    expect(() =>
      buildRegistrationFile({
        origin: 'https://x.example',
        registration: { agentId: 2 ** 60, chainId: '10143', identityRegistry: REGISTRY },
      }),
    ).toThrow();
  });
});
