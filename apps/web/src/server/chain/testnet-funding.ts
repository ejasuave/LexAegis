import { keccak256, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { ChainPolicy } from '@lexaegis/sdk/registry';
import { observeTransaction, type MonitorTarget } from '@lexaegis/sdk/transactions';
import type { ServerChainClient } from './alchemy-client';
import { CHAIN, isAllowedMutationChain, type ChainSettings, type FundingResult } from './config';
import type { ChainStore, GrantRow } from './operation-store';
import { checkAccountUndelegated } from './preflight';

/*
 * Explicit, bounded test-MON grants for the authenticated account. The recipient comes from the
 * server session, never the request. The per-address cooldown is not proof of one human; the
 * atomic global budget is the hard spending bound. The funder is never refilled automatically,
 * and nothing here signs a user key or a registry action.
 */

export const TRANSFER_GAS = 21_000n;
const FAUCET = { faucetUrl: CHAIN.faucetUrl } as const;

export interface FundingDeps {
  readonly client: ServerChainClient;
  readonly policy: Pick<
    ChainPolicy,
    | 'chainId'
    | 'registryAddress'
    | 'deploymentBlock'
    | 'runtimeCodeKeccak256'
    | 'executionDelayBlocks'
    | 'executionDelayRevision'
  >;
  readonly store: ChainStore;
  readonly settings: ChainSettings;
  /** Loaded from runtime secrets by the caller; null when not configured. */
  readonly funder: PrivateKeyAccount | null;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Bounded in-request confirmation polls; the caller may refresh afterwards. */
  readonly pollAttempts?: number;
}

const unavailable = (
  status:
    | 'unavailable'
    | 'disabled'
    | 'failed'
    | 'unknown'
    | 'funder_low'
    | 'budget_exhausted'
    | 'already_funded'
    | 'account_delegated',
): FundingResult => ({
  status,
  ...FAUCET,
});

function target(grant: GrantRow, funder: Hex): MonitorTarget {
  return {
    hash: grant.transactionHash as Hex,
    sender: funder,
    transactionNonce: BigInt(grant.funderNonce ?? '0'),
    intent: { kind: 'transfer', recipient: grant.recipient, valueWei: BigInt(grant.amountWei) },
  };
}

const isAlreadyKnown = (error: unknown): boolean =>
  /already known|known transaction|nonce too low.*same|AlreadyKnown/i.test(
    (error as Error | null)?.message ?? '',
  );

/** Settles or re-broadcasts one stored grant. Identical signed bytes only; never a new signature. */
export async function reconcileGrant(
  deps: FundingDeps,
  grant: GrantRow,
): Promise<'confirmed' | 'reverted' | 'pending' | 'unknown'> {
  const { funder } = deps;
  if (funder === null || grant.transactionHash === null || grant.outboxRaw === null) {
    // A reservation with no signed bytes never reached the network.
    if (grant.phase === 'reserved') {
      await deps.store.setGrantPhase(grant.id, 'reverted', null, deps.now());
      return 'reverted';
    }
    return 'unknown';
  }
  const ctx = { client: deps.client.monitor, policy: deps.policy as ChainPolicy, now: deps.now };
  const observed = await observeTransaction(
    ctx,
    target(grant, funder.address.toLowerCase() as Hex),
  );
  if (observed.outcome === 'confirmed') {
    await deps.store.setGrantPhase(grant.id, 'confirmed', observed.chargedFeeWei, deps.now());
    return 'confirmed';
  }
  if (observed.outcome === 'reverted') {
    await deps.store.setGrantPhase(grant.id, 'reverted', observed.chargedFeeWei, deps.now());
    return 'reverted';
  }
  if (observed.outcome === 'submitted') {
    try {
      await deps.client.sendRawTransaction(grant.outboxRaw as Hex);
      await deps.store.setGrantPhase(grant.id, 'broadcast', null, deps.now());
    } catch (error) {
      if (!isAlreadyKnown(error)) {
        await deps.store.setGrantPhase(grant.id, 'unknown', null, deps.now());
        return 'unknown';
      }
    }
    return 'pending';
  }
  return observed.outcome === 'unknown' ? 'unknown' : 'pending';
}

export async function requestTestnetFunding(
  deps: FundingDeps,
  recipient: string,
): Promise<FundingResult> {
  const { settings, funder, client, store } = deps;
  if (!isAllowedMutationChain(deps.policy.chainId)) return unavailable('unavailable');
  if (!settings.fundingEnabled) return unavailable('disabled');
  if (funder === null) return unavailable('unavailable');
  const to = recipient.toLowerCase() as Hex;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  try {
    if (String(await client.public.getChainId()) !== deps.policy.chainId)
      return unavailable('unavailable');
    if (!(await checkAccountUndelegated(client, to))) return unavailable('account_delegated');
    const balance = await client.public.getBalance({ address: to });
    if (balance >= settings.grantWei) return unavailable('already_funded');

    // Finish whatever the funder left unresolved before spending its nonce again.
    const stuck = await store.unresolvedGrant(deps.policy.chainId);
    if (stuck !== null) {
      const settled = await reconcileGrant(deps, stuck);
      if (settled === 'pending' || settled === 'unknown') {
        return stuck.recipient === to && stuck.transactionHash !== null
          ? {
              status: 'pending',
              transactionHash: stuck.transactionHash,
              amountWei: stuck.amountWei,
            }
          : unavailable('unknown');
      }
    }

    const fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } =
      await client.public.estimateFeesPerGas();
    if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) {
      return unavailable('unavailable');
    }
    const feeCeiling = TRANSFER_GAS * fees.maxFeePerGas;
    if (feeCeiling > settings.fundingMaxFeeWei) return unavailable('failed');
    const funderBalance = await client.public.getBalance({ address: funder.address });
    if (funderBalance < settings.grantWei + feeCeiling) return unavailable('funder_low');

    const reserved = await store.reserveGrant({
      id: deps.randomId(),
      recipient: to,
      chainId: deps.policy.chainId,
      amountWei: settings.grantWei,
      reservedFeeWei: feeCeiling,
      dailyBudgetWei: settings.dailyBudgetWei,
      cooldownMs: settings.cooldownMs,
      now: deps.now(),
    });
    if (reserved.kind === 'cooldown') {
      return { status: 'cooldown', ...FAUCET, retryAfter: reserved.retryAfter.toISOString() };
    }
    if (reserved.kind !== 'reserved') {
      return unavailable(reserved.kind === 'budget_exhausted' ? 'budget_exhausted' : 'unknown');
    }

    const nonce = await client.public.getTransactionCount({ address: funder.address });
    const raw = await funder.signTransaction({
      type: 'eip1559',
      chainId: Number(deps.policy.chainId),
      to,
      value: settings.grantWei,
      data: '0x',
      gas: TRANSFER_GAS,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const hash = keccak256(raw);
    // Durable before the first broadcast: a crash retries these exact bytes.
    const stored = await store.attachSignedGrant(
      reserved.grant.id,
      { funderNonce: nonce.toString(), transactionHash: hash, raw },
      deps.now(),
    );
    if (!stored) return unavailable('unknown');
    const signed: GrantRow = {
      ...reserved.grant,
      phase: 'signed',
      funderNonce: nonce.toString(),
      transactionHash: hash,
      outboxRaw: raw,
    };

    for (let attempt = 0; attempt < (deps.pollAttempts ?? 6); attempt += 1) {
      const outcome = await reconcileGrant(deps, signed);
      if (outcome === 'confirmed') {
        const after = await client.public.getBalance({ address: to });
        return {
          status: 'confirmed',
          transactionHash: hash,
          amountWei: settings.grantWei.toString(),
          balanceWei: after.toString(),
          chargedFeeWei: (TRANSFER_GAS * fees.maxFeePerGas).toString(),
        };
      }
      if (outcome === 'reverted') return unavailable('failed');
      await sleep(2_000);
    }
    return { status: 'pending', transactionHash: hash, amountWei: settings.grantWei.toString() };
  } catch {
    // An uncertain outcome keeps its reservation; the next request or refresh reconciles it.
    return unavailable('unknown');
  }
}
