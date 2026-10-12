import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  type Hex,
  type LocalAccount,
} from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedReviewPackage, ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import {
  REVIEW_ACTION_CODES,
  buildIssueAction,
  buildRevokeAction,
  buildSupersedeAction,
  buildTypedData,
  defaultActionDeadline,
  proofOfReviewRegistryAbi as abi,
  toAbiReviewAction,
  toEip712ReviewAction,
  liveClientFromViem,
  type BoundReviewAction,
} from '@lexaegis/sdk/registry';
import { expectedReviewersPolicy, type RegistryPolicy } from '@lexaegis/sdk/offline';
import { verifyReceipt, type LiveTransport } from '@lexaegis/sdk/verify';
import { startAnvil, type LocalChain } from '../scripts/lib/anvil';
import {
  accounts,
  creationCode,
  expectOk,
  lower,
  prepareLocalPackage,
  type LocalBinding,
} from './harness';

/*
 * LOCAL COMPATIBILITY EVIDENCE ONLY. The SDK's verifyReceipt reads the real compiled registry on a
 * throwaway Anvil chain (chain 31337) through two transports: a viem client and the SDK's own
 * JSON-RPC client over loopback HTTP. Reports are compared with the contract's own records. Local
 * keys and deterministic addresses are test-only. None of this is a Monad deployment or live
 * evidence, and Anvil does not establish Monad finality behaviour.
 */

const GAS = 1_000_000n;
let local: LocalChain;
let registry: Hex;
let binding: LocalBinding;
let policy: RegistryPolicy;

const client = () =>
  createPublicClient({ chain: foundry, transport: http(local.rpcUrl), pollingInterval: 50 });
const walletFor = (account: LocalAccount) =>
  createWalletClient({ account, chain: foundry, transport: http(local.rpcUrl) });
const mine = (count = 100) => local.transport.request('anvil_mine', [`0x${count.toString(16)}`]);

async function nonceOf(address: string): Promise<string> {
  return (
    await client().readContract({
      address: registry,
      abi,
      functionName: 'nonceOf',
      args: [address as Hex],
    })
  ).toString();
}

async function deadline(): Promise<string> {
  const { timestamp } = await client().getBlock();
  return expectOk(defaultActionDeadline(timestamp.toString()));
}

/** Signs with the given local account and submits through an unrelated executor. */
async function execute(
  bound: BoundReviewAction,
  signer: LocalAccount,
): Promise<'success' | 'reverted'> {
  const typedData = expectOk(buildTypedData(bound, bound.chainId, bound.registryAddress));
  const action = expectOk(toAbiReviewAction(bound.action));
  const signature = await signer.signTypedData(expectOk(toEip712ReviewAction(typedData)));
  const hash = await walletFor(accounts.executor).sendTransaction({
    to: registry,
    data: encodeFunctionData({ abi, functionName: 'execute', args: [action, signature] }),
    gas: GAS,
  });
  const receipt = await client().waitForTransactionReceipt({ hash });
  return receipt.status;
}

async function contractRecord(reference: ReceiptReferenceV1) {
  return client().readContract({
    address: registry,
    abi,
    functionName: 'getReceipt',
    args: [reference.reviewerAddress as Hex, reference.commitment as Hex],
  });
}

const STATUS = ['not_found', 'active', 'revoked', 'superseded'] as const;

const transports = (): { name: string; transport: LiveTransport }[] => [
  { name: 'viem client', transport: { kind: 'client', client: liveClientFromViem(client()) } },
  {
    name: 'SDK JSON-RPC over loopback HTTP',
    transport: { kind: 'rpc', url: `${local.rpcUrl}/`, allowLoopbackHttp: true },
  },
];

async function check(
  prepared: PreparedReviewPackage,
  extra: { inspectSuccessors?: boolean; reviewers?: string[]; transport?: LiveTransport } = {},
) {
  const result = await verifyReceipt({
    mode: 'full-package',
    expectedReference: prepared.reference,
    referenceOrigin: 'independent',
    opening: prepared.opening,
    artifacts: prepared.artifacts(),
    ...(extra.reviewers !== undefined && {
      signerPolicy: expectedReviewersPolicy('test.reviewers', extra.reviewers),
    }),
    live: {
      policy,
      transport: extra.transport ?? { kind: 'client', client: liveClientFromViem(client()) },
      ...(extra.inspectSuccessors === true && { inspectSuccessors: true }),
    },
  });
  if (!result.ok) throw new Error(`verifyReceipt failed: ${result.error.code}`);
  return result.data.report;
}

beforeAll(async () => {
  local = await startAnvil();
  const bytecode = creationCode('ProofOfReviewRegistry.sol', 'ProofOfReviewRegistry');
  const hash = await walletFor(accounts.deployer).deployContract({ abi, bytecode });
  const deployed = await client().waitForTransactionReceipt({ hash });
  if (deployed.contractAddress == null) throw new Error('no contract address');
  registry = lower(deployed.contractAddress) as Hex;
  binding = {
    chainId: local.chainId.toString(),
    registryAddress: registry,
    reviewerAddress: lower(accounts.reviewer.address),
  };
  const genesis = await client().getBlock({ blockNumber: 0n });
  const code = await client().getCode({ address: registry });
  policy = {
    id: 'test.anvil-registry',
    chainId: binding.chainId,
    genesisHash: genesis.hash,
    registryAddress: registry,
    protocolVersion: '1',
    deploymentBlock: deployed.blockNumber.toString(),
    deploymentTransactionHash: hash,
    runtimeCodeKeccak256: keccak256(code ?? '0x'),
    executionDelayBlocks: 3,
    executionDelayRevision: 'local-anvil-test',
  };
});

afterAll(async () => {
  await local.stop();
});

describe('[registry-supersession-and-successor-binding] SDK verification against the real registry on local Anvil', () => {
  let original: PreparedReviewPackage;
  let replacement: PreparedReviewPackage;

  it('reports not_found only after a successful verified read of the registry', async () => {
    original = await prepareLocalPackage('legal', binding, null);
    await mine();
    for (const { name, transport } of transports()) {
      const report = await check(original, { transport });
      expect(report, name).toMatchObject({
        registryIdentity: 'match',
        chainStatus: 'not_found',
        receiptBinding: 'unknown',
        artifactIntegrity: 'match',
      });
    }
    // Wrong registry code is an identity mismatch, never not_found.
    const wrong = await verifyReceipt({
      mode: 'full-package',
      expectedReference: original.reference,
      referenceOrigin: 'independent',
      opening: original.opening,
      artifacts: original.artifacts(),
      live: {
        policy: { ...policy, runtimeCodeKeccak256: `0x${'ab'.repeat(32)}` },
        transport: { kind: 'client', client: liveClientFromViem(client()) },
      },
    });
    expect(wrong.ok && wrong.data.report).toMatchObject({
      registryIdentity: 'mismatch',
      chainStatus: 'unknown',
    });
  });

  it('reports Active for an EOA receipt issued by an unrelated executor, and judges the reviewer not the sender', async () => {
    const bound = expectOk(
      buildIssueAction(original, await nonceOf(binding.reviewerAddress), await deadline()),
    );
    expect(await execute(bound, accounts.reviewer)).toBe('success');
    await mine();
    const record = await contractRecord(original.reference);
    for (const { name, transport } of transports()) {
      const report = await check(original, {
        transport,
        reviewers: [binding.reviewerAddress],
      });
      // The report equals the contract's own record, not a hard-coded success.
      expect(report.chainStatus, name).toBe(STATUS[record.status]);
      expect(report, name).toMatchObject({
        chainStatus: 'active',
        receiptBinding: 'match',
        registryIdentity: 'match',
        signerAcceptance: 'accepted',
        artifactIntegrity: 'match',
      });
      expect(report.checkpoint?.chainId).toBe(binding.chainId);
    }
    // The transaction sender is not an acceptance policy.
    const executorOnly = await check(original, { reviewers: [lower(accounts.executor.address)] });
    expect(executorOnly.signerAcceptance).toBe('rejected');
  });

  it('keeps the predecessor Superseded after a replacement is revoked, and reads the link as separate', async () => {
    replacement = await prepareLocalPackage('legal-revised', binding, original.reference);
    const supersede = expectOk(
      buildSupersedeAction(
        original.reference,
        replacement,
        await nonceOf(binding.reviewerAddress),
        await deadline(),
      ),
    );
    expect(await execute(supersede, accounts.reviewer)).toBe('success');
    await mine();
    const first = await check(original, { inspectSuccessors: true });
    expect(first).toMatchObject({
      chainStatus: 'superseded',
      history: {
        complete: true,
        successors: [{ chainStatus: 'active', packageIntegrity: 'unknown' }],
      },
    });
    const bound = await check(replacement);
    expect(bound).toMatchObject({ chainStatus: 'active', receiptBinding: 'match' });

    const revoke = expectOk(
      buildRevokeAction(
        replacement.reference,
        await nonceOf(binding.reviewerAddress),
        await deadline(),
      ),
    );
    expect(await execute(revoke, accounts.reviewer)).toBe('success');
    await mine();
    const after = await check(original, { inspectSuccessors: true });
    // Revoking the successor never reactivates the original.
    expect(after.chainStatus).toBe('superseded');
    expect(after.history?.successors[0]?.chainStatus).toBe('revoked');
    expect((await check(replacement)).chainStatus).toBe('revoked');
  });

  it('detects a predecessor the manifest does not declare, using a real registry record', async () => {
    const first = await prepareLocalPackage('legal', binding, null);
    const second = await prepareLocalPackage('legal', binding, null);
    for (const prepared of [first]) {
      const issue = expectOk(
        buildIssueAction(prepared, await nonceOf(binding.reviewerAddress), await deadline()),
      );
      expect(await execute(issue, accounts.reviewer)).toBe('success');
    }
    // A hand-built SUPERSEDE whose replacement's own manifest does not name `first` as predecessor.
    const crooked: BoundReviewAction = {
      chainId: binding.chainId,
      registryAddress: registry,
      action: {
        reviewer: binding.reviewerAddress,
        action: REVIEW_ACTION_CODES.SUPERSEDE,
        commitment: first.reference.commitment,
        replacementCommitment: second.reference.commitment,
        nonce: await nonceOf(binding.reviewerAddress),
        deadline: await deadline(),
      },
    };
    expect(await execute(crooked, accounts.reviewer)).toBe('success');
    await mine();
    const report = await check(second);
    expect(report).toMatchObject({ receiptBinding: 'mismatch', chainStatus: 'unknown' });
    expect(report.issues.map((issue) => issue.code)).toContain('PREDECESSOR_MISMATCH');
    // Local file integrity is untouched by the registry's record.
    expect(report.artifactIntegrity).toBe('match');
  });

  it('bounds successor inspection on a real ten-link replacement chain', async () => {
    let previous = await prepareLocalPackage('legal', binding, null);
    const head = previous;
    expect(
      await execute(
        expectOk(
          buildIssueAction(previous, await nonceOf(binding.reviewerAddress), await deadline()),
        ),
        accounts.reviewer,
      ),
    ).toBe('success');
    for (let index = 0; index < 10; index += 1) {
      const next = await prepareLocalPackage('legal-revised', binding, previous.reference);
      expect(
        await execute(
          expectOk(
            buildSupersedeAction(
              previous.reference,
              next,
              await nonceOf(binding.reviewerAddress),
              await deadline(),
            ),
          ),
          accounts.reviewer,
        ),
      ).toBe('success');
      previous = next;
    }
    await mine();
    const report = await check(head, { inspectSuccessors: true });
    expect(report.chainStatus).toBe('superseded');
    expect(report.history?.complete).toBe(false);
    expect(report.history?.successors).toHaveLength(8);
    expect(report.issues.map((issue) => issue.code)).toContain('SUCCESSOR_LIMIT_EXHAUSTED');
  });

  it('keeps an ERC-1271 receipt recorded after the account changes its signature rule', async () => {
    const hash = await walletFor(accounts.deployer).deployContract({
      abi: [
        {
          type: 'constructor',
          inputs: [{ name: 'initialOwner', type: 'address' }],
          stateMutability: 'nonpayable',
        },
        {
          type: 'function',
          name: 'setOwner',
          inputs: [{ name: 'newOwner', type: 'address' }],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      bytecode: creationCode('ERC1271Fixtures.sol', 'ERC1271OwnedAccount'),
      args: [accounts.accountOwner.address],
    });
    const deployed = await client().waitForTransactionReceipt({ hash });
    if (deployed.contractAddress == null) throw new Error('no contract address');
    const account = lower(deployed.contractAddress);
    const contractBinding = { ...binding, reviewerAddress: account };
    const prepared = await prepareLocalPackage('legal', contractBinding, null);
    const issue = expectOk(buildIssueAction(prepared, await nonceOf(account), await deadline()));
    expect(await execute(issue, accounts.accountOwner)).toBe('success');
    await mine();
    const before = await check(prepared, { reviewers: [account] });
    expect(before).toMatchObject({ chainStatus: 'active', signerAcceptance: 'accepted' });

    // The account now accepts a different key. The old signature no longer validates for NEW actions...
    await walletFor(accounts.deployer).writeContract({
      address: account as Hex,
      abi: [
        {
          type: 'function',
          name: 'setOwner',
          inputs: [{ name: 'newOwner', type: 'address' }],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      functionName: 'setOwner',
      args: [accounts.stranger.address],
    });
    const revoke = expectOk(
      buildRevokeAction(prepared.reference, await nonceOf(account), await deadline()),
    );
    expect(await execute(revoke, accounts.accountOwner)).toBe('reverted');
    await mine();
    // ...but the receipt that was already recorded keeps its recorded lifecycle.
    const after = await check(prepared, { reviewers: [account] });
    expect(after.chainStatus).toBe('active');
    expect(after.receiptBinding).toBe('match');
    expect((await contractRecord(prepared.reference)).status).toBe(1);
  });
});
