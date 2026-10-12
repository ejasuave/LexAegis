import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import { proofOfReviewRegistryAbi as abi, type Eip712ReviewAction } from '@lexaegis/sdk/registry';
import { viemChainAccess, type ChainAccess } from '../../examples/ai-pr-signoff/src/chain';
import { buildReadableExport } from '../../examples/ai-pr-signoff/src/export';
import { APPROVED_PUBLIC_NETWORK, checkTarget } from '../../examples/ai-pr-signoff/src/guards';
import {
  createFilePendingLog,
  issueSignoff,
  type Confirmations,
  type IssueResult,
} from '../../examples/ai-pr-signoff/src/issue';
import { inputDigests, prepareSignoffPackage } from '../../examples/ai-pr-signoff/src/package';
import {
  createDirectoryStore,
  generateStorageKey,
  parseStorageKey,
  type EvidenceStore,
} from '../../examples/ai-pr-signoff/src/storage';
import { verifySignoff } from '../../examples/ai-pr-signoff/src/verify';
import { accounts } from './harness';
import { startLocalRegistry, type LocalRegistry } from './local-registry';

/*
 * LOCAL COMPATIBILITY EVIDENCE ONLY. The second-domain example (profile lexaegis.ai-pr-signoff) runs
 * prepare -> encrypted preservation -> guarded two-confirmation issue -> read-only verify against the
 * unchanged registry on a throwaway Anvil chain, with an injected development signer that lives only
 * in this harness. Interrupted-submit cases use a fault-injecting wrapper (labelled fault injection).
 * Not a Monad transaction and not operator-run testnet evidence.
 */

const diff = new TextEncoder().encode('SYNTHETIC diff: -old line\n+new line\n');
const summary = new TextEncoder().encode('SYNTHETIC AI summary: one line changed.\n');
const reviewer = accounts.reviewer.address.toLowerCase();

let chain: LocalRegistry;
let scratch: string;
let sequence = 0;
const client = () =>
  createPublicClient({ chain: foundry, transport: http(chain.local.rpcUrl), pollingInterval: 50 });

interface Case {
  readonly reference: ReceiptReferenceV1;
  readonly store: EvidenceStore;
  readonly evidenceDir: string;
  readonly pendingDir: string;
  readonly storageKey: string;
}

async function prepareCase(): Promise<{
  reference: ReceiptReferenceV1;
  store: EvidenceStore;
  dir: string;
  key: string;
}> {
  sequence += 1;
  const dir = join(scratch, `case-${String(sequence)}`);
  const digests = await inputDigests(diff, summary);
  const decision = new TextEncoder().encode(
    JSON.stringify({
      schema: 'lexaegis.ai-pr-signoff.decision.v1',
      reviewer,
      decision: 'approve-review-package',
      ...digests,
      rationale: 'Synthetic: approve recording this package.',
      decidedAt: '2026-10-12T09:00:00.000Z',
    }),
  );
  const prepared = await prepareSignoffPackage(
    { diff, summary, decision },
    { chainId: chain.binding.chainId, registryAddress: chain.registry, reviewerAddress: reviewer },
  );
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.code}`);
  const key = generateStorageKey();
  const parsed = parseStorageKey(key);
  if (parsed === null) throw new Error('key');
  const store = await createDirectoryStore(join(dir, 'evidence'), parsed, reviewer);
  if (!store.ok) throw new Error('store');
  const saved = await store.data.save(prepared.prepared);
  if (!saved.ok) throw new Error(`save failed: ${saved.code}`);
  return { reference: prepared.prepared.reference, store: store.data, dir, key };
}

const makeChain = (): ChainAccess =>
  viemChainAccess({
    publicClient: client(),
    executor: accounts.reviewer,
    registryAddress: chain.registry,
    chainId: Number(chain.binding.chainId),
    live: {
      policy: chain.policy,
      transport: { kind: 'rpc', url: `${chain.local.rpcUrl}/`, allowLoopbackHttp: true },
    },
    readNonce: (address) =>
      client().readContract({
        address: chain.registry,
        abi,
        functionName: 'nonceOf',
        args: [address as Hex],
      }),
    pause: () => chain.mine(5).then(() => undefined),
  });

const registryNonce = async (): Promise<string> =>
  (
    await client().readContract({
      address: chain.registry,
      abi,
      functionName: 'nonceOf',
      args: [reviewer as Hex],
    })
  ).toString();

const events: string[] = [];
const signer = {
  address: accounts.reviewer.address,
  signTypedData: (typedData: Eip712ReviewAction) => {
    events.push('sign');
    return accounts.reviewer.signTypedData(typedData);
  },
};
const confirms = (snapshot = true, send = true): Confirmations => ({
  snapshot: () => {
    events.push('confirm-snapshot');
    return Promise.resolve(snapshot);
  },
  send: () => {
    events.push('confirm-send');
    return Promise.resolve(send);
  },
});

async function run(
  item: Case,
  overrides: { chain?: ChainAccess; confirm?: Confirmations } = {},
): Promise<IssueResult> {
  return issueSignoff({
    reference: item.reference,
    signer,
    chain: overrides.chain ?? makeChain(),
    store: item.store,
    pending: createFilePendingLog(item.pendingDir),
    confirm: overrides.confirm ?? confirms(),
  });
}

async function newCase(): Promise<Case> {
  const made = await prepareCase();
  return {
    reference: made.reference,
    store: made.store,
    evidenceDir: join(made.dir, 'evidence'),
    pendingDir: join(made.dir, 'pending'),
    storageKey: made.key,
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'ai-pr-signoff-'));
  chain = await startLocalRegistry();
  await chain.mine();
}, 120_000);

afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await chain.stop();
});

describe('guarded issue on a real local registry', () => {
  it('preserves encrypted evidence, asks twice, records the pending hash before broadcast, then confirms', async () => {
    const item = await newCase();
    events.length = 0;
    const pendingLog = createFilePendingLog(item.pendingDir);
    const base = makeChain();
    const observed: { pendingBeforeBroadcast: boolean } = { pendingBeforeBroadcast: false };
    const instrumented: ChainAccess = {
      ...base,
      broadcast: async (raw) => {
        events.push('broadcast');
        observed.pendingBeforeBroadcast =
          (await pendingLog.find(item.reference.commitment)) !== null;
        return base.broadcast(raw);
      },
    };
    const before = await registryNonce();
    const result = await run(item, { chain: instrumented });
    expect(result.status).toBe('confirmed');
    expect(events).toEqual(['confirm-snapshot', 'sign', 'confirm-send', 'broadcast']);
    expect(observed.pendingBeforeBroadcast).toBe(true);
    expect(Number(await registryNonce())).toBe(Number(before) + 1);
    if (result.status === 'confirmed') {
      expect(result.report).toMatchObject({
        chainStatus: 'active',
        receiptBinding: 'match',
        artifactIntegrity: 'match',
      });
    }
    // The preserved bytes are ciphertext: neither the synthetic text nor the storage key is on disk.
    const text = readdirSync(item.evidenceDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
      .join('\n');
    expect(text).not.toContain('SYNTHETIC diff');
    expect(text).not.toContain('SYNTHETIC AI summary');
    expect(text).not.toContain(item.storageKey);
    // A second run changes nothing: the registry already records it.
    const before2 = await registryNonce();
    expect(await run(item)).toMatchObject({ status: 'already_recorded', chainStatus: 'active' });
    expect(await registryNonce()).toBe(before2);
  });

  it('verifies the exported package read-only, and rejects a tampered copy', async () => {
    const item = await newCase();
    expect((await run(item)).status).toBe('confirmed');
    const loaded = await item.store.load(item.reference);
    if (!loaded.ok) throw new Error('load');
    const exportBytes = buildReadableExport(item.reference, loaded.data);
    const live = {
      policy: chain.policy,
      rpcUrl: `${chain.local.rpcUrl}/`,
      allowLoopbackHttp: true,
    };
    const good = await verifySignoff({ exportBytes, expectedReference: item.reference, live });
    expect(good.ok && good.data.report).toMatchObject({
      artifactIntegrity: 'match',
      chainStatus: 'active',
      profileSemantics: 'not_evaluated',
    });
    // Alter one byte of the first artifact inside the export.
    const parsed = JSON.parse(new TextDecoder().decode(exportBytes)) as {
      artifacts: { bytes: string }[];
    };
    const first = parsed.artifacts[0];
    if (first === undefined) throw new Error('fixture');
    first.bytes = `${first.bytes.startsWith('A') ? 'B' : 'A'}${first.bytes.slice(1)}`;
    const tampered = await verifySignoff({
      exportBytes: new TextEncoder().encode(JSON.stringify(parsed)),
      expectedReference: item.reference,
      live,
    });
    expect(tampered.ok && tampered.data.report.artifactIntegrity).toBe('mismatch');
    // Altered ciphertext on disk is refused by the encrypted store.
    const sealed = readdirSync(item.evidenceDir, { recursive: true, withFileTypes: true }).find(
      (entry) => entry.isFile() && entry.name.endsWith('.sealed'),
    );
    if (sealed === undefined) throw new Error('fixture');
    const { writeFileSync } = await import('node:fs');
    const path = join(sealed.parentPath, sealed.name);
    const bytes = readFileSync(path);
    bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 0xff;
    writeFileSync(path, bytes);
    expect(await item.store.load(item.reference)).toEqual({ ok: false, code: 'DECRYPTION_FAILED' });
  });

  it('declines at each confirmation without signing, recording or broadcasting', async () => {
    const item = await newCase();
    const nonceBefore = await registryNonce();
    events.length = 0;
    expect(await run(item, { confirm: confirms(false) })).toEqual({
      status: 'declined',
      stage: 'snapshot',
    });
    expect(events).toEqual(['confirm-snapshot']);
    events.length = 0;
    expect(await run(item, { confirm: confirms(true, false) })).toEqual({
      status: 'declined',
      stage: 'send',
    });
    expect(events).toEqual(['confirm-snapshot', 'sign', 'confirm-send']);
    expect(await createFilePendingLog(item.pendingDir).find(item.reference.commitment)).toBeNull();
    expect(await registryNonce()).toBe(nonceBefore);
  });

  it('reconciles an interrupted submit whose response was lost (fault injection)', async () => {
    const item = await newCase();
    const base = makeChain();
    let broadcasts = 0;
    const lost: ChainAccess = {
      ...base,
      broadcast: async (raw) => {
        broadcasts += 1;
        await base.broadcast(raw); // the node received it...
        throw new Error('connection reset before the response'); // ...the caller never learned that
      },
    };
    const before = await registryNonce();
    const result = await run(item, { chain: lost });
    expect(result.status).toBe('confirmed');
    expect(broadcasts).toBe(1);
    expect(Number(await registryNonce())).toBe(Number(before) + 1);
  });

  it('retries the SAME signed transaction when the broadcast never arrived (fault injection)', async () => {
    const item = await newCase();
    const base = makeChain();
    const hashes: string[] = [];
    let first = true;
    const flaky: ChainAccess = {
      ...base,
      broadcast: async (raw) => {
        if (first) {
          first = false;
          throw new Error('network down before sending');
        }
        const hash = await base.broadcast(raw);
        hashes.push(hash);
        return hash;
      },
    };
    const result = await run(item, { chain: flaky });
    expect(result.status).toBe('confirmed');
    const pending = await createFilePendingLog(item.pendingDir).find(item.reference.commitment);
    expect(hashes).toEqual([pending?.transactionHash]);
  });

  it('reports an unresolved transaction, then recovers with the same opening after the deadline (fault injection)', async () => {
    const item = await newCase();
    const base = makeChain();
    const down: ChainAccess = { ...base, broadcast: () => Promise.reject(new Error('down')) };
    const first = await run(item, { chain: down });
    expect(first.status).toBe('unresolved');
    const pending = await createFilePendingLog(item.pendingDir).find(item.reference.commitment);
    expect(pending).not.toBeNull();
    // Within the action's validity the earlier transaction may still be in flight: do not make another.
    expect((await run(item)).status).toBe('unresolved');
    // After the deadline it can no longer execute; the same preserved opening is signed again.
    await chain.local.transport.request('evm_increaseTime', [900]);
    await chain.mine(2);
    const evidenceFilesBefore = readdirSync(item.evidenceDir, { recursive: true }).length;
    const again = await run(item);
    expect(again.status).toBe('confirmed');
    expect(readdirSync(item.evidenceDir, { recursive: true }).length).toBe(evidenceFilesBefore);
  });

  it('refuses a reference for another registry without sending anything', async () => {
    const item = await newCase();
    const wrong = {
      ...item.reference,
      registryAddress: '0x9999999999999999999999999999999999999999',
    };
    const before = await registryNonce();
    const result = await issueSignoff({
      reference: wrong,
      signer,
      chain: makeChain(),
      store: item.store,
      pending: createFilePendingLog(item.pendingDir),
      confirm: confirms(),
    });
    expect(result.status).toBe('failed');
    expect(await registryNonce()).toBe(before);
  });
});

describe('target guards', () => {
  const testnetPolicy = {
    ...chain_policy(),
    chainId: APPROVED_PUBLIC_NETWORK.chainId,
    genesisHash: APPROVED_PUBLIC_NETWORK.genesisHash,
  };

  function chain_policy() {
    return {
      id: 'test.guard',
      chainId: '31337',
      genesisHash: `0x${'11'.repeat(32)}`,
      registryAddress: '0x453bfd1602d8a8666f55bf9a8d87b127cb94048f',
      protocolVersion: '1',
      deploymentBlock: '1',
      deploymentTransactionHash: `0x${'22'.repeat(32)}`,
      runtimeCodeKeccak256: `0x${'33'.repeat(32)}`,
      executionDelayBlocks: 3,
      executionDelayRevision: 'test',
    };
  }

  it('approves only Monad Testnet for a public issue, even with a matching registry address elsewhere', () => {
    expect(checkTarget('monad-testnet', chain_policy(), 'https://rpc.example.invalid/')).toEqual({
      ok: false,
      code: 'NETWORK_NOT_APPROVED',
    });
    expect(
      checkTarget(
        'monad-testnet',
        { ...testnetPolicy, genesisHash: `0x${'11'.repeat(32)}` },
        'https://rpc.example.invalid/',
      ),
    ).toEqual({ ok: false, code: 'NETWORK_NOT_APPROVED' });
    expect(checkTarget('monad-testnet', testnetPolicy, 'http://127.0.0.1:8545/')).toEqual({
      ok: false,
      code: 'ENDPOINT_REJECTED',
    });
    expect(checkTarget('monad-testnet', testnetPolicy, 'https://rpc.example.invalid/').ok).toBe(
      true,
    );
  });

  it('keeps the loopback test mode away from the public network and from remote hosts', () => {
    expect(checkTarget('local-loopback', testnetPolicy, 'http://127.0.0.1:8545/')).toEqual({
      ok: false,
      code: 'LOCAL_TARGET_IS_PUBLIC_NETWORK',
    });
    expect(
      checkTarget(
        'local-loopback',
        { ...chain_policy(), chainId: '10143' },
        'http://127.0.0.1:8545/',
      ),
    ).toEqual({ ok: false, code: 'LOCAL_TARGET_IS_PUBLIC_NETWORK' });
    expect(checkTarget('local-loopback', chain_policy(), 'https://rpc.example.invalid/')).toEqual({
      ok: false,
      code: 'ENDPOINT_NOT_LOOPBACK',
    });
    expect(checkTarget('local-loopback', chain_policy(), 'http://127.0.0.1:8545/').ok).toBe(true);
  });

  it('matches the recorded Monad testnet deployment', () => {
    const record = JSON.parse(
      readFileSync(join(__dirname, '..', 'deployments', 'monad-testnet.json'), 'utf8'),
    ) as Record<string, unknown>;
    const text = JSON.stringify(record);
    expect(text).toContain(APPROVED_PUBLIC_NETWORK.genesisHash);
    expect(text).toContain(`"${APPROVED_PUBLIC_NETWORK.chainId}"`);
  });
});
