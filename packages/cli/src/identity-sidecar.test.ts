import { encodeAbiParameters, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseArguments } from './args';
import { runIdentitySidecar, type SidecarInput } from './identity-sidecar';
import { formatJson, formatText, type CliResult } from './output';
import { EXIT } from './exit';
import { HELP } from './help';
import { KNOWN_DEPLOYMENTS } from './known-deployments.generated';

const REGISTRY = '0x8004a818bfb912233c491871b3d84c89a494bd9e';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const reference = {
  standard: 'erc-8004',
  chainId: '10143',
  identityRegistry: REGISTRY,
  agentId: '7',
  cardUri: 'https://app.example.test/api/agent-card',
};
const configV2 = bytes({ schema: 'lexaegis.agent-config.v2', agentIdentity: reference });
const configV1 = bytes({ schema: 'lexaegis.agent-config.v1' });
const rpc = { url: 'https://rpc.example.invalid/', source: 'flag' as const };
const base: SidecarInput = {
  agentConfigs: [configV2],
  coreIntact: true,
  rpc,
  allowLoopbackHttp: false,
  policyPath: undefined,
  fetchCard: false,
  cardOrigins: [],
  cardTransport: null,
  signal: new AbortController().signal,
};

/** A scripted JSON-RPC node for the registry (a controlled adapter, not the deployed contract). */
function node(options: { missing?: boolean; down?: boolean } = {}): typeof fetch {
  const str = (t: string) => encodeAbiParameters([{ type: 'string' }], [t]);
  return ((_url: string, init: { body: string }) => {
    if (options.down) return Promise.reject(new Error('down'));
    const r = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    const ok = (result: unknown) =>
      Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result })));
    switch (r.method) {
      case 'eth_chainId':
        return ok('0x279f');
      case 'eth_getBlockByNumber': {
        const tag = r.params[0];
        if (tag === '0x0')
          return ok({
            number: '0x0',
            hash: JSON.parse(JSON.stringify(policyGenesis)) as string,
            timestamp: '0x1',
          });
        return ok({
          number: tag === 'finalized' ? '0x64' : tag,
          hash: `0x${'7'.repeat(64)}`,
          timestamp: '0x1',
        });
      }
      case 'eth_getCode':
        return ok('0x6080');
      case 'eth_getStorageAt':
        return ok(`0x${'0'.repeat(64)}`);
      case 'eth_call': {
        const data = (r.params[0] as { data: string }).data;
        if (data.startsWith(toFunctionSelector('getVersion()'))) return ok(str('2.0.0'));
        if (data.startsWith(toFunctionSelector('ownerOf(uint256)'))) {
          return options.missing
            ? Promise.resolve(
                new Response(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: r.id,
                    error: {
                      code: 3,
                      data: `${toFunctionSelector('ERC721NonexistentToken(uint256)')}${'0'.repeat(64)}`,
                    },
                  }),
                ),
              )
            : ok(encodeAbiParameters([{ type: 'address' }], [`0x${'22'.repeat(20)}`]));
        }
        return ok(str('https://app.example.test/api/agent-card'));
      }
      default:
        return Promise.reject(new Error('unexpected'));
    }
  }) as unknown as typeof fetch;
}
const policyGenesis = (KNOWN_DEPLOYMENTS[0]?.policy as { genesisHash: string }).genesisHash;

describe('agent identity sidecar', () => {
  it('is not evaluated unless the core integrity matched, and reports absence as not included, never as failure', async () => {
    expect(await runIdentitySidecar({ ...base, coreIntact: false })).toMatchObject({
      status: 'not_evaluated',
    });
    expect(await runIdentitySidecar({ ...base, agentConfigs: [] })).toMatchObject({
      status: 'not_included',
      reason: 'NO_AGENT_CONFIG_ARTIFACT',
    });
    expect(await runIdentitySidecar({ ...base, agentConfigs: [configV1] })).toMatchObject({
      status: 'not_included',
      reason: 'NO_IDENTITY_REFERENCE',
    });
  });
  it('hash-correct but malformed or unsupported identity data is reported as such', async () => {
    expect(
      await runIdentitySidecar({
        ...base,
        agentConfigs: [
          bytes({
            schema: 'lexaegis.agent-config.v2',
            agentIdentity: { ...reference, agentId: 7 },
          }),
        ],
      }),
    ).toMatchObject({ status: 'malformed' });
    expect(
      await runIdentitySidecar({ ...base, agentConfigs: [new TextEncoder().encode('not json')] }),
    ).toMatchObject({ status: 'malformed' });
    expect(
      await runIdentitySidecar({
        ...base,
        agentConfigs: [bytes({ schema: 'lexaegis.agent-config.v9' })],
      }),
    ).toMatchObject({ status: 'unsupported_version' });
    expect(
      await runIdentitySidecar({
        ...base,
        agentConfigs: [bytes({ schema: 'lexaegis.agent-config.v1', agentIdentity: reference })],
      }),
    ).toMatchObject({ status: 'malformed' });
  });
  it("needs the caller's RPC and a policy it trusts: an unsupported network or no RPC is unavailable, not failure", async () => {
    expect(await runIdentitySidecar({ ...base, rpc: null })).toMatchObject({
      status: 'unavailable',
      reason: 'RPC_NOT_CONFIGURED',
    });
    const other = bytes({
      schema: 'lexaegis.agent-config.v2',
      agentIdentity: { ...reference, chainId: '143' },
    });
    expect(await runIdentitySidecar({ ...base, agentConfigs: [other] })).toMatchObject({
      status: 'unavailable',
      reason: 'NETWORK_UNSUPPORTED_NO_POLICY',
    });
  });
  it('resolves against the built-in testnet policy: registered, notFound and an RPC failure stay separate sidecar results', async () => {
    const registered = await runIdentitySidecar({ ...base, fetch: node() });
    expect(registered).toMatchObject({
      status: 'resolved',
      resolution: { status: 'registered', agent: { uri: { changed: false } } },
      card: null,
    });
    expect(
      (await runIdentitySidecar({ ...base, fetch: node({ missing: true }) })).resolution?.status,
    ).toBe('notFound');
    expect(
      (await runIdentitySidecar({ ...base, fetch: node({ down: true }) })).resolution,
    ).toMatchObject({ status: 'unavailable' });
  });
  it('fetches the card only when asked, only from the allowed origin, and a card failure leaves the registry observation', async () => {
    const asked = await runIdentitySidecar({
      ...base,
      fetch: node(),
      fetchCard: true,
      cardOrigins: ['https://other.example'],
      cardTransport: { get: () => Promise.reject(new Error('must not run')) },
    });
    expect(asked.resolution?.status).toBe('registered');
    expect(asked.card).toMatchObject({ status: 'unavailable', reason: 'ORIGIN_NOT_ALLOWED' });
    const noTransport = await runIdentitySidecar({
      ...base,
      fetch: node(),
      fetchCard: true,
      cardOrigins: ['https://app.example.test'],
      cardTransport: null,
    });
    expect(noTransport.card?.reason).toBe('TRANSPORT_UNAVAILABLE');
  });
});

describe('options and output contract', () => {
  const verify = ['verify', 'p.json', '--chain-id', '10143', '--registry', `0x${'11'.repeat(20)}`];
  it('options exist only for verify and only together', () => {
    expect(parseArguments([...verify, '--agent-identity'])).toMatchObject({
      kind: 'verify',
      agentIdentity: true,
      fetchAgentCard: false,
    });
    expect(
      parseArguments([
        ...verify,
        '--agent-identity',
        '--fetch-agent-card',
        '--agent-card-origin',
        'https://a.example',
      ]),
    ).toMatchObject({ fetchAgentCard: true });
    for (const extra of [
      ['--fetch-agent-card'],
      ['--agent-card-origin', 'https://a.example'],
      ['--agent-policy', 'p.json'],
    ]) {
      expect(parseArguments([...verify, ...extra])).toMatchObject({
        kind: 'usage-error',
        error: { code: 'USAGE_OPTION_REQUIRES' },
      });
    }
    const status = [
      'status',
      '--chain-id',
      '10143',
      '--registry',
      `0x${'11'.repeat(20)}`,
      '--reviewer',
      `0x${'22'.repeat(20)}`,
      '--commitment',
      `0x${'ab'.repeat(32)}`,
    ];
    expect(parseArguments([...status, '--agent-identity'])).toMatchObject({
      kind: 'usage-error',
      error: { code: 'USAGE_OPTION_UNKNOWN' },
    });
    expect(HELP).toContain('--agent-identity');
  });
  const core: CliResult = {
    command: 'verify',
    exit: EXIT.OK,
    filesEvaluated: true,
    report: null,
    error: null,
    rpcSource: 'flag',
    notes: [],
  };
  it('without the option the JSON is exactly the Chapter 15 document; with it, a versioned envelope around the unchanged core', () => {
    const plain = JSON.parse(formatJson(core)) as Record<string, unknown>;
    expect(plain.schema).toBe('lexaegis.cli-result.v1');
    expect('agentIdentity' in plain).toBe(false);
    const sidecar = {
      status: 'not_included' as const,
      reason: 'NO_IDENTITY_REFERENCE',
      reference: null,
      resolution: null,
      card: null,
    };
    const wrapped = JSON.parse(formatJson({ ...core, agentIdentity: sidecar })) as {
      schema: string;
      core: unknown;
      agentIdentity: unknown;
    };
    expect(wrapped.schema).toBe('lexaegis.cli-result-agent-identity.v1');
    expect(wrapped.core).toEqual(plain);
    expect(formatText({ ...core, agentIdentity: sidecar })).toContain('Agent identity (sidecar');
    expect(formatText(core)).not.toContain('Agent identity');
  });
});
