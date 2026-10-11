import { encodeAbiParameters, decodeFunctionData, keccak256, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { proofOfReviewRegistryAbi } from '@lexaegis/sdk/registry';
import type { RegistryPolicy } from '@lexaegis/sdk';
import { VerifierController } from './controller';
import type { WorkerLike } from './local-job';
import { runVerificationJob, type JobInput } from './verification-job';
import type { WorkerRequest, WorkerResponse } from './verification-worker';
import { exportBytes, fakeFile, referenceOf } from './test-helpers';
import {
  resultJson,
  projectResult,
  RESULT_FILE_NAME,
  verificationResultV1Schema,
} from './result-export';
import { decodeReviewExport } from '@lexaegis/protocol/portable';

const CODE = '0x6001600155' as Hex;
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const NOW = () => new Date('2026-10-09T12:00:00.000Z');

const inProcessWorker = (): WorkerLike => {
  const self: WorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
    postMessage(message: WorkerRequest) {
      const post = (response: WorkerResponse) =>
        self.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
      void runVerificationJob(message.input as JobInput, (update) =>
        post({ type: 'progress', generation: message.generation, update }),
      ).then((outcome) => post({ type: 'done', generation: message.generation, outcome }));
    },
  };
  return self;
};

const policy = (): RegistryPolicy => ({
  id: 'test.registry',
  chainId: '31337',
  genesisHash: hashOf(0n),
  registryAddress: referenceOf('legal').registryAddress,
  protocolVersion: '1',
  deploymentBlock: '10',
  deploymentTransactionHash: hashOf(7n),
  runtimeCodeKeccak256: keccak256(CODE),
  executionDelayBlocks: 3,
  executionDelayRevision: 'test',
});

/** A scripted public RPC endpoint behind fetch: records every request, answers like a registry. */
function rpc(status: 'active' | 'down') {
  const requests: { url: string; body: string }[] = [];
  const fetchLike = (url: string, init: RequestInit): Promise<Response> => {
    const body = typeof init.body === 'string' ? init.body : '';
    requests.push({ url, body });
    if (status === 'down') return Promise.reject(new TypeError('Failed to fetch'));
    const { id, method, params } = JSON.parse(body) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const reply = (result: unknown) =>
      Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id, result })));
    const block = (n: bigint) => ({
      number: `0x${n.toString(16)}`,
      hash: hashOf(n),
      timestamp: '0x64',
    });
    if (method === 'eth_chainId') return reply('0x7a69');
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0] as string;
      return reply(block(tag === 'finalized' ? 100n : BigInt(tag)));
    }
    if (method === 'eth_getCode') return reply(CODE);
    const call = params[0] as { data: Hex };
    const decoded = decodeFunctionData({ abi: proofOfReviewRegistryAbi, data: call.data });
    if (decoded.functionName === 'protocolVersion')
      return reply(encodeAbiParameters([{ type: 'uint256' }], [1n]));
    if (decoded.functionName === 'nonceOf')
      return reply(encodeAbiParameters([{ type: 'uint256' }], [2n]));
    return reply(
      encodeAbiParameters(
        [
          { type: 'uint8' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        [1, hashOf(0n), hashOf(0n), 1_800_000_001n, 1_800_000_001n],
      ),
    );
  };
  return { fetchLike, requests };
}

const make = (extra: Partial<ConstructorParameters<typeof VerifierController>[0]> = {}) =>
  new VerifierController({
    createWorker: inProcessWorker,
    policy: policy(),
    rpcUrl: 'https://rpc.example.test/',
    now: NOW,
    ...extra,
  });

describe('verifier controller', () => {
  it('checks a chosen file locally without any network request', async () => {
    const network = rpc('active');
    const controller = make({ fetch: network.fetchLike });
    const { file } = fakeFile(exportBytes('legal'));
    await controller.chooseFile(file);
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.report).toMatchObject({
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
      referenceOrigin: 'file-declared',
      chainStatus: 'unknown',
    });
    expect(network.requests).toEqual([]);
  });

  it('refuses an oversized file without reading it', async () => {
    const controller = make();
    const read = vi.fn();
    const big = { name: 'x.json', size: 49 * 1024 * 1024, arrayBuffer: read } as unknown as File;
    await controller.chooseFile(big);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', failure: 'FILE_TOO_LARGE' });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the independent reference separate; a mismatch is never resolved by the file', async () => {
    const controller = make();
    controller.setReferenceText(JSON.stringify(referenceOf('legal')));
    await controller.chooseFile(fakeFile(exportBytes('generic')).file);
    expect(controller.getSnapshot().report).toMatchObject({
      referenceOrigin: 'independent',
      manifestIntegrity: 'mismatch',
    });
    controller.setReferenceText('{"broken"');
    expect(controller.getSnapshot().referenceInvalid).toBe(true);
    await controller.checkFiles();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'failed',
      failure: 'REFERENCE_INVALID',
    });
  });

  it('inspects a public reference with no files and no network', async () => {
    const network = rpc('active');
    const controller = make({ fetch: network.fetchLike });
    await controller.inspectReference(JSON.stringify(referenceOf('legal')));
    expect(controller.getSnapshot()).toMatchObject({
      inputKind: 'reference',
      report: {
        mode: 'reference-only',
        manifestIntegrity: 'unknown',
        artifactIntegrity: 'unknown',
      },
    });
    expect(network.requests).toEqual([]);
  });

  it('checks the registry only on explicit action, sends no private content, and keeps local results', async () => {
    const network = rpc('active');
    const controller = make({ fetch: network.fetchLike });
    const bundle = exportBytes('legal');
    await controller.chooseFile(fakeFile(bundle).file);
    expect(controller.canCheckRegistry).toBe(true);
    await controller.checkRegistry();
    const { report, livePhase } = controller.getSnapshot();
    expect(livePhase).toBe('done');
    expect(report).toMatchObject({
      registryIdentity: 'match',
      receiptBinding: 'match',
      chainStatus: 'active',
      artifactIntegrity: 'match',
      checkpoint: { blockNumber: '97' },
    });
    // Only the explicitly selected origin was contacted, with public parameters only.
    const reference = referenceOf('legal');
    const all = network.requests.map((r) => r.body).join('\n');
    expect(network.requests.every((r) => r.url === 'https://rpc.example.test/')).toBe(true);
    expect(all).not.toContain('blindingNonce');
    expect(all).not.toContain('sha256');
    expect(all).not.toContain(reference.registryAddress.slice(2, 8) === '' ? 'never' : 'filename');
    for (const sensitive of ['bundle.json', 'artifacts', 'label', 'manifest']) {
      expect(all).not.toContain(sensitive);
    }
  });

  it('keeps local results and the last good status when a refresh fails', async () => {
    let up = true;
    const good = rpc('active');
    const bad = rpc('down');
    const controller = make({
      fetch: (url, init) => (up ? good.fetchLike(url, init) : bad.fetchLike(url, init)),
    });
    await controller.chooseFile(fakeFile(exportBytes('legal')).file);
    await controller.checkRegistry();
    expect(controller.getSnapshot().lastObserved?.chainStatus).toBe('active');
    up = false;
    await controller.checkRegistry();
    const snapshot = controller.getSnapshot();
    expect(snapshot.livePhase).toBe('failed');
    expect(snapshot.refreshFailed).toBe(true);
    expect(snapshot.lastObserved?.chainStatus).toBe('active');
    expect(snapshot.report).toMatchObject({ chainStatus: 'unknown', artifactIntegrity: 'match' });
    expect(snapshot.report?.issues.map((i) => i.code)).toContain('LIVE_RPC_UNAVAILABLE');
  });

  it('a signer-rule change invalidates the registry result; an unset rule stays unknown', async () => {
    const controller = make({ fetch: rpc('active').fetchLike });
    await controller.chooseFile(fakeFile(exportBytes('legal')).file);
    expect(controller.getSnapshot().report?.signerAcceptance).toBe('unknown');
    await controller.checkRegistry();
    expect(controller.getSnapshot().livePhase).toBe('done');
    controller.setSignerText(referenceOf('legal').reviewerAddress);
    expect(controller.getSnapshot()).toMatchObject({ livePhase: 'idle', lastObserved: null });
    await vi.waitFor(() =>
      expect(controller.getSnapshot().report?.signerAcceptance).toBe('accepted'),
    );
    controller.setSignerText('not an address');
    expect(controller.getSnapshot().signerInvalid).toBe(true);
    expect(controller.canCheckRegistry).toBe(false);
  });

  it('an unconfigured registry cannot be checked, and a bad endpoint is a configuration error', async () => {
    const controller = make({ policy: null });
    await controller.chooseFile(fakeFile(exportBytes('legal')).file);
    expect(controller.canCheckRegistry).toBe(false);
    const other = make();
    await other.chooseFile(fakeFile(exportBytes('legal')).file);
    other.setRpcUrl('http://rpc.example.test/');
    expect(other.getSnapshot().rpcError).toBe('NOT_HTTPS');
    expect(other.canCheckRegistry).toBe(false);
    other.setRpcUrl('https://user:secret@rpc.example.test/');
    expect(other.getSnapshot().rpcError).toBe('HAS_CREDENTIALS');
  });

  it('Clear removes the input and every result; a late result is discarded', async () => {
    const controller = make({ fetch: rpc('active').fetchLike });
    await controller.chooseFile(fakeFile(exportBytes('legal')).file);
    const pending = controller.checkRegistry();
    controller.clear();
    await pending;
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'idle',
      inputKind: 'none',
      local: null,
      report: null,
      livePhase: 'idle',
      fileName: null,
    });
  });

  it('Cancel stops a running registry check and keeps the local result', async () => {
    const slow = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const controller = make({ fetch: slow });
    await controller.chooseFile(fakeFile(exportBytes('legal')).file);
    const pending = controller.checkRegistry();
    controller.cancel();
    await pending;
    expect(controller.getSnapshot()).toMatchObject({ livePhase: 'idle', phase: 'ready' });
    expect(controller.getSnapshot().local).not.toBeNull();
  });
});

describe('downloaded verification result', () => {
  it('is a public-field projection with no opening, digest, label, artifact id or endpoint', async () => {
    const controller = make({ fetch: rpc('active').fetchLike });
    await controller.chooseFile(fakeFile(exportBytes('legal'), 'My Settlement.json').file);
    await controller.checkRegistry();
    const report = controller.getSnapshot().report;
    if (report === null) throw new Error('no report');
    const text = resultJson(report);
    const projection = verificationResultV1Schema.parse(JSON.parse(text));
    expect(projection.checks).toMatchObject({ chainStatus: 'active', manifestIntegrity: 'match' });
    for (const secret of [
      'blindingNonce',
      'sha256',
      'label',
      'My Settlement',
      'rpc.example.test',
      'artifactId',
      'employment-settlement',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/valid/i);
    expect(RESULT_FILE_NAME).not.toMatch(/[0-9a-f]{8}/);
    expect(projectResult(report).issues.every((code) => !/^[0-9a-f-]{36}$/.test(code))).toBe(true);
  });

  it('is never accepted as a review package', () => {
    const controllerless = new TextEncoder().encode(
      JSON.stringify({ schema: 'lexaegis.verification-result.v1' }),
    );
    const decoded = decodeReviewExport(controllerless);
    expect(decoded.ok).toBe(false);
  });
});
