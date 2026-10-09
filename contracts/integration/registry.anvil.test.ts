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
import {
  verifyReviewPackage,
  type PreparedReviewPackage,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import {
  buildIssueAction,
  buildRevokeAction,
  buildSupersedeAction,
  buildTypedData,
  decodeReceipt,
  decodeRegistryError,
  decodeRegistryEvent,
  defaultActionDeadline,
  hashReviewAction,
  proofOfReviewRegistryAbi as abi,
  receiptLifecycleOf,
  toAbiReviewAction,
  toEip712ReviewAction,
  validateReceiptBinding,
  type AbiReviewAction,
  type BoundReviewAction,
  type ObservedReceipt,
  type RegistryEvent,
  type RegistryRevert,
} from '@lexaegis/sdk/registry';
import buildDescriptor from '../artifacts/registry-v1.json';
import { startAnvil, type LocalChain } from '../scripts/lib/anvil';
import { JsonRpcError } from '../scripts/lib/local-rpc';
import {
  accounts,
  creationCode,
  expectOk,
  lower,
  prepareLocalPackage,
  registryVectors,
  syntheticArtifacts,
  type LocalBinding,
} from './harness';

/*
 * LOCAL COMPATIBILITY EVIDENCE ONLY. The compiled registry runs on a throwaway Anvil chain
 * (Monad execution rules, chain 31337) and is driven by the TypeScript SDK with real viem
 * signing and encoding. Nothing here touches Monad testnet or mainnet, an RPC provider, a
 * sponsor service or an account provider, and a pass says nothing about any of them.
 *
 * The tests form one sequence on one chain and run in order.
 */

const GAS = 1_000_000n;
// First contract created by the first development account on a fresh chain.
const EXPECTED_REGISTRY = '0x5fbdb2315678afecb367f032d93f642f64180aa3';

interface Signed {
  readonly action: AbiReviewAction;
  readonly signature: Hex;
  readonly digest: string;
}

interface Outcome {
  readonly status: 'success' | 'reverted';
  readonly events: readonly RegistryEvent[];
  readonly blockTimestamp: string;
}

let local: LocalChain;
let registry: Hex;
let binding: LocalBinding;
let original: PreparedReviewPackage;
let replacement: PreparedReviewPackage;
let signedIssue: Signed;
let signedSupersede: Signed;

function publicClient() {
  // Anvil mines on submission, so receipts are polled quickly.
  return createPublicClient({ chain: foundry, transport: http(local.rpcUrl), pollingInterval: 50 });
}

function walletFor(account: LocalAccount) {
  return createWalletClient({ account, chain: foundry, transport: http(local.rpcUrl) });
}

async function nonceOf(address: string): Promise<string> {
  const nonce = await publicClient().readContract({
    address: registry,
    abi,
    functionName: 'nonceOf',
    args: [address as Hex],
  });
  return nonce.toString();
}

/** The reference-application default: latest block time plus 600 seconds. */
async function freshDeadline(): Promise<string> {
  const { timestamp } = await publicClient().getBlock();
  return expectOk(defaultActionDeadline(timestamp.toString()));
}

/** Builds typed data for the bound action, signs it with viem and cross-checks the digest. */
async function sign(bound: BoundReviewAction, signer: LocalAccount): Promise<Signed> {
  const typedData = expectOk(buildTypedData(bound, bound.chainId, bound.registryAddress));
  const digest = expectOk(hashReviewAction(typedData));
  const action = expectOk(toAbiReviewAction(bound.action));

  // Solidity and TypeScript must derive the same EIP-712 digest for the same action.
  const onChain = await publicClient().readContract({
    address: registry,
    abi,
    functionName: 'hashAction',
    args: [action],
  });
  expect(onChain).toBe(digest);

  const signature = await signer.signTypedData(expectOk(toEip712ReviewAction(typedData)));
  return { action, signature, digest };
}

function executeCall(signed: Signed): Hex {
  return encodeFunctionData({
    abi,
    functionName: 'execute',
    args: [signed.action, signed.signature],
  });
}

/** Mines the action, whatever its result, and decodes every log with the SDK. */
async function submit(executor: LocalAccount, signed: Signed): Promise<Outcome> {
  const hash = await walletFor(executor).sendTransaction({
    to: registry,
    data: executeCall(signed),
    gas: GAS,
  });
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  const block = await publicClient().getBlock({ blockHash: receipt.blockHash });
  const context = { chainId: binding.chainId, registryAddress: binding.registryAddress };
  return {
    status: receipt.status,
    blockTimestamp: block.timestamp.toString(),
    events: receipt.logs.map((log) =>
      expectOk(
        decodeRegistryEvent(context, { address: log.address, topics: log.topics, data: log.data }),
      ),
    ),
  };
}

/** Simulates the action with a raw eth_call and decodes the revert data with the SDK. */
async function simulate(signed: Signed, from: LocalAccount): Promise<RegistryRevert | 'ok'> {
  try {
    await local.transport.request('eth_call', [
      { from: from.address, to: registry, data: executeCall(signed) },
      'latest',
    ]);
    return 'ok';
  } catch (error) {
    if (!(error instanceof JsonRpcError)) throw error;
    return expectOk(decodeRegistryError(error.data));
  }
}

/** Reads one record with a raw eth_call through the caller-supplied local transport. */
async function readRecord(reference: ReceiptReferenceV1): Promise<ObservedReceipt> {
  const data = encodeFunctionData({
    abi,
    functionName: 'getReceipt',
    args: [reference.reviewerAddress as Hex, reference.commitment as Hex],
  });
  const result = await local.transport.request('eth_call', [
    { to: reference.registryAddress, data },
    'latest',
  ]);
  return expectOk(decodeReceipt(reference, result));
}

function bindingOf(prepared: PreparedReviewPackage, observed: ObservedReceipt) {
  return expectOk(
    validateReceiptBinding({
      opening: prepared.opening,
      reference: prepared.reference,
      observed,
    }),
  );
}

beforeAll(async () => {
  local = await startAnvil();
});

afterAll(async () => {
  // Stops only the Anvil process this file started.
  await local.stop();
});

describe('local Anvil compatibility', () => {
  it('deploys the committed build, which has no constructor arguments or privileged account', async () => {
    const bytecode = creationCode('ProofOfReviewRegistry.sol', 'ProofOfReviewRegistry');
    expect(keccak256(bytecode)).toBe(buildDescriptor.bytecode.creationCodeKeccak256);

    const hash = await walletFor(accounts.deployer).deployContract({ abi, bytecode });
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    if (receipt.contractAddress == null) throw new Error('no contract address');
    registry = lower(receipt.contractAddress) as Hex;
    expect(registry).toBe(EXPECTED_REGISTRY);

    binding = {
      chainId: local.chainId.toString(),
      registryAddress: registry,
      reviewerAddress: lower(accounts.reviewer.address),
    };

    const client = publicClient();
    const code = await client.getCode({ address: registry });
    expect((code ?? '0x').length).toBeGreaterThan(2);
    expect(
      await client.readContract({ address: registry, abi, functionName: 'protocolVersion' }),
    ).toBe(1n);
    expect(
      await client.readContract({ address: registry, abi, functionName: 'REVIEW_ACTION_TYPEHASH' }),
    ).toBe(buildDescriptor.eip712.typeHash);

    const [fields, name, version, chainId, verifyingContract, salt, extensions] =
      await client.readContract({ address: registry, abi, functionName: 'eip712Domain' });
    expect({
      fields,
      name,
      version,
      chainId,
      verifyingContract: lower(verifyingContract),
      salt,
      extensions,
    }).toEqual({
      fields: '0x0f',
      name: buildDescriptor.eip712.domain.name,
      version: buildDescriptor.eip712.domain.version,
      chainId: local.chainId,
      verifyingContract: registry,
      salt: `0x${'00'.repeat(32)}`,
      extensions: [],
    });
  });

  it('agrees with the TypeScript digest for every fixed vector', async () => {
    const client = publicClient();
    for (const vector of registryVectors) {
      const action = expectOk(toAbiReviewAction(vector.action));
      const onChain = await client.readContract({
        address: registry,
        abi,
        functionName: 'hashAction',
        args: [action],
      });
      const typedData = expectOk(
        buildTypedData(
          { chainId: binding.chainId, registryAddress: registry, action: vector.action },
          binding.chainId,
          registry,
        ),
      );
      expect(onChain, vector.id).toBe(expectOk(hashReviewAction(typedData)));

      // One vector was generated for exactly this chain ID and address: a literal three-way match.
      if (vector.chainId === binding.chainId && vector.registryAddress === registry) {
        expect(onChain, vector.id).toBe(vector.expected.digest);
      }
    }
    expect(registryVectors.some((vector) => vector.registryAddress === registry)).toBe(true);
  });

  it('issues a receipt from a signed ISSUE submitted by an unrelated executor', async () => {
    // Prepared before anything is signed, for the actual local registry, chain and reviewer.
    original = await prepareLocalPackage('legal', binding, null);
    expect(original.reference).toMatchObject(binding);

    const nonce = await nonceOf(binding.reviewerAddress);
    expect(nonce).toBe('0');
    signedIssue = await sign(
      expectOk(buildIssueAction(original, nonce, await freshDeadline())),
      accounts.reviewer,
    );
    expect(await simulate(signedIssue, accounts.executor)).toBe('ok');

    const outcome = await submit(accounts.executor, signedIssue);
    expect(outcome.status).toBe('success');
    expect(outcome.events).toEqual([
      {
        eventKind: 'issued',
        chainId: binding.chainId,
        registryAddress: registry,
        reviewerAddress: binding.reviewerAddress,
        commitment: original.reference.commitment,
        predecessor: null,
        nonce: '0',
        timestamp: outcome.blockTimestamp,
      },
    ]);

    // Exactly the signer's authorized result: the reviewer's receipt, nothing for the executor.
    const record = await readRecord(original.reference);
    expect(record).toEqual({
      ...original.reference,
      schema: undefined,
      receiptLifecycle: 'active',
      predecessor: null,
      successor: null,
      issuedAt: outcome.blockTimestamp,
      updatedAt: outcome.blockTimestamp,
    });
    expect(bindingOf(original, record)).toEqual({
      binding: 'match',
      receiptLifecycle: 'active',
      issues: [],
    });
    expect(
      (
        await readRecord({
          ...original.reference,
          reviewerAddress: lower(accounts.executor.address),
        })
      ).receiptLifecycle,
    ).toBe('not_found');
    expect(await nonceOf(binding.reviewerAddress)).toBe('1');
    expect(await nonceOf(accounts.executor.address)).toBe('0');

    // A second submission of the same signed action fails and changes nothing.
    expect(await simulate(signedIssue, accounts.secondExecutor)).toEqual({
      name: 'InvalidNonce',
      currentNonce: '1',
    });
    const second = await submit(accounts.secondExecutor, signedIssue);
    expect(second).toMatchObject({ status: 'reverted', events: [] });
    expect(await readRecord(original.reference)).toEqual(record);
    expect(await nonceOf(binding.reviewerAddress)).toBe('1');
  });

  it('verifies the private opening against the public reference, and detects an altered artifact', async () => {
    expect(
      await verifyReviewPackage(original.opening, original.artifacts(), original.reference),
    ).toEqual({
      ok: true,
      data: {
        manifestIntegrity: 'match',
        artifactIntegrity: 'match',
        chainStatus: 'unknown',
        signerAcceptance: 'unknown',
        issues: [],
      },
    });

    // One changed byte in the source document.
    const altered = syntheticArtifacts('legal');
    const source = original.opening.manifest.artifacts.find(
      (artifact) => artifact.role === 'source',
    );
    const bytes = source === undefined ? undefined : altered.get(source.id);
    if (source === undefined || bytes === undefined) throw new Error('no source artifact');
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;

    const verification = await verifyReviewPackage(original.opening, altered, original.reference);
    expect(verification).toMatchObject({
      ok: true,
      data: {
        manifestIntegrity: 'match',
        artifactIntegrity: 'mismatch',
        issues: [{ code: 'ARTIFACT_DIGEST_MISMATCH', artifactId: source.id }],
      },
    });
    // The receipt on chain is untouched by that: integrity and lifecycle are separate questions.
    expect((await readRecord(original.reference)).receiptLifecycle).toBe('active');
  });

  it('supersedes the receipt with a freshly prepared replacement that names it', async () => {
    replacement = await prepareLocalPackage('legal-revised', binding, original.reference);
    expect(replacement.opening.manifest.supersedes).toEqual(original.reference);
    expect(replacement.reference.commitment).not.toBe(original.reference.commitment);

    // A replacement cannot be issued as if it replaced nothing.
    expect(buildIssueAction(replacement, '1', await freshDeadline())).toMatchObject({
      ok: false,
      error: { code: 'SUPERSEDES_UNEXPECTED' },
    });

    signedSupersede = await sign(
      expectOk(
        buildSupersedeAction(
          original.reference,
          replacement,
          await nonceOf(binding.reviewerAddress),
          await freshDeadline(),
        ),
      ),
      accounts.reviewer,
    );
    const outcome = await submit(accounts.executor, signedSupersede);
    expect(outcome.status).toBe('success');

    // One atomic action: the replacement's issuance first, then the link, with one nonce.
    const shared = {
      chainId: binding.chainId,
      registryAddress: registry,
      reviewerAddress: binding.reviewerAddress,
      nonce: '1',
      timestamp: outcome.blockTimestamp,
    };
    expect(outcome.events).toEqual([
      {
        eventKind: 'issued',
        ...shared,
        commitment: replacement.reference.commitment,
        predecessor: original.reference.commitment,
      },
      {
        eventKind: 'superseded',
        ...shared,
        previousCommitment: original.reference.commitment,
        replacementCommitment: replacement.reference.commitment,
      },
    ]);
    expect(await nonceOf(binding.reviewerAddress)).toBe('2');

    const oldRecord = await readRecord(original.reference);
    const newRecord = await readRecord(replacement.reference);
    expect(oldRecord).toMatchObject({
      receiptLifecycle: 'superseded',
      predecessor: null,
      successor: replacement.reference.commitment,
      updatedAt: outcome.blockTimestamp,
    });
    expect(BigInt(oldRecord.issuedAt)).toBeLessThanOrEqual(BigInt(outcome.blockTimestamp));
    expect(newRecord).toMatchObject({
      receiptLifecycle: 'active',
      predecessor: original.reference.commitment,
      successor: null,
      issuedAt: outcome.blockTimestamp,
      updatedAt: outcome.blockTimestamp,
    });

    // Predecessor binding: the record's predecessor is the one the manifest declares.
    expect(bindingOf(replacement, newRecord)).toEqual({
      binding: 'match',
      receiptLifecycle: 'active',
      issues: [],
    });
    expect(bindingOf(original, oldRecord)).toEqual({
      binding: 'match',
      receiptLifecycle: 'superseded',
      issues: [],
    });
    // The replacement's record does not bind to the original package, or the other way round.
    expect(bindingOf(original, newRecord).binding).toBe('mismatch');
  });

  it('revokes the replacement, leaving neither version Active', async () => {
    const signedRevoke = await sign(
      expectOk(
        buildRevokeAction(
          replacement.reference,
          await nonceOf(binding.reviewerAddress),
          await freshDeadline(),
        ),
      ),
      accounts.reviewer,
    );
    const outcome = await submit(accounts.secondExecutor, signedRevoke);
    expect(outcome.status).toBe('success');
    expect(outcome.events).toEqual([
      {
        eventKind: 'revoked',
        chainId: binding.chainId,
        registryAddress: registry,
        reviewerAddress: binding.reviewerAddress,
        commitment: replacement.reference.commitment,
        nonce: '2',
        timestamp: outcome.blockTimestamp,
      },
    ]);

    const oldRecord = await readRecord(original.reference);
    const newRecord = await readRecord(replacement.reference);
    expect(newRecord).toMatchObject({
      receiptLifecycle: 'revoked',
      predecessor: original.reference.commitment,
      successor: null,
    });
    // Revoking the replacement does not bring the earlier approval back.
    expect(oldRecord).toMatchObject({
      receiptLifecycle: 'superseded',
      successor: replacement.reference.commitment,
    });
    expect(bindingOf(original, oldRecord).receiptLifecycle).toBe('superseded');
    expect(bindingOf(replacement, newRecord).receiptLifecycle).toBe('revoked');
  });

  it('rejects a replay of every earlier signed action', async () => {
    const before = [await readRecord(original.reference), await readRecord(replacement.reference)];
    for (const signed of [signedIssue, signedSupersede]) {
      expect(await simulate(signed, accounts.executor)).toEqual({
        name: 'InvalidNonce',
        currentNonce: '3',
      });
      expect(await submit(accounts.executor, signed)).toMatchObject({
        status: 'reverted',
        events: [],
      });
    }
    expect([await readRecord(original.reference), await readRecord(replacement.reference)]).toEqual(
      before,
    );
    expect(await nonceOf(binding.reviewerAddress)).toBe('3');
  });

  it('reports the same errors in both runtimes', async () => {
    const nonce = await nonceOf(binding.reviewerAddress);
    const deadline = await freshDeadline();
    const unused = await prepareLocalPackage('legal', binding, null);
    const issue = expectOk(buildIssueAction(unused, nonce, deadline));

    // Signed by a key that is not the reviewer's.
    const forged = await sign(issue, accounts.stranger);
    expect(await simulate(forged, accounts.stranger)).toEqual({ name: 'InvalidSignature' });

    // A deadline in the past.
    const expired = await sign(expectOk(buildIssueAction(unused, nonce, '1')), accounts.reviewer);
    expect(await simulate(expired, accounts.executor)).toEqual({ name: 'AuthorizationExpired' });

    // Correctly signed, but not permitted by the lifecycle.
    const reissue = await sign(
      expectOk(buildIssueAction(original, nonce, deadline)),
      accounts.reviewer,
    );
    expect(await simulate(reissue, accounts.executor)).toEqual({ name: 'ReceiptAlreadyIssued' });
    const revokeTerminal = await sign(
      expectOk(buildRevokeAction(original.reference, nonce, deadline)),
      accounts.reviewer,
    );
    expect(await simulate(revokeTerminal, accounts.executor)).toEqual({
      name: 'InvalidLifecycleTransition',
      currentStatus: 'superseded',
    });
    const revokeMissing = await sign(
      expectOk(buildRevokeAction(unused.reference, nonce, deadline)),
      accounts.reviewer,
    );
    expect(await simulate(revokeMissing, accounts.executor)).toEqual({
      name: 'InvalidLifecycleTransition',
      currentStatus: 'not_found',
    });

    // Shapes the SDK refuses to build are refused by the contract too.
    const valid = await sign(issue, accounts.reviewer);
    const shaped = (overrides: Partial<AbiReviewAction>): Signed => ({
      ...valid,
      action: { ...valid.action, ...overrides },
    });
    expect(await simulate(shaped({ action: 3 }), accounts.executor)).toEqual({
      name: 'InvalidActionShape',
    });
    expect(
      await simulate(shaped({ replacementCommitment: `0x${'ab'.repeat(32)}` }), accounts.executor),
    ).toEqual({ name: 'InvalidActionShape' });
    expect(
      await simulate(shaped({ commitment: `0x${'00'.repeat(32)}` }), accounts.executor),
    ).toEqual({
      name: 'ZeroCommitment',
    });
    expect(
      await simulate(shaped({ reviewer: `0x${'00'.repeat(20)}`, nonce: 0n }), accounts.executor),
    ).toEqual({ name: 'ZeroReviewer' });
    // The untouched action is still executable: none of the failures consumed the nonce.
    expect(await simulate(valid, accounts.executor)).toBe('ok');
    expect(await nonceOf(binding.reviewerAddress)).toBe(nonce);
  });

  it('lets a reviewer cancel an outstanding signature by invalidating the nonce', async () => {
    const nonce = await nonceOf(binding.reviewerAddress);
    const pending = await prepareLocalPackage('legal', binding, null);
    const signed = await sign(
      expectOk(buildIssueAction(pending, nonce, await freshDeadline())),
      accounts.reviewer,
    );

    const hash = await walletFor(accounts.reviewer).writeContract({
      address: registry,
      abi,
      functionName: 'invalidateNonce',
      args: [BigInt(nonce)],
      gas: GAS,
    });
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    const block = await publicClient().getBlock({ blockHash: receipt.blockHash });
    const context = { chainId: binding.chainId, registryAddress: registry };
    expect(
      receipt.logs.map((log) =>
        expectOk(
          decodeRegistryEvent(context, {
            address: log.address,
            topics: log.topics,
            data: log.data,
          }),
        ),
      ),
    ).toEqual([
      {
        eventKind: 'nonce_invalidated',
        ...context,
        reviewerAddress: binding.reviewerAddress,
        previousNonce: nonce,
        newNonce: (BigInt(nonce) + 1n).toString(),
        timestamp: block.timestamp.toString(),
      },
    ]);

    expect(await simulate(signed, accounts.executor)).toEqual({
      name: 'InvalidNonce',
      currentNonce: (BigInt(nonce) + 1n).toString(),
    });
    expect((await readRecord(pending.reference)).receiptLifecycle).toBe('not_found');
  });

  it('distinguishes a missing receipt from an address with no registry code', async () => {
    const neverIssued = { ...original.reference, commitment: `0x${'ee'.repeat(32)}` };
    expect(await readRecord(neverIssued)).toMatchObject({
      receiptLifecycle: 'not_found',
      predecessor: null,
      successor: null,
      issuedAt: '0',
      updatedAt: '0',
    });

    // The same call against an address without code returns no data. That is "unknown".
    const noCode = { ...original.reference, registryAddress: `0x${'77'.repeat(20)}` };
    const data = encodeFunctionData({
      abi,
      functionName: 'getReceipt',
      args: [noCode.reviewerAddress as Hex, noCode.commitment as Hex],
    });
    const result = await local.transport.request('eth_call', [
      { to: noCode.registryAddress, data },
      'latest',
    ]);
    const read = decodeReceipt(noCode, result);
    expect(read).toEqual({ ok: false, error: { code: 'EMPTY_RESPONSE' } });
    expect(receiptLifecycleOf(read)).toBe('unknown');
  });

  it('accepts typed data signed for a synthetic ERC-1271 contract account', async () => {
    // TEST FIXTURE: an owner-keyed contract account from contracts/test/fixtures.
    const hash = await walletFor(accounts.deployer).deployContract({
      abi: [
        {
          type: 'constructor',
          inputs: [{ name: 'initialOwner', type: 'address' }],
          stateMutability: 'nonpayable',
        },
      ],
      bytecode: creationCode('ERC1271Fixtures.sol', 'ERC1271OwnedAccount'),
      args: [accounts.accountOwner.address],
    });
    const deployed = await publicClient().waitForTransactionReceipt({ hash });
    if (deployed.contractAddress == null) throw new Error('no contract address');
    const contractReviewer = { ...binding, reviewerAddress: lower(deployed.contractAddress) };

    const prepared = await prepareLocalPackage('legal', contractReviewer, null);
    const bound = expectOk(
      buildIssueAction(
        prepared,
        await nonceOf(contractReviewer.reviewerAddress),
        await freshDeadline(),
      ),
    );

    // Not the owner: refused. The owner: accepted, and the receipt belongs to the contract account.
    expect(await simulate(await sign(bound, accounts.stranger), accounts.executor)).toEqual({
      name: 'InvalidSignature',
    });
    const outcome = await submit(accounts.executor, await sign(bound, accounts.accountOwner));
    expect(outcome.status).toBe('success');
    expect(outcome.events).toMatchObject([
      { eventKind: 'issued', reviewerAddress: contractReviewer.reviewerAddress, nonce: '0' },
    ]);
    expect(bindingOf(prepared, await readRecord(prepared.reference))).toMatchObject({
      binding: 'match',
      receiptLifecycle: 'active',
    });
    expect(
      (
        await readRecord({
          ...prepared.reference,
          reviewerAddress: lower(accounts.accountOwner.address),
        })
      ).receiptLifecycle,
    ).toBe('not_found');
  });
});
