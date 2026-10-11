/**
 * pnpm register:agent: the operator's one-off ERC-8004 registration of the review assistant on
 * Monad TESTNET. Default is a dry run that needs no key and sends nothing.
 *
 *   pnpm register:agent --operator 0x.. --card-uri https://.../api/agent-card
 *   ERC8004_OPERATOR_KEY=... pnpm register:agent --operator 0x.. --card-uri https://.. \
 *       --execute --confirm-plan <plan hash printed by the dry run>
 *
 * The key is read only for --execute, only from ERC8004_OPERATOR_KEY (a server/CLI variable, never
 * NEXT_PUBLIC, never a user's Mera key or a passkey derivation), and never printed. No mainnet
 * override, no funding, no automatic execution in builds or tests. Journal: .private/ (git-ignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  APPROVED_IDENTITY_REGISTRY,
  TESTNET_CHAIN_ID,
  buildPlan,
  execute,
  identityAbi,
  planHash,
  type Journal,
  type JournalEntry,
  type RegistrationChain,
} from '../src/register-agent';
import { ROOT } from './lib';

const { values } = parseArgs({
  options: {
    'chain-id': { type: 'string', default: String(TESTNET_CHAIN_ID) },
    'identity-registry': { type: 'string', default: APPROVED_IDENTITY_REGISTRY },
    operator: { type: 'string' },
    'card-uri': { type: 'string' },
    execute: { type: 'boolean', default: false },
    'confirm-plan': { type: 'string' },
  },
});

const planResult = buildPlan({
  chainId: Number(values['chain-id']),
  identityRegistry: values['identity-registry'],
  operator: values.operator ?? '',
  cardUri: values['card-uri'] ?? '',
});
if (!planResult.ok) {
  console.error(`refused: ${planResult.refusal}`);
  process.exit(2);
}
const { plan } = planResult;

const rpcUrl = process.env.ERC8004_TESTNET_RPC_URL ?? 'https://testnet-rpc.monad.xyz/';
const publicClient = createPublicClient({ transport: http(rpcUrl) });

const journalPath = join(ROOT, '.private', 'erc8004-registration-journal.json');
const journal: Journal = {
  read: () =>
    existsSync(journalPath)
      ? (JSON.parse(readFileSync(journalPath, 'utf8')) as JournalEntry)
      : null,
  write: (entry) => {
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, `${JSON.stringify(entry, null, 2)}\n`);
  },
};

function chainFor(account: ReturnType<typeof privateKeyToAccount> | null): RegistrationChain {
  const wallet = account === null ? null : createWalletClient({ account, transport: http(rpcUrl) });
  return {
    chainId: () => publicClient.getChainId(),
    async registryBehaves(registry) {
      try {
        const version = await publicClient.readContract({
          address: registry as Hex,
          abi: identityAbi,
          functionName: 'getVersion',
        });
        if (version.length === 0) return false;
        await publicClient.readContract({
          address: registry as Hex,
          abi: identityAbi,
          functionName: 'ownerOf',
          args: [2n ** 256n - 1n],
        });
        return false;
      } catch (error) {
        return /ERC721NonexistentToken/.test((error as Error).message);
      }
    },
    async cardServed(uri) {
      try {
        const response = await fetch(uri, {
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(5000),
        });
        const card = (await response.json()) as { type?: unknown };
        return (
          response.ok && card.type === 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'
        );
      } catch {
        return false;
      }
    },
    balance: (address) => publicClient.getBalance({ address: address as Hex }),
    async estimate(p) {
      const [gas, fees] = await Promise.all([
        publicClient.estimateGas({
          account: p.operator as Hex,
          to: p.identityRegistry as Hex,
          data: p.calldata,
        }),
        publicClient.estimateFeesPerGas(),
      ]);
      return { gas: (gas * 110n) / 100n, maxFeePerGas: fees.maxFeePerGas };
    },
    nonce: async (address) =>
      BigInt(await publicClient.getTransactionCount({ address: address as Hex })),
    async send(p, fees, nonce) {
      if (wallet === null || account === null) throw new Error('no operator key');
      return wallet.sendTransaction({
        account,
        chain: null,
        to: p.identityRegistry as Hex,
        data: p.calldata,
        value: 0n,
        gas: fees.gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: 0n,
        nonce: Number(nonce),
      });
    },
    async receipt(hash) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash: hash as Hex });
        return {
          status: r.status,
          blockNumber: r.blockNumber,
          logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
        };
      } catch {
        return null;
      }
    },
    ownerOf: (registry, agentId, block) =>
      publicClient.readContract({
        address: registry as Hex,
        abi: identityAbi,
        functionName: 'ownerOf',
        args: [agentId],
        blockNumber: block,
      }),
    tokenUri: (registry, agentId, block) =>
      publicClient.readContract({
        address: registry as Hex,
        abi: identityAbi,
        functionName: 'tokenURI',
        args: [agentId],
        blockNumber: block,
      }),
    keyAddress: () => account?.address ?? null,
  };
}

const hash = planHash(plan);
if (!values.execute) {
  const fees = await chainFor(null)
    .estimate(plan)
    .catch(() => null);
  console.log(
    JSON.stringify(
      {
        mode: 'dry-run',
        sends: false,
        needsKey: false,
        plan,
        planHash: hash,
        estimate:
          fees === null
            ? 'unavailable'
            : {
                gas: fees.gas.toString(),
                maxFeePerGas: fees.maxFeePerGas.toString(),
                maxFeeWei: (fees.gas * fees.maxFeePerGas).toString(),
              },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const rawKey = process.env.ERC8004_OPERATOR_KEY;
const account =
  rawKey !== undefined && /^0x[0-9a-fA-F]{64}$/.test(rawKey)
    ? privateKeyToAccount(rawKey as Hex)
    : null;
const result = await execute({
  plan,
  confirmedPlanHash: values['confirm-plan'],
  chain: chainFor(account),
  journal,
  operation: `register-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
});
console.log(JSON.stringify(result, null, 2));
if (result.status === 'confirmed') {
  // Only after confirmation AND read-back: a record of what actually happened.
  const file = join(ROOT, 'docs', 'DEPLOYMENTS.md');
  if (!existsSync(file))
    writeFileSync(
      file,
      '# Deployments and registrations\n\nRecords are added only after confirmation and independent read-back. Pending and failed attempts stay in the journal.\n',
    );
  appendFileSync(
    file,
    `\n## ERC-8004 agent registration (Monad testnet ${String(TESTNET_CHAIN_ID)})\n\n- Agent ID: ${result.agentId}\n- Identity Registry: ${plan.identityRegistry}\n- Transaction: ${result.transactionHash} (block ${result.blockNumber})\n- Owner (read back): ${result.owner}\n- Card URI (read back): ${result.cardUri}\n- Remaining step: set AGENT_IDENTITY_AGENT_ID=${result.agentId} for the served card and confirm the hosted card reads back.\n`,
  );
}
process.exit(result.status === 'refused' ? 2 : 0);
