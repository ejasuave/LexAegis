import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../env';
import { isIntendedEndpoint, redactEndpoint } from './alchemy-client';
import {
  fundingResultSchema,
  isAllowedMutationChain,
  publicChainInfo,
  resolveDeployment,
  resolveSettings,
  transactionQuoteSchema,
} from './config';
import { setChainRuntimeForTests } from './runtime';
import { GET as status } from '@/app/api/chain/status/route';
import { GET as receipt } from '@/app/api/chain/receipts/[reviewer]/[commitment]/route';
import { POST as createOp } from '@/app/api/chain/operations/route';
import { POST as fund } from '@/app/api/chain/funding/route';
import { POST as submit } from '@/app/api/chain/operations/[id]/submit/route';

const template = {
  schema: 'lexaegis.registry-deployment.v1',
  status: 'not_deployed',
  environment: 'testnet',
  network: 'monad-testnet',
  intendedChainId: '10143',
  contract: 'ProofOfReviewRegistry',
  build: {
    solc: '0.8.37+commit.f401782d',
    evmVersion: 'osaka',
    creationCodeKeccak256: `0x${'38'.repeat(32)}`,
  },
};
const deployedBase: Partial<typeof template> = { ...template };
delete deployedBase.intendedChainId;
const deployed = {
  ...deployedBase,
  status: 'deployed',
  chainId: '10143',
  registryAddress: `0x${'ab'.repeat(20)}`,
  transactionHash: `0x${'12'.repeat(32)}`,
  blockNumber: '42',
  runtimeCodeKeccak256: `0x${'34'.repeat(32)}`,
};

describe('deployment and chain policy', () => {
  it('a not-deployed artifact enables nothing and no placeholder address becomes ready', () => {
    expect(resolveDeployment(template)).toEqual({ state: 'not_deployed' });
    expect(resolveDeployment({ ...template, registryAddress: `0x${'ab'.repeat(20)}` }).state).toBe(
      'invalid',
    );
    expect(publicChainInfo(resolveDeployment(template), template)).not.toHaveProperty(
      'registryAddress',
    );
  });

  it('a deployed testnet record yields a policy with the documented 3-block execution delay', () => {
    const ready = resolveDeployment(deployed);
    expect(ready).toMatchObject({
      state: 'ready',
      policy: { chainId: '10143', deploymentBlock: '42', executionDelayBlocks: 3 },
    });
    expect(publicChainInfo(ready, deployed)).toMatchObject({
      registryAddress: deployed.registryAddress,
      deploymentBlock: '42',
    });
  });

  it('rejects mainnet and mismatched environments', () => {
    expect(resolveDeployment({ ...deployed, environment: 'mainnet', chainId: '143' }).state).toBe(
      'wrong_chain',
    );
    expect(resolveDeployment({ ...deployed, environment: 'testnet', chainId: '143' }).state).toBe(
      'invalid',
    );
    expect(isAllowedMutationChain('143')).toBe(false);
    expect(isAllowedMutationChain('1')).toBe(false);
    expect(isAllowedMutationChain('31337')).toBe(false);
    expect(isAllowedMutationChain('10143')).toBe(true);
  });

  it('applies the default funding policy and rejects malformed overrides', () => {
    const loaded = loadServerConfig({});
    if (!loaded.ok) throw new Error('config');
    expect(resolveSettings(loaded.config)).toMatchObject({
      fundingEnabled: false,
      grantWei: 2n * 10n ** 17n,
      dailyBudgetWei: 10n * 10n ** 18n,
      fundingMaxFeeWei: 10n ** 16n,
      registryMaxFeeWei: 2n * 10n ** 17n,
    });
    expect(loadServerConfig({ TESTNET_FUNDING_GRANT_MON: '0.1.2' }).ok).toBe(false);
    expect(loadServerConfig({ TESTNET_FUNDING_ENABLED: 'yes' }).ok).toBe(false);
    const tuned = loadServerConfig({
      TESTNET_FUNDING_ENABLED: 'true',
      TESTNET_FUNDING_GRANT_MON: '0.5',
    });
    expect(tuned.ok && resolveSettings(tuned.config)).toMatchObject({
      fundingEnabled: true,
      grantWei: 5n * 10n ** 17n,
    });
  });
});

describe('Alchemy endpoint handling', () => {
  it('accepts only the Alchemy Monad testnet host over HTTPS', () => {
    expect(isIntendedEndpoint('https://monad-testnet.g.alchemy.com/v2/KEY')).toBe(true);
    expect(isIntendedEndpoint('https://eth-mainnet.g.alchemy.com/v2/KEY')).toBe(false);
    expect(isIntendedEndpoint('https://testnet-rpc.monad.xyz')).toBe(false);
    expect(isIntendedEndpoint('http://monad-testnet.g.alchemy.com/v2/KEY')).toBe(false);
    expect(
      isIntendedEndpoint(
        ['https://', 'user', ':', 'pw', '@monad-testnet.g.alchemy.com/v2/KEY'].join(''),
      ),
    ).toBe(false);
    expect(isIntendedEndpoint('http://127.0.0.1:8545')).toBe(false);
    expect(isIntendedEndpoint('http://127.0.0.1:8545', true)).toBe(true);
  });

  it('redacts the path and query that carry the API key', () => {
    const shown = redactEndpoint(
      'https://monad-testnet.g.alchemy.com/v2/SECRETKEY123?k=SECRETKEY123',
    );
    expect(shown).not.toContain('SECRETKEY123');
    expect(shown).toContain('monad-testnet.g.alchemy.com');
  });
});

describe('closed schemas', () => {
  it('canonical decimal strings only, no extra fields', () => {
    const quote = {
      operationId: '00000000-0000-4000-8000-000000000001',
      account: `0x${'aa'.repeat(20)}`,
      chainId: '10143',
      registryAddress: `0x${'ab'.repeat(20)}`,
      calldataHash: `0x${'11'.repeat(32)}`,
      actionDigest: null,
      value: '0',
      type: 'eip1559',
      transactionNonce: '3',
      gasLimit: '100000',
      maxFeePerGas: '100000000000',
      maxPriorityFeePerGas: '1',
      expectedFeeWei: '1',
      maxFeeWei: '10000000000000000',
      issuedAt: '2026-10-09T12:00:00.000Z',
      expiresAt: '2026-10-09T12:00:30.000Z',
    };
    expect(transactionQuoteSchema.safeParse(quote).success).toBe(true);
    expect(transactionQuoteSchema.safeParse({ ...quote, gasLimit: '1e5' }).success).toBe(false);
    expect(transactionQuoteSchema.safeParse({ ...quote, gasLimit: 100000 }).success).toBe(false);
    expect(transactionQuoteSchema.safeParse({ ...quote, value: '1' }).success).toBe(false);
    expect(transactionQuoteSchema.safeParse({ ...quote, extra: true }).success).toBe(false);
    expect(
      fundingResultSchema.safeParse({ status: 'disabled', faucetUrl: 'https://faucet.monad.xyz' })
        .success,
    ).toBe(true);
    expect(
      fundingResultSchema.safeParse({ status: 'disabled', faucetUrl: 'https://evil.example' })
        .success,
    ).toBe(false);
  });
});

describe('routes', () => {
  const guarded = (path: string, body: unknown) =>
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lexaegis-request': '1',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify(body),
    });
  const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

  it('public status reads need no login and never expose a credential', async () => {
    setChainRuntimeForTests({ state: 'not_configured' });
    const response = await status(new Request('http://localhost/api/chain/status'));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      status: 'not_configured',
      chain: { chainId: '10143' },
    });
    expect(text).not.toMatch(/alchemy|apikey|secret/i);
  });

  it('public receipt reads validate the lookup and report unknown, never not_found, when unavailable', async () => {
    setChainRuntimeForTests({ state: 'not_deployed' });
    const good = await receipt(
      new Request('http://localhost/x'),
      ctx({ reviewer: `0x${'aa'.repeat(20)}`, commitment: `0x${'11'.repeat(32)}` }),
    );
    expect(await good.json()).toMatchObject({
      ok: true,
      status: 'unknown',
      reason: 'not_deployed',
    });
    const bad = await receipt(
      new Request('http://localhost/x'),
      ctx({ reviewer: 'nope', commitment: '0x1' }),
    );
    expect(bad.status).toBe(400);
  });

  it('read-only CORS is granted only to the configured verifier origin and never with credentials', async () => {
    setChainRuntimeForTests({ state: 'not_configured' });
    const response = await status(
      new Request('http://localhost/api/chain/status', {
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('protected routes need a signed-in account before they look at the body', async () => {
    setChainRuntimeForTests({ state: 'not_configured' });
    for (const response of [
      await createOp(guarded('/api/chain/operations', {})),
      await fund(guarded('/api/chain/funding', { recipient: `0x${'aa'.repeat(20)}`, amount: '1' })),
      await submit(guarded('/api/chain/operations/x/submit', {}), ctx({ id: 'x' })),
    ]) {
      expect([401, 503]).toContain(response.status);
      const text = await response.text();
      expect(text).not.toContain('recipient');
    }
    setChainRuntimeForTests(undefined);
  });
});
