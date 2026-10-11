import { toBase64Url } from '@lexaegis/protocol/portable';
import { prepareReviewPackage } from '@lexaegis/protocol/v1';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { VerifierController } from './controller';
import { loadVerifierConfig } from './config';
import type { WorkerLike } from './local-job';
import { runVerificationJob, type JobInput } from './verification-job';
import type { WorkerRequest, WorkerResponse } from './verification-worker';
import { fakeFile } from './test-helpers';

const REGISTRY = '0x8004a818bfb912233c491871b3d84c89a494bd9e';
const GENESIS = `0x${'09'.repeat(32)}`;
const reference = {
  standard: 'erc-8004',
  chainId: '10143',
  identityRegistry: REGISTRY,
  agentId: '7',
  cardUri: 'https://app.example.test/api/agent-card',
};
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const ctx = {
  chainId: '10143',
  registryAddress: `0x${'11'.repeat(20)}`,
  reviewerAddress: `0x${'22'.repeat(20)}`,
};

/** A real package (source, decision log, agent configuration) as the recipient would receive it. */
async function packageWith(agentConfig: Uint8Array | null) {
  const { describeArtifact } = await import('@lexaegis/protocol/v1');
  const parts: {
    id: string;
    role: 'source' | 'decision-log' | 'agent-config';
    bytes: Uint8Array;
  }[] = [
    { id: 'd0000000-0000-4000-8000-000000000001', role: 'source', bytes: enc('document') },
    {
      id: 'd0000000-0000-4000-8000-000000000002',
      role: 'decision-log',
      bytes: enc({ decisions: [] }),
    },
    ...(agentConfig === null
      ? []
      : [
          {
            id: 'd0000000-0000-4000-8000-000000000003',
            role: 'agent-config' as const,
            bytes: agentConfig,
          },
        ]),
  ];
  const refs = await Promise.all(
    parts.map((p) =>
      describeArtifact(
        { id: p.id, role: p.role, mediaType: 'application/json', label: null },
        p.bytes,
      ),
    ),
  );
  const manifest = {
    schema: 'lexaegis.review-package.v1',
    packageId: 'd0000000-0000-4000-8000-0000000000aa',
    preparedAt: '2026-10-11T10:00:00.000Z',
    profile: { id: 'example.review', version: '1' },
    context: ctx,
    supersedes: null,
    artifacts: refs,
    approval: {
      intent: 'approve-review-package',
      scopeArtifactIds: parts.map((p) => p.id),
      decisionLogArtifactId: parts[1]?.id ?? '',
    },
  };
  const prepared = await prepareReviewPackage(manifest, new Map(parts.map((p) => [p.id, p.bytes])));
  if (!prepared.ok) throw new Error(prepared.error.code);
  const p = prepared.data;
  return enc({
    schema: 'lexaegis.review-export.v1',
    receiptReference: p.reference,
    opening: p.opening,
    artifacts: parts.map((part) => ({ artifactId: part.id, bytes: toBase64Url(part.bytes) })),
  });
}

const inProcessWorker = (): WorkerLike => {
  const self: WorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
    postMessage(message: WorkerRequest) {
      const post = (response: WorkerResponse) =>
        self.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
      void runVerificationJob(message.input as JobInput, () => undefined).then((outcome) =>
        post({ type: 'done', generation: message.generation, outcome }),
      );
    },
  };
  return self;
};

const str = (t: string) => encodeAbiParameters([{ type: 'string' }], [t]);
function registryNode() {
  const requests: string[] = [];
  const fetchLike = ((_u: string, init: { body: string }) => {
    const r = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    requests.push(r.method);
    const ok = (result: unknown) =>
      Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result })));
    if (r.method === 'eth_chainId') return ok('0x279f');
    if (r.method === 'eth_getBlockByNumber') {
      const tag = r.params[0];
      return ok({
        number: tag === 'finalized' ? '0x64' : tag,
        hash: tag === '0x0' ? GENESIS : `0x${'7'.repeat(64)}`,
        timestamp: '0x1',
      });
    }
    if (r.method === 'eth_getCode') return ok('0x6080');
    if (r.method === 'eth_getStorageAt') return ok(`0x${'0'.repeat(64)}`);
    const data = (r.params[0] as { data: Hex }).data;
    if (data.startsWith(toFunctionSelector('getVersion()'))) return ok(str('2.0.0'));
    if (data.startsWith(toFunctionSelector('ownerOf(uint256)')))
      return ok(encodeAbiParameters([{ type: 'address' }], [`0x${'33'.repeat(20)}`]));
    return ok(str('https://app.example.test/other-card'));
  }) as unknown as typeof fetch;
  return { fetchLike, requests };
}
const agentPolicy = {
  id: 'test.erc8004',
  chainId: '10143',
  genesisHash: GENESIS,
  identityRegistry: REGISTRY,
  executionDelayBlocks: 3,
};
const make = (
  feature: { enabled: boolean; policy: typeof agentPolicy | null },
  fetchLike?: typeof fetch,
) =>
  new VerifierController({
    createWorker: inProcessWorker,
    policy: null,
    rpcUrl: 'https://rpc.example.test/',
    ...(fetchLike !== undefined && { fetch: fetchLike }),
    agentIdentity: feature,
  });

describe('verifier agent identity sidecar', () => {
  it('reads the reference only from integrity-checked bytes, and absence is not a failure', async () => {
    const withIdentity = make({ enabled: true, policy: agentPolicy });
    await withIdentity.chooseFile(
      fakeFile(
        await packageWith(enc({ schema: 'lexaegis.agent-config.v2', agentIdentity: reference })),
      ).file,
    );
    expect(withIdentity.getSnapshot().local?.agentIdentity).toMatchObject({
      status: 'included',
      reference: { agentId: '7' },
    });
    const without = make({ enabled: true, policy: agentPolicy });
    await without.chooseFile(fakeFile(await packageWith(null)).file);
    expect(without.getSnapshot().local?.agentIdentity).toEqual({ status: 'not_included' });
    expect(without.getSnapshot().report).toMatchObject({
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
    });
  });
  it('malformed identity data in hash-correct bytes leaves the proof result untouched', async () => {
    const controller = make({ enabled: true, policy: agentPolicy });
    await controller.chooseFile(
      fakeFile(
        await packageWith(
          enc({ schema: 'lexaegis.agent-config.v2', agentIdentity: { ...reference, agentId: 7 } }),
        ),
      ).file,
    );
    expect(controller.getSnapshot().local?.agentIdentity).toEqual({ status: 'malformed' });
    expect(controller.getSnapshot().report).toMatchObject({
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
    });
  });
  it('is not read when the files do not match', async () => {
    const bytes = await packageWith(
      enc({ schema: 'lexaegis.agent-config.v2', agentIdentity: reference }),
    );
    const tampered = JSON.parse(new TextDecoder().decode(bytes)) as {
      artifacts: { bytes: string }[];
    };
    tampered.artifacts[0] = {
      ...tampered.artifacts[0],
      bytes: toBase64Url(enc('changed')),
    };
    const controller = make({ enabled: true, policy: agentPolicy });
    await controller.chooseFile(fakeFile(enc(tampered)).file);
    expect(controller.getSnapshot().local?.agentIdentity).toBeNull();
  });
  it('resolves only on an explicit check, shows a changed card address separately and makes no request before it', async () => {
    const node = registryNode();
    const controller = make({ enabled: true, policy: agentPolicy }, node.fetchLike);
    await controller.chooseFile(
      fakeFile(
        await packageWith(enc({ schema: 'lexaegis.agent-config.v2', agentIdentity: reference })),
      ).file,
    );
    expect(node.requests).toEqual([]);
    expect(controller.canCheckAgentIdentity).toBe(true);
    await controller.checkAgentIdentity();
    expect(controller.getSnapshot().identity).toMatchObject({
      status: 'registered',
      agent: { uri: { changed: true } },
    });
    // The proof result is the same object it was: identity is a sidecar.
    expect(controller.getSnapshot().report).toMatchObject({
      manifestIntegrity: 'match',
      chainStatus: 'unknown',
    });
    expect(
      node.requests.every((m) =>
        [
          'eth_chainId',
          'eth_getBlockByNumber',
          'eth_getCode',
          'eth_getStorageAt',
          'eth_call',
        ].includes(m),
      ),
    ).toBe(true);
  });
  it('is inert when the feature is off: no check is possible and no request is made', async () => {
    const node = registryNode();
    const off = make({ enabled: false, policy: null }, node.fetchLike);
    await off.chooseFile(
      fakeFile(
        await packageWith(enc({ schema: 'lexaegis.agent-config.v2', agentIdentity: reference })),
      ).file,
    );
    expect(off.canCheckAgentIdentity).toBe(false);
    await off.checkAgentIdentity();
    expect(node.requests).toEqual([]);
    expect(loadVerifierConfig({}).agentIdentityEnabled).toBe(false);
    expect(loadVerifierConfig({ VITE_AGENT_IDENTITY: 'true' }).agentIdentityEnabled).toBe(true);
  });
  it('a new input or Clear discards a pending or earlier identity result', async () => {
    const node = registryNode();
    const controller = make({ enabled: true, policy: agentPolicy }, node.fetchLike);
    await controller.chooseFile(
      fakeFile(
        await packageWith(enc({ schema: 'lexaegis.agent-config.v2', agentIdentity: reference })),
      ).file,
    );
    await controller.checkAgentIdentity();
    expect(controller.getSnapshot().identity).not.toBeNull();
    controller.clear();
    expect(controller.getSnapshot()).toMatchObject({ identity: null, identityPhase: 'idle' });
  });
});
