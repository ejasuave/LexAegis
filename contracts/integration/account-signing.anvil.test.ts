import { createPublicClient, createWalletClient, encodeFunctionData, http, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedReviewPackage } from '@lexaegis/protocol/v1';
import {
  buildIssueAction,
  buildRevokeAction,
  buildSupersedeAction,
  decodeReceipt,
  decodeRegistryError,
  decodeRegistryEvent,
  proofOfReviewRegistryAbi as abi,
  toAbiReviewAction,
  type BoundReviewAction,
} from '@lexaegis/sdk/registry';
import { succeed } from '../../apps/web/src/features/account/errors';
import type { SignedReviewAction } from '../../apps/web/src/features/account/review-signing';
import {
  CONFIG,
  Clock,
  createHarness,
  type HarnessOptions,
} from '../../apps/web/src/test-support/account-harness';
import { startAnvil, type LocalChain } from '../scripts/lib/anvil';
import { JsonRpcError } from '../scripts/lib/local-rpc';
import { accounts, creationCode, expectOk, lower, prepareLocalPackage } from './harness';

/*
 * LOCAL COMPATIBILITY EVIDENCE ONLY. The web application's real account path (Mera passkey
 * functions on a scripted WebAuthn client, the fixed BIP-32 derivation, a real Mera signing
 * session and its viem adapter, and the preview-ticket bridge with an explicitly opened TEST
 * gate) signs registry actions that the Chapter 3 contract accepts on a throwaway Anvil chain.
 * It is not real-device passkey evidence and not a Monad transaction.
 */

let local: LocalChain;
let registry: Hex;
type Harness = ReturnType<typeof createHarness>;
let h: Harness;
let reviewer: string;
let original: PreparedReviewPackage;
let replacement: PreparedReviewPackage;

const client = () =>
  createPublicClient({ chain: foundry, transport: http(local.rpcUrl), pollingInterval: 50 });

async function syncClock(harness: Harness): Promise<bigint> {
  const { timestamp } = await client().getBlock();
  harness.clock.now = Number(timestamp) * 1000;
  return timestamp;
}

/** A harness whose clock starts at chain time, so the signing session is not instantly expired. */
async function harnessAtChainTime(options: HarnessOptions): Promise<Harness> {
  const clock = new Clock();
  clock.now = Number((await client().getBlock()).timestamp) * 1000;
  return createHarness({ ...options, clock });
}

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

const callData = (signed: SignedReviewAction, action = signed.action.action): Hex =>
  encodeFunctionData({
    abi,
    functionName: 'execute',
    args: [expectOk(toAbiReviewAction(action)), signed.signature],
  });

async function simulate(data: Hex) {
  try {
    await local.transport.request('eth_call', [
      { from: accounts.executor.address, to: registry, data },
      'latest',
    ]);
    return 'ok' as const;
  } catch (error) {
    if (!(error instanceof JsonRpcError)) throw error;
    return expectOk(decodeRegistryError(error.data));
  }
}

async function submit(signed: SignedReviewAction) {
  const wallet = createWalletClient({
    account: accounts.executor,
    chain: foundry,
    transport: http(local.rpcUrl),
  });
  const hash = await wallet.sendTransaction({
    to: registry,
    data: callData(signed),
    gas: 1_000_000n,
  });
  const receipt = await client().waitForTransactionReceipt({ hash });
  const context = { chainId: h.config.chainId, registryAddress: registry };
  return {
    status: receipt.status,
    events: receipt.logs.map((log) =>
      expectOk(
        decodeRegistryEvent(context, { address: log.address, topics: log.topics, data: log.data }),
      ),
    ),
  };
}

async function lifecycle(prepared: PreparedReviewPackage) {
  const { reference } = prepared;
  const data = encodeFunctionData({
    abi,
    functionName: 'getReceipt',
    args: [reference.reviewerAddress as Hex, reference.commitment as Hex],
  });
  const result = await local.transport.request('eth_call', [{ to: registry, data }, 'latest']);
  return expectOk(decodeReceipt(reference, result)).receiptLifecycle;
}

/** Preview then explicitly confirm, as the review UI controller will. */
async function approve(
  harness: Harness,
  bound: BoundReviewAction,
  prepared: PreparedReviewPackage,
) {
  const request = { action: bound, packageReference: prepared.reference };
  const ticket = harness.controller.review.preview(request);
  if (!ticket.ok) return ticket;
  return harness.controller.review.confirm(ticket.data, request);
}

const signedOf = (result: Awaited<ReturnType<typeof approve>>): SignedReviewAction => {
  if (!result.ok) throw new Error(`expected a signature, got ${result.code}`);
  return result.data;
};

async function deadline(harness: Harness): Promise<string> {
  return ((await syncClock(harness)) + 600n).toString();
}

beforeAll(async () => {
  local = await startAnvil();
  const wallet = createWalletClient({
    account: accounts.deployer,
    chain: foundry,
    transport: http(local.rpcUrl),
  });
  const hash = await wallet.deployContract({
    abi,
    bytecode: creationCode('ProofOfReviewRegistry.sol', 'ProofOfReviewRegistry'),
  });
  const receipt = await client().waitForTransactionReceipt({ hash });
  if (receipt.contractAddress == null) throw new Error('no contract address');
  registry = lower(receipt.contractAddress) as Hex;

  h = await harnessAtChainTime({
    reviewGate: () => succeed(null),
    config: { ...CONFIG, chainId: local.chainId.toString(), registryAddress: registry },
  });
  expectOk2(await h.controller.createAndSignIn());
  reviewer = h.controller.getSnapshot().account?.address ?? '';
});

function expectOk2(result: { ok: boolean }): void {
  if (!result.ok) throw new Error('account setup failed');
}

afterAll(async () => {
  await local.stop();
});

describe('passkey-derived account signs registry actions', () => {
  it('ISSUE: the confirmed signature is accepted by the registry for the derived address', async () => {
    const binding = {
      chainId: h.config.chainId,
      registryAddress: registry,
      reviewerAddress: reviewer,
    };
    original = await prepareLocalPackage('legal', binding, null);
    const bound = expectOk(buildIssueAction(original, await nonceOf(reviewer), await deadline(h)));
    const signed = signedOf(await approve(h, bound, original));

    // The derived account never sends a transaction or holds funds; an executor relays.
    expect(await client().getBalance({ address: reviewer as Hex })).toBe(0n);
    const outcome = await submit(signed);
    expect(outcome.status).toBe('success');
    expect(outcome.events).toMatchObject([
      {
        eventKind: 'issued',
        reviewerAddress: reviewer,
        commitment: original.reference.commitment,
        nonce: '0',
      },
    ]);
    expect(await lifecycle(original)).toBe('active');
  });

  it('SUPERSEDE and REVOKE: each needs its own preview and confirmation', async () => {
    const binding = {
      chainId: h.config.chainId,
      registryAddress: registry,
      reviewerAddress: reviewer,
    };
    replacement = await prepareLocalPackage('legal-revised', binding, original.reference);
    const supersede = expectOk(
      buildSupersedeAction(
        original.reference,
        replacement,
        await nonceOf(reviewer),
        await deadline(h),
      ),
    );
    expect(
      (await submit(signedOf(await approve(h, supersede, replacement)))).events.map(
        (e) => e.eventKind,
      ),
    ).toEqual(['issued', 'superseded']);
    expect([await lifecycle(original), await lifecycle(replacement)]).toEqual([
      'superseded',
      'active',
    ]);

    const revoke = expectOk(
      buildRevokeAction(replacement.reference, await nonceOf(reviewer), await deadline(h)),
    );
    expect((await submit(signedOf(await approve(h, revoke, replacement)))).status).toBe('success');
    expect(await lifecycle(replacement)).toBe('revoked');
    expect(await nonceOf(reviewer)).toBe('3');
  });

  it('a signature does not cover a changed action, and a used ticket cannot sign again', async () => {
    const binding = {
      chainId: h.config.chainId,
      registryAddress: registry,
      reviewerAddress: reviewer,
    };
    const fresh = await prepareLocalPackage('legal', binding, null);
    const bound = expectOk(buildIssueAction(fresh, await nonceOf(reviewer), await deadline(h)));
    const request = { action: bound, packageReference: fresh.reference };
    const ticket = h.controller.review.preview(request);
    if (!ticket.ok) throw new Error(ticket.code);
    const signed = signedOf(await h.controller.review.confirm(ticket.data, request));
    expect(await h.controller.review.confirm(ticket.data, request)).toEqual({
      ok: false,
      code: 'TICKET_INVALID',
    });

    // The same signature presented with any altered field is refused by the contract.
    for (const changed of [
      { ...bound.action, commitment: `0x${'ab'.repeat(32)}` },
      { ...bound.action, deadline: (BigInt(bound.action.deadline) + 1n).toString() },
      { ...bound.action, action: 1 as const },
    ]) {
      expect(await simulate(callData(signed, changed))).toEqual({ name: 'InvalidSignature' });
    }
    expect(await simulate(callData(signed))).toBe('ok');
  });

  it('a changed action after preview, a lock or a cancel yields no signature', async () => {
    const binding = {
      chainId: h.config.chainId,
      registryAddress: registry,
      reviewerAddress: reviewer,
    };
    const fresh = await prepareLocalPackage('legal', binding, null);
    const bound = expectOk(buildIssueAction(fresh, await nonceOf(reviewer), await deadline(h)));
    const request = { action: bound, packageReference: fresh.reference };

    const changed = h.controller.review.preview(request);
    if (!changed.ok) throw new Error(changed.code);
    const altered = { ...request, action: { ...bound, action: { ...bound.action, nonce: '99' } } };
    expect(await h.controller.review.confirm(changed.data, altered)).toEqual({
      ok: false,
      code: 'TICKET_INVALID',
    });

    const locked = h.controller.review.preview(request);
    if (!locked.ok) throw new Error(locked.code);
    h.controller.lock();
    expect((await h.controller.review.confirm(locked.data, request)).ok).toBe(false);
    expect(h.controller.review.preview(request)).toEqual({ ok: false, code: 'SESSION_LOCKED' });
    // A fresh passkey ceremony is needed before anything can be signed again.
    expect((await h.controller.recoverKnown()).ok).toBe(true);
    expect(h.controller.getSnapshot().account?.address).toBe(reviewer);
  });

  it('another account cannot sign for this reviewer, and a signature for another registry is refused on chain', async () => {
    const binding = {
      chainId: h.config.chainId,
      registryAddress: registry,
      reviewerAddress: reviewer,
    };
    const fresh = await prepareLocalPackage('legal', binding, null);
    const bound = expectOk(buildIssueAction(fresh, await nonceOf(reviewer), await deadline(h)));

    // A second passkey account, same application, same registry.
    const other = await harnessAtChainTime({ reviewGate: () => succeed(null), config: h.config });
    await other.controller.createAndSignIn();
    await syncClock(other);
    expect(await approve(other, bound, fresh)).toEqual({ ok: false, code: 'SCOPE_REJECTED' });

    // The same reviewer key, but an application configured for a different registry address.
    const elsewhere = `0x${'cd'.repeat(20)}`;
    const wrong = await harnessAtChainTime({
      authenticator: h.authenticator,
      reviewGate: () => succeed(null),
      config: { ...h.config, registryAddress: elsewhere },
    });
    await wrong.controller.recoverByDiscovery();
    expect(wrong.controller.getSnapshot().account?.address).toBe(reviewer);
    const foreignBinding = { ...binding, registryAddress: elsewhere };
    const foreign = await prepareLocalPackage('legal', foreignBinding, null);
    const foreignBound = expectOk(
      buildIssueAction(foreign, await nonceOf(reviewer), await deadline(wrong)),
    );
    const signed = signedOf(await approve(wrong, foreignBound, foreign));
    // Valid for that other domain; this registry does not accept it.
    expect(await simulate(callData(signed))).toEqual({ name: 'InvalidSignature' });
    // And the application bound to this registry refuses to preview it at all.
    await syncClock(h);
    expect(await approve(h, foreignBound, foreign)).toEqual({ ok: false, code: 'SCOPE_REJECTED' });
  });
});
