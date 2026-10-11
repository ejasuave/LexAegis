import { encodeAbiParameters, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  NONEXISTENT_TOKEN_SELECTOR,
  probeAll,
  relation,
  testnetAvailability,
  type Target,
} from './erc8004-probe';

const target: Target = {
  network: 'monad-testnet',
  chainId: 10143,
  identityRegistry: `0x${'a1'.repeat(20)}`,
  reputationRegistry: `0x${'b2'.repeat(20)}`,
};
const URL_ = 'https://rpc.example.invalid/';
const ALLOWED = new Set([
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_call',
]);
const word = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`;
const str = (text: string) => encodeAbiParameters([{ type: 'string' }], [text]);
const address = (value: string) =>
  encodeAbiParameters([{ type: 'address' }], [value as `0x${string}`]);
const selector = (data: string) => data.slice(0, 10);
const SELECTORS = {
  getVersion: toFunctionSelector('getVersion()'),
  supportsInterface: toFunctionSelector('supportsInterface(bytes4)'),
  ownerOf: toFunctionSelector('ownerOf(uint256)'),
  getIdentityRegistry: toFunctionSelector('getIdentityRegistry()'),
};

interface World {
  chain?: number;
  code?: Record<string, string>;
  versionReverts?: boolean;
  linked?: string;
  fail?: 'timeout' | 'http500';
  noNonexistent?: boolean;
}
const methods: string[] = [];

function scripted(world: World, counter?: { calls: number }): typeof fetch {
  return ((_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    methods.push(request.method);
    if (counter) counter.calls += 1;
    if (world.fail === 'timeout') return Promise.reject(new Error('aborted'));
    if (world.fail === 'http500') return Promise.resolve(new Response('', { status: 500 }));
    const reply = (result: unknown) =>
      Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })));
    const revert = (data: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: 3, message: 'x', data },
          }),
        ),
      );
    switch (request.method) {
      case 'eth_chainId':
        return reply(`0x${(world.chain ?? 10143).toString(16)}`);
      case 'eth_getBlockByNumber':
        return reply({
          number: request.params[0] === 'finalized' ? '0x64' : request.params[0],
          hash: word(7n),
        });
      case 'eth_getStorageAt':
        return reply(word(0n));
      case 'eth_getCode': {
        const found = (world.code ?? {})[String(request.params[0]).toLowerCase()];
        return reply(found ?? '0x');
      }
      case 'eth_call': {
        const call = request.params[0] as { to: string; data: string };
        const kind =
          call.to.toLowerCase() === target.identityRegistry.toLowerCase()
            ? 'identity'
            : 'reputation';
        if (world.versionReverts && selector(call.data) === SELECTORS.getVersion)
          return revert('0x');
        if (selector(call.data) === SELECTORS.getVersion) return reply(str('2.0.0'));
        if (selector(call.data) === SELECTORS.supportsInterface) return reply(word(1n));
        if (selector(call.data) === SELECTORS.ownerOf) {
          return world.noNonexistent
            ? reply(address(`0x${'11'.repeat(20)}`))
            : revert(`${NONEXISTENT_TOKEN_SELECTOR}${'f'.repeat(64)}`);
        }
        if (selector(call.data) === SELECTORS.getIdentityRegistry && kind === 'reputation') {
          return reply(address(world.linked ?? target.identityRegistry));
        }
        return revert('0x');
      }
      default:
        return Promise.reject(new Error(`unexpected method ${request.method}`));
    }
  }) as unknown as typeof fetch;
}

const code = {
  [target.identityRegistry.toLowerCase()]: '0x6080',
  [target.reputationRegistry.toLowerCase()]: '0x6080',
};
const run = (world: World, counter?: { calls: number }) =>
  probeAll({ endpoints: [{ target, url: URL_ }], fetch: scripted({ code, ...world }, counter) });

describe('ERC-8004 probe', () => {
  it('verified registries with a correct link make the testnet gate true', async () => {
    const report = await run({});
    expect(report.networks[0]).toMatchObject({
      status: 'checked',
      full: true,
      identity: { status: 'verified', version: '2.0.0' },
      reputation: {
        status: 'verified',
        linkedIdentityRegistry: target.identityRegistry.toLowerCase(),
      },
    });
    expect(testnetAvailability(report)).toBe(true);
  });

  it('a missing Reputation Registry is absent only for it; Identity stays verified and the gate is false', async () => {
    const report = await run({ code: { [target.identityRegistry.toLowerCase()]: '0x6080' } });
    expect(report.networks[0]?.identity?.status).toBe('verified');
    expect(report.networks[0]?.reputation?.status).toBe('absent');
    expect(testnetAvailability(report)).toBe(false);
  });

  it('a wrong relationship or ABI is incompatible, not available', async () => {
    expect((await run({ linked: `0x${'99'.repeat(20)}` })).networks[0]?.reputation?.status).toBe(
      'incompatible',
    );
    const reverting = await run({ versionReverts: true });
    expect(reverting.networks[0]?.identity?.status).toBe('incompatible');
    expect((await run({ noNonexistent: true })).networks[0]?.identity?.reasons).toContain(
      'NONEXISTENT_TOKEN_NOT_DECODED',
    );
    expect(testnetAvailability(await run({ versionReverts: true }))).toBe(false);
  });

  it('RPC failures, timeouts and a wrong chain are unknown, never true or false', async () => {
    for (const world of [
      { fail: 'timeout' as const },
      { fail: 'http500' as const },
      { chain: 1 },
    ]) {
      const report = await run(world);
      expect(report.networks[0]?.status).toBe('unknown');
      expect(testnetAvailability(report)).toBe('unknown');
      expect(report.networks[0]?.identity).toBeNull();
    }
    expect((await run({ chain: 1 })).networks[0]?.reasons).toEqual(['WRONG_CHAIN']);
  });

  it('retries a transient failure once, and stays within 32 attempts', async () => {
    const counter = { calls: 0 };
    await run({ fail: 'timeout' }, counter);
    expect(counter.calls).toBe(2);
    const many = { calls: 0 };
    await run({}, many);
    expect(many.calls).toBeLessThanOrEqual(LIMITS.attempts);
  });

  it('a mainnet success never makes the testnet gate true', async () => {
    const mainnet: Target = { ...target, network: 'monad-mainnet', chainId: 143 };
    const report = await probeAll({
      endpoints: [{ target: mainnet, url: URL_ }],
      fetch: scripted({ chain: 143, code }),
    });
    expect(report.networks[0]?.full).toBe(true);
    expect(testnetAvailability(report)).toBe('unknown');
  });

  it('refuses a credential-bearing or plain-HTTP endpoint and never echoes it', async () => {
    const report = await probeAll({
      endpoints: [{ target, url: ['https://user', 'key'].join(':') + '@rpc.example.invalid/' }],
      fetch: scripted({ code }),
    });
    expect(report.networks[0]).toMatchObject({ status: 'unknown', endpoint: 'invalid-endpoint' });
    expect(JSON.stringify(report)).not.toContain('key');
  });

  it('performs only read-only methods: no signing, no account, no transaction', async () => {
    methods.length = 0;
    await run({});
    await run({ fail: 'http500' });
    expect(methods.length).toBeGreaterThan(5);
    for (const method of methods) expect(ALLOWED.has(method), method).toBe(true);
    expect(methods.some((method) => /send|sign|account|personal|fund/i.test(method))).toBe(false);
  });

  it('relation(): demonstrable absence wins over an unknown sibling, unknown stays unknown', () => {
    expect(relation('verified', 'verified')).toBe(true);
    expect(relation('absent', 'unknown')).toBe(false);
    expect(relation('verified', 'unknown')).toBe('unknown');
    expect(relation('unknown', 'unknown')).toBe('unknown');
  });
});
