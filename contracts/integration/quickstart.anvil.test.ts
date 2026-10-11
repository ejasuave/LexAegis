import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proofOfReviewRegistryAbi as abi } from '@lexaegis/sdk/registry';
import { verifyReceipt } from '@lexaegis/sdk/verify';
import {
  issueReview,
  supersedeReview,
  type ChainAccess,
  type LifecycleInput,
  type OpeningStore,
  type ReviewSigner,
  type SubmissionSummary,
} from '../../examples/document-review/src/lifecycle';
import { prepareExample, prepareReplacement } from '../../examples/document-review/src/prepare';
import { viemChainAccess } from '../../examples/document-review/src/viem-access';
import { accounts } from './harness';
import { exportBytes, startLocalRegistry, type LocalRegistry } from './local-registry';

/*
 * QUICKSTART PATH 3, LOCAL COMPOSITION. The document-review example's issue and supersede flow runs
 * against the unchanged registry on an isolated Anvil chain with an INJECTED, test-only signer (a
 * published development key that lives only in this test harness; the example holds none). Public
 * network execution stays manual and outside every check. Not Monad evidence.
 */

let chain: LocalRegistry;
let directory: string;
let access: ChainAccess;
const events: string[] = [];

const client = () =>
  createPublicClient({ chain: foundry, transport: http(chain.local.rpcUrl), pollingInterval: 50 });

/** The adapter a caller writes around their own wallet. Here it wraps a development account. */
const signer: ReviewSigner = {
  address: accounts.reviewer.address,
  signTypedData: (typedData) => accounts.reviewer.signTypedData(typedData),
};

const store: OpeningStore = {
  save: (prepared) => {
    events.push('store');
    writeFileSync(
      join(directory, `${prepared.reference.commitment}.opening.json`),
      exportBytes(prepared),
    );
    return Promise.resolve();
  },
};

const approving = (seen: SubmissionSummary[]) => (summary: SubmissionSummary) => {
  events.push('approve');
  seen.push(summary);
  return Promise.resolve(true);
};

const input = (overrides: Partial<LifecycleInput> = {}): LifecycleInput => ({
  signer,
  chain: access,
  store,
  approve: approving([]),
  ...overrides,
});

const nonce = async () =>
  (
    await client().readContract({
      address: chain.registry,
      abi,
      functionName: 'nonceOf',
      args: [accounts.reviewer.address],
    })
  ).toString();

beforeAll(async () => {
  chain = await startLocalRegistry();
  directory = mkdtempSync(join(tmpdir(), 'quickstart-'));
  const executorClient = createWalletClient({
    account: accounts.executor,
    chain: foundry,
    transport: http(chain.local.rpcUrl),
  });
  const counting = viemChainAccess({
    publicClient: client(),
    executorClient,
    registryAddress: chain.registry,
    live: {
      policy: chain.policy,
      transport: { kind: 'rpc', url: `${chain.local.rpcUrl}/`, allowLoopbackHttp: true },
    },
    readNonce: async (reviewer) =>
      client().readContract({
        address: chain.registry,
        abi,
        functionName: 'nonceOf',
        args: [reviewer as Hex],
      }),
  });
  access = {
    ...counting,
    // Local chain: advance blocks instead of sleeping so the verified checkpoint reaches the receipt.
    pause: () => chain.mine(5).then(() => undefined),
    send: (calldata, quote) => {
      events.push('send');
      return counting.send(calldata, quote);
    },
  };
  await chain.mine();
}, 120_000);

afterAll(async () => {
  rmSync(directory, { recursive: true, force: true });
  await chain.stop();
});

const context = () => ({
  chainId: chain.binding.chainId,
  registryAddress: chain.registry,
  reviewerAddress: chain.binding.reviewerAddress,
});

describe('document-review lifecycle on a real local registry', () => {
  it('stores the opening before anything is sent, asks for approval, and confirms by reading the registry', async () => {
    events.length = 0;
    const seen: SubmissionSummary[] = [];
    const { prepared } = await prepareExample(context());
    const before = await nonce();

    const result = await issueReview(prepared, input({ approve: approving(seen) }));
    expect(result.status).toBe('confirmed');
    // Order is the contract: the private opening is saved, the human approves, then it is sent.
    expect(events).toEqual(['store', 'approve', 'send']);
    expect(existsSync(join(directory, `${prepared.reference.commitment}.opening.json`))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      action: 'ISSUE',
      reviewerAddress: chain.binding.reviewerAddress,
      commitment: prepared.reference.commitment,
      replacementCommitment: null,
      registryNonce: before,
    });
    expect(seen[0]?.maxFeeWei).toBeGreaterThan(0n);
    expect(await nonce()).toBe(String(Number(before) + 1));
    if (result.status === 'confirmed') {
      expect(result.reports[0]).toMatchObject({
        chainStatus: 'active',
        receiptBinding: 'match',
        registryIdentity: 'match',
        referenceOrigin: 'independent',
      });
    }
  });

  it('a retry after a lost response sends nothing: the record already exists', async () => {
    const { prepared } = await prepareExample(context());
    expect((await issueReview(prepared, input())).status).toBe('confirmed');
    events.length = 0;
    const before = await nonce();
    const again = await issueReview(prepared, input());
    expect(again).toEqual({ status: 'already_recorded', chainStatus: 'active' });
    expect(events).toEqual(['store']); // the opening is still kept; nothing was approved or sent
    expect(await nonce()).toBe(before);
  });

  it('a refused approval sends nothing and consumes no nonce', async () => {
    const { prepared } = await prepareExample(context());
    events.length = 0;
    const before = await nonce();
    const result = await issueReview(prepared, input({ approve: () => Promise.resolve(false) }));
    expect(result).toEqual({ status: 'declined' });
    expect(events).toEqual(['store']);
    expect(await nonce()).toBe(before);
    const read = await verifyReceipt({
      mode: 'reference-only',
      expectedReference: prepared.reference,
      referenceOrigin: 'independent',
      live: access.live,
    });
    expect(read.ok && read.data.report.chainStatus).toBe('not_found');
  });

  it('refuses before touching the chain when the opening cannot be stored or the signer is not the reviewer', async () => {
    const { prepared } = await prepareExample(context());
    events.length = 0;
    const failing: OpeningStore = { save: () => Promise.reject(new Error('disk full')) };
    expect(await issueReview(prepared, input({ store: failing }))).toEqual({
      status: 'failed',
      code: 'OPENING_NOT_STORED',
    });
    const other: ReviewSigner = { ...signer, address: accounts.stranger.address };
    expect(await issueReview(prepared, input({ signer: other }))).toEqual({
      status: 'failed',
      code: 'SIGNER_MISMATCH',
    });
    expect(events).not.toContain('send');
    expect(events).not.toContain('approve');
  });

  it('refuses a fee above the ceiling before asking for approval', async () => {
    const { prepared } = await prepareExample(context());
    events.length = 0;
    const costly: ChainAccess = {
      ...access,
      quote: async (calldata) => ({
        ...(await access.quote(calldata)),
        gasLimit: 900_000n,
        maxFeePerGas: 10n ** 18n,
      }),
    };
    expect(await issueReview(prepared, input({ chain: costly }))).toEqual({
      status: 'failed',
      code: 'FEE_CHECK_FAILED',
    });
    expect(events).toEqual(['store']);
  });

  it('supersedes with revised bytes, a fresh opening and the exact predecessor; the old one reads Superseded', async () => {
    const original = await prepareExample(context());
    expect((await issueReview(original.prepared, input())).status).toBe('confirmed');

    const revised = await prepareReplacement(
      context(),
      original.reference,
      'Revised synthetic text.\n',
    );
    // Actual revised bytes, a fresh opening, and exactly the predecessor named.
    const revisedSource = revised.prepared.opening.manifest.artifacts.find(
      (a) => a.role === 'source',
    );
    const originalSource = original.prepared.opening.manifest.artifacts.find(
      (a) => a.role === 'source',
    );
    expect(revisedSource?.sha256).not.toBe(originalSource?.sha256);
    expect(revised.prepared.opening.blindingNonce).not.toBe(
      original.prepared.opening.blindingNonce,
    );
    expect(revised.prepared.opening.manifest.supersedes).toEqual(original.reference);

    events.length = 0;
    const seen: SubmissionSummary[] = [];
    const result = await supersedeReview(
      original.reference,
      revised.prepared,
      input({ approve: approving(seen) }),
    );
    expect(result.status).toBe('confirmed');
    expect(events).toEqual(['store', 'approve', 'send']);
    expect(seen[0]).toMatchObject({
      action: 'SUPERSEDE',
      commitment: original.reference.commitment,
      replacementCommitment: revised.reference.commitment,
    });
    if (result.status === 'confirmed') {
      expect(result.reports.map((report) => report.chainStatus)).toEqual(['superseded', 'active']);
    }

    // Revoking the replacement never reactivates the predecessor.
    await chain.revoke(revised.reference);
    await chain.mine();
    const predecessor = await verifyReceipt({
      mode: 'reference-only',
      expectedReference: original.reference,
      referenceOrigin: 'independent',
      live: access.live,
    });
    expect(predecessor.ok && predecessor.data.report.chainStatus).toBe('superseded');
  });

  it('supersede refuses a predecessor that is not Active, and a replacement that names another predecessor', async () => {
    const original = await prepareExample(context());
    const revised = await prepareReplacement(context(), original.reference, 'Another revision.\n');
    // The predecessor was never issued: nothing can replace it.
    expect(await supersedeReview(original.reference, revised.prepared, input())).toEqual({
      status: 'failed',
      code: 'PRECONDITION_NOT_MET',
    });
    expect((await issueReview(original.prepared, input())).status).toBe('confirmed');
    const unrelated = await prepareExample(context());
    const result = await supersedeReview(original.reference, unrelated.prepared, input());
    expect(result).toEqual({ status: 'failed', code: 'ACTION_INVALID' });
  });

  it('the example holds no key and the opening file is the readable export', () => {
    const lifecycle = readFileSync(
      join(import.meta.dirname, '..', '..', 'examples', 'document-review', 'src', 'lifecycle.ts'),
      'utf8',
    );
    expect(lifecycle).not.toMatch(/privateKey|mnemonic|privateKeyToAccount|process\.env/i);
  });
});
