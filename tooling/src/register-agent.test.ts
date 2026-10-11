import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPROVED_IDENTITY_REGISTRY,
  buildPlan,
  decodeRegistered,
  execute,
  identityAbi,
  planHash,
  type Journal,
  type JournalEntry,
  type RegistrationChain,
} from './register-agent';

const OPERATOR = `0x${'aa'.repeat(20)}`;
const CARD = 'https://lexaegis.example.test/api/agent-card';
const good = {
  chainId: 10143,
  identityRegistry: APPROVED_IDENTITY_REGISTRY,
  operator: OPERATOR,
  cardUri: CARD,
};
const plan = (() => {
  const r = buildPlan(good);
  if (!r.ok) throw new Error('plan');
  return r.plan;
})();

function logFor(agentId: bigint, owner = OPERATOR) {
  const topics = encodeEventTopics({
    abi: identityAbi,
    eventName: 'Registered',
    args: { agentId, owner: owner as `0x${string}` },
  });
  return {
    address: APPROVED_IDENTITY_REGISTRY,
    topics: topics as string[],
    data: encodeAbiParameters([{ type: 'string' }], [CARD]),
  };
}

interface Spy {
  sends: number;
  reads: string[];
}
function fake(
  overrides: Partial<RegistrationChain> = {},
  spy: Spy = { sends: 0, reads: [] },
  mined = true,
): RegistrationChain {
  return {
    chainId: () => Promise.resolve(10143),
    registryBehaves: () => Promise.resolve(true),
    cardServed: () => Promise.resolve(true),
    balance: () => Promise.resolve(10n ** 18n),
    estimate: () => Promise.resolve({ gas: 150_000n, maxFeePerGas: 100n }),
    nonce: () => Promise.resolve(4n),
    send: () => {
      spy.sends += 1;
      return Promise.resolve(`0x${'ab'.repeat(32)}`);
    },
    receipt: () =>
      Promise.resolve(mined ? { status: 'success', blockNumber: 50n, logs: [logFor(9n)] } : null),
    ownerOf: () => Promise.resolve(OPERATOR),
    tokenUri: () => Promise.resolve(CARD),
    keyAddress: () => OPERATOR,
    ...overrides,
  };
}
function memory(): Journal & { entry: JournalEntry | null } {
  const j = {
    entry: null as JournalEntry | null,
    read: () => j.entry,
    write: (e: JournalEntry) => {
      j.entry = e;
    },
  };
  return j;
}
const run = (chain: RegistrationChain, journal: Journal, extra: Record<string, unknown> = {}) =>
  execute({
    plan,
    confirmedPlanHash: planHash(plan),
    chain,
    journal,
    operation: 'op',
    pause: () => Promise.resolve(),
    waitAttempts: 3,
    ...extra,
  });

describe('plan guards', () => {
  it('refuses mainnet, other chains, an unapproved registry, a bad operator or card URI', () => {
    expect(buildPlan({ ...good, chainId: 143 })).toEqual({ ok: false, refusal: 'MAINNET_REFUSED' });
    expect(buildPlan({ ...good, chainId: 1 })).toEqual({ ok: false, refusal: 'WRONG_CHAIN' });
    expect(
      buildPlan({ ...good, identityRegistry: `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432` }),
    ).toEqual({ ok: false, refusal: 'REGISTRY_NOT_APPROVED' });
    expect(buildPlan({ ...good, operator: '0x12' })).toEqual({
      ok: false,
      refusal: 'OPERATOR_INVALID',
    });
    for (const cardUri of [
      'http://x.example/c',
      'https://localhost/c',
      ['https://u', 'p'].join(':') + '@x.example/c',
      'https://x.example/c?a=1',
      'ipfs://x',
    ]) {
      expect(buildPlan({ ...good, cardUri })).toEqual({ ok: false, refusal: 'CARD_URI_INVALID' });
    }
    expect(plan).toMatchObject({ valueWei: '0', method: 'register(string)' });
  });
  it('the script reads the key only for --execute, from ERC8004_OPERATOR_KEY, and never from public or user keys', () => {
    const source = readFileSync(join(__dirname, '..', 'scripts', 'register-agent.ts'), 'utf8');
    expect(source.match(/process\.env\.ERC8004_OPERATOR_KEY/g)).toHaveLength(1);
    expect(source.indexOf('process.env.ERC8004_OPERATOR_KEY')).toBeGreaterThan(
      source.indexOf('if (!values.execute)'),
    );
    expect(source.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(
      /NEXT_PUBLIC|mera|passkey|console\.log\([^)]*(rawKey|account\.)/i,
    );
  });
});

describe('execute', () => {
  it('sends nothing without the confirmed plan hash or a matching key', async () => {
    const spy = { sends: 0, reads: [] };
    expect(
      await execute({
        plan,
        confirmedPlanHash: undefined,
        chain: fake({}, spy),
        journal: memory(),
        operation: 'o',
      }),
    ).toEqual({ status: 'refused', refusal: 'PLAN_NOT_CONFIRMED' });
    expect(
      await execute({
        plan,
        confirmedPlanHash: 'wrong',
        chain: fake({}, spy),
        journal: memory(),
        operation: 'o',
      }),
    ).toMatchObject({ refusal: 'PLAN_NOT_CONFIRMED' });
    expect(await run(fake({ keyAddress: () => null }, spy), memory())).toMatchObject({
      refusal: 'KEY_MISSING',
    });
    expect(
      await run(fake({ keyAddress: () => `0x${'bb'.repeat(20)}` }, spy), memory()),
    ).toMatchObject({ refusal: 'KEY_ADDRESS_MISMATCH' });
    expect(spy.sends).toBe(0);
  });
  it('rechecks chain, registry ABI, card, fee and funds immediately before sending', async () => {
    const spy = { sends: 0, reads: [] };
    expect(await run(fake({ chainId: () => Promise.resolve(143) }, spy), memory())).toMatchObject({
      refusal: 'CHAIN_IDENTITY_MISMATCH',
    });
    expect(
      await run(fake({ registryBehaves: () => Promise.resolve(false) }, spy), memory()),
    ).toMatchObject({ refusal: 'REGISTRY_ABI_UNVERIFIED' });
    expect(
      await run(fake({ cardServed: () => Promise.resolve(false) }, spy), memory()),
    ).toMatchObject({ refusal: 'CARD_UNAVAILABLE' });
    expect(
      await run(
        fake({ estimate: () => Promise.resolve({ gas: 900_000n, maxFeePerGas: 1n }) }, spy),
        memory(),
      ),
    ).toMatchObject({ refusal: 'FEE_TOO_HIGH' });
    expect(
      await run(
        fake({ estimate: () => Promise.resolve({ gas: 100_000n, maxFeePerGas: 10n ** 15n }) }, spy),
        memory(),
      ),
    ).toMatchObject({ refusal: 'FEE_TOO_HIGH' });
    expect(await run(fake({ balance: () => Promise.resolve(1n) }, spy), memory())).toMatchObject({
      refusal: 'INSUFFICIENT_FUNDS',
    });
    expect(spy.sends).toBe(0);
  });
  it('confirms from the decoded Registered event, then reads owner and URI back; the ID is never predicted', async () => {
    const spy = { sends: 0, reads: [] };
    const journal = memory();
    const result = await run(fake({}, spy), journal);
    expect(result).toMatchObject({
      status: 'confirmed',
      agentId: '9',
      owner: OPERATOR,
      cardUri: CARD,
      blockNumber: '50',
    });
    expect(spy.sends).toBe(1);
    expect(journal.entry).toMatchObject({ status: 'confirmed', nonce: '4' });
    expect(JSON.stringify(journal.entry)).not.toMatch(/key|signature/i);
    expect(decodeRegistered(APPROVED_IDENTITY_REGISTRY, [logFor(3n)])?.agentId).toBe(3n);
    expect(
      decodeRegistered(APPROVED_IDENTITY_REGISTRY, [
        { ...logFor(3n), address: `0x${'cc'.repeat(20)}` },
      ]),
    ).toBeNull();
    expect(
      await run(
        fake({ receipt: () => Promise.resolve({ status: 'success', blockNumber: 1n, logs: [] }) }),
        memory(),
      ),
    ).toMatchObject({ refusal: 'REGISTERED_EVENT_MISSING' });
  });
  it('a read-back mismatch is not a confirmation', async () => {
    expect(
      await run(fake({ ownerOf: () => Promise.resolve(`0x${'dd'.repeat(20)}`) }), memory()),
    ).toMatchObject({ refusal: 'OWNER_MISMATCH' });
    expect(
      await run(fake({ tokenUri: () => Promise.resolve('https://other.example/c') }), memory()),
    ).toMatchObject({ refusal: 'URI_MISMATCH' });
    expect(
      await run(
        fake({ receipt: () => Promise.resolve({ status: 'reverted', blockNumber: 1n, logs: [] }) }),
        memory(),
      ),
    ).toMatchObject({ refusal: 'NOT_CONFIRMED' });
  });
  it('a timeout leaves the journal pending and a rerun reconciles the same transaction without sending again', async () => {
    const spy = { sends: 0, reads: [] };
    const journal = memory();
    const first = await run(fake({}, spy, false), journal);
    expect(first).toMatchObject({ status: 'pending' });
    expect(journal.entry).toMatchObject({
      status: 'pending',
      transactionHash: `0x${'ab'.repeat(32)}`,
    });
    const second = await run(fake({}, spy, true), journal);
    expect(second).toMatchObject({ status: 'confirmed', agentId: '9' });
    expect(spy.sends).toBe(1);
    // A journal entry without a hash (interrupted between journal and send) is never retried blindly.
    const stuck = memory();
    stuck.entry = {
      operation: 'o',
      planHash: planHash(plan),
      operator: plan.operator,
      nonce: '4',
      transactionHash: null,
      status: 'pending',
    };
    expect(await run(fake({}, spy), stuck)).toMatchObject({ refusal: 'PENDING_OPERATION_EXISTS' });
    expect(spy.sends).toBe(1);
  });
});
