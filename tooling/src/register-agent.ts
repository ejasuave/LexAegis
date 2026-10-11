import { createHash } from 'node:crypto';
import { decodeEventLog, encodeFunctionData, parseAbi, type Hex } from 'viem';

/*
 * One-off OPERATOR action: register the LexAegis review assistant in the ERC-8004 Identity Registry
 * on Monad testnet. It is not a user review approval and shares nothing with one. The default is a
 * dry run that needs no key. A live run needs an explicit execute option plus the plan's hash, a
 * key from a deliberately configured server/CLI environment variable, and fresh checks of chain,
 * registry, card, key/address and fee. Nothing here is imported by an application, the SDK or the
 * verifier, and nothing runs during build or tests against a real network.
 */

export const TESTNET_CHAIN_ID = 10143;
/** The documented Identity Registry on Monad testnet, as probed (docs/erc8004-availability.md). */
export const APPROVED_IDENTITY_REGISTRY = '0x8004a818bfb912233c491871b3d84c89a494bd9e';
export const GAS_CEILING = 400_000n;
export const MAX_FEE_WEI = 10n ** 17n;

export const identityAbi = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function ownerOf(uint256) view returns (address)',
  'function tokenURI(uint256) view returns (string)',
  'function getVersion() pure returns (string)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

export interface PlanInput {
  readonly chainId: number;
  readonly identityRegistry: string;
  readonly operator: string;
  readonly cardUri: string;
}

export interface Plan extends PlanInput {
  readonly method: 'register(string)';
  readonly valueWei: '0';
  readonly calldata: Hex;
  readonly gasCeiling: string;
  readonly maxFeeWei: string;
}

export type Refusal =
  | 'WRONG_CHAIN'
  | 'MAINNET_REFUSED'
  | 'REGISTRY_NOT_APPROVED'
  | 'OPERATOR_INVALID'
  | 'CARD_URI_INVALID'
  | 'PLAN_NOT_CONFIRMED'
  | 'KEY_MISSING'
  | 'KEY_ADDRESS_MISMATCH'
  | 'CHAIN_IDENTITY_MISMATCH'
  | 'REGISTRY_ABI_UNVERIFIED'
  | 'CARD_UNAVAILABLE'
  | 'FEE_TOO_HIGH'
  | 'INSUFFICIENT_FUNDS'
  | 'PENDING_OPERATION_EXISTS'
  | 'NOT_CONFIRMED'
  | 'OWNER_MISMATCH'
  | 'URI_MISMATCH'
  | 'REGISTERED_EVENT_MISSING';

export function buildPlan(
  input: PlanInput,
): { ok: true; plan: Plan } | { ok: false; refusal: Refusal } {
  if (input.chainId === 143) return { ok: false, refusal: 'MAINNET_REFUSED' };
  if (input.chainId !== TESTNET_CHAIN_ID) return { ok: false, refusal: 'WRONG_CHAIN' };
  if (input.identityRegistry.toLowerCase() !== APPROVED_IDENTITY_REGISTRY) {
    return { ok: false, refusal: 'REGISTRY_NOT_APPROVED' };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.operator))
    return { ok: false, refusal: 'OPERATOR_INVALID' };
  try {
    const url = new URL(input.cardUri);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname.includes('.') ||
      url.href !== input.cardUri ||
      input.cardUri.length > 512
    ) {
      return { ok: false, refusal: 'CARD_URI_INVALID' };
    }
  } catch {
    return { ok: false, refusal: 'CARD_URI_INVALID' };
  }
  return {
    ok: true,
    plan: {
      ...input,
      identityRegistry: input.identityRegistry.toLowerCase(),
      operator: input.operator.toLowerCase(),
      method: 'register(string)',
      valueWei: '0',
      calldata: encodeFunctionData({
        abi: identityAbi,
        functionName: 'register',
        args: [input.cardUri],
      }),
      gasCeiling: GAS_CEILING.toString(),
      maxFeeWei: MAX_FEE_WEI.toString(),
    },
  };
}

/** The hash the operator must repeat to confirm exactly the displayed plan. */
export const planHash = (plan: Plan): string =>
  createHash('sha256').update(JSON.stringify(plan)).digest('hex');

export interface JournalEntry {
  readonly operation: string;
  readonly planHash: string;
  readonly operator: string;
  readonly nonce: string;
  readonly transactionHash: string | null;
  readonly status: 'pending' | 'confirmed' | 'failed';
}

/** Secret-free persistence of the one operation, written BEFORE waiting for confirmation. */
export interface Journal {
  read(): JournalEntry | null;
  write(entry: JournalEntry): void;
}

export interface RegistrationChain {
  chainId(): Promise<number>;
  /** ABI-verified read of the registry (getVersion decodes, ownerOf of an impossible ID reverts as nonexistent). */
  registryBehaves(registry: string): Promise<boolean>;
  cardServed(uri: string): Promise<boolean>;
  balance(address: string): Promise<bigint>;
  estimate(plan: Plan): Promise<{ gas: bigint; maxFeePerGas: bigint }>;
  nonce(address: string): Promise<bigint>;
  /** Signs and sends with the operator key. Called only by `execute`. */
  send(plan: Plan, fees: { gas: bigint; maxFeePerGas: bigint }, nonce: bigint): Promise<string>;
  /** null while the transaction is not yet mined. */
  receipt(hash: string): Promise<{
    status: 'success' | 'reverted';
    blockNumber: bigint;
    logs: readonly { address: string; topics: readonly string[]; data: string }[];
  } | null>;
  ownerOf(registry: string, agentId: bigint, block: bigint): Promise<string>;
  tokenUri(registry: string, agentId: bigint, block: bigint): Promise<string>;
  keyAddress(): string | null;
}

export interface ExecuteInput {
  readonly plan: Plan;
  readonly confirmedPlanHash: string | undefined;
  readonly chain: RegistrationChain;
  readonly journal: Journal;
  readonly operation: string;
  readonly waitAttempts?: number;
  readonly pause?: () => Promise<void>;
}

export type ExecuteResult =
  | {
      readonly status: 'confirmed';
      readonly agentId: string;
      readonly transactionHash: string;
      readonly owner: string;
      readonly cardUri: string;
      readonly blockNumber: string;
    }
  | { readonly status: 'pending'; readonly transactionHash: string }
  | { readonly status: 'refused'; readonly refusal: Refusal };

const refused = (refusal: Refusal): ExecuteResult => ({ status: 'refused', refusal });

/** Decodes the real receipt: the agent ID comes ONLY from the Registered event, never from a prediction. */
export function decodeRegistered(
  registry: string,
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
): { agentId: bigint; owner: string; uri: string } | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== registry) continue;
    try {
      const event = decodeEventLog({
        abi: identityAbi,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      {
        return {
          agentId: event.args.agentId,
          owner: event.args.owner.toLowerCase(),
          uri: event.args.agentURI,
        };
      }
    } catch {
      // not a registry event we know
    }
  }
  return null;
}

async function confirm(input: ExecuteInput, hash: string): Promise<ExecuteResult> {
  const { chain, plan } = input;
  const attempts = input.waitAttempts ?? 30;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = await chain.receipt(hash);
    if (receipt !== null) {
      if (receipt.status !== 'success') {
        input.journal.write({ ...(input.journal.read() as JournalEntry), status: 'failed' });
        return refused('NOT_CONFIRMED');
      }
      const registered = decodeRegistered(plan.identityRegistry, receipt.logs);
      if (registered === null) return refused('REGISTERED_EVENT_MISSING');
      // Independent read-back at the confirming block, not the event alone.
      const owner = (
        await chain.ownerOf(plan.identityRegistry, registered.agentId, receipt.blockNumber)
      ).toLowerCase();
      const uri = await chain.tokenUri(
        plan.identityRegistry,
        registered.agentId,
        receipt.blockNumber,
      );
      if (owner !== plan.operator) return refused('OWNER_MISMATCH');
      if (uri !== plan.cardUri) return refused('URI_MISMATCH');
      input.journal.write({ ...(input.journal.read() as JournalEntry), status: 'confirmed' });
      return {
        status: 'confirmed',
        agentId: registered.agentId.toString(),
        transactionHash: hash,
        owner,
        cardUri: uri,
        blockNumber: receipt.blockNumber.toString(),
      };
    }
    await (input.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 2000))))();
  }
  // Not observed in time: the journal stays pending. A rerun reconciles; it never sends again.
  return { status: 'pending', transactionHash: hash };
}

/**
 * Live execution. Every guard runs before anything is sent. A pending journal entry for the same
 * plan is reconciled instead of registering again, whatever the reason confirmation was missed.
 */
export async function execute(input: ExecuteInput): Promise<ExecuteResult> {
  const { plan, chain, journal } = input;
  if (input.confirmedPlanHash !== planHash(plan)) return refused('PLAN_NOT_CONFIRMED');

  const existing = journal.read();
  if (existing !== null && existing.planHash === planHash(plan)) {
    if (existing.status === 'confirmed') return refused('PENDING_OPERATION_EXISTS');
    if (existing.status === 'pending' && existing.transactionHash !== null)
      return confirm(input, existing.transactionHash);
    if (existing.status === 'pending') return refused('PENDING_OPERATION_EXISTS');
  }

  const key = chain.keyAddress();
  if (key === null) return refused('KEY_MISSING');
  if (key.toLowerCase() !== plan.operator) return refused('KEY_ADDRESS_MISMATCH');
  if ((await chain.chainId()) !== TESTNET_CHAIN_ID) return refused('CHAIN_IDENTITY_MISMATCH');
  if (!(await chain.registryBehaves(plan.identityRegistry)))
    return refused('REGISTRY_ABI_UNVERIFIED');
  if (!(await chain.cardServed(plan.cardUri))) return refused('CARD_UNAVAILABLE');
  const fees = await chain.estimate(plan);
  const gas = fees.gas;
  if (gas > GAS_CEILING || gas * fees.maxFeePerGas > MAX_FEE_WEI) return refused('FEE_TOO_HIGH');
  if ((await chain.balance(plan.operator)) < gas * fees.maxFeePerGas)
    return refused('INSUFFICIENT_FUNDS');

  const nonce = await chain.nonce(plan.operator);
  // Journal first, with no hash yet, so an interruption between send and write cannot go unnoticed.
  journal.write({
    operation: input.operation,
    planHash: planHash(plan),
    operator: plan.operator,
    nonce: nonce.toString(),
    transactionHash: null,
    status: 'pending',
  });
  const hash = await chain.send(plan, fees, nonce);
  journal.write({
    operation: input.operation,
    planHash: planHash(plan),
    operator: plan.operator,
    nonce: nonce.toString(),
    transactionHash: hash,
    status: 'pending',
  });
  return confirm(input, hash);
}
