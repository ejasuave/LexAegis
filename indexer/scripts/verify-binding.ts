import { createPublicClient, http, keccak256, type Hex } from 'viem';
import { proofOfReviewRegistryAbi } from '@lexaegis/sdk/registry';
import { loadTestnetBinding } from './binding';

/*
 * Verifies the configured deployment against the chain through the Alchemy endpoint before live
 * ingestion starts. Exit 0 only when every binding matches; any failure or unavailable read
 * exits non-zero. Prints bounded reason codes, never URLs or keys.
 */
const binding = loadTestnetBinding();
const url = process.env['ALCHEMY_MONAD_RPC_URL'];
if (url === undefined || url === '') {
  console.error('BINDING_UNVERIFIED: ALCHEMY_MONAD_RPC_URL is not set');
  process.exit(3);
}
const client = createPublicClient({ transport: http(url, { timeout: 8000, retryCount: 1 }) });
const failures: string[] = [];
try {
  const chainId = await client.getChainId();
  if (String(chainId) !== binding.chainId) failures.push('CHAIN_ID_MISMATCH');
  const genesis = await client.getBlock({ blockNumber: 0n });
  if (genesis.hash !== binding.genesisHash) failures.push('GENESIS_MISMATCH');
  const registry = binding.registryAddress as Hex;
  const code = await client.getCode({ address: registry });
  if (code === undefined || code === '0x') failures.push('NO_CODE');
  else if (keccak256(code) !== binding.runtimeCodeKeccak256) failures.push('RUNTIME_CODE_MISMATCH');
  const start = BigInt(binding.startBlock);
  const before = await client.getCode({ address: registry, blockNumber: start - 1n });
  if (before !== undefined && before !== '0x') failures.push('CODE_PRESENT_BEFORE_START');
  const atStart = await client.getCode({ address: registry, blockNumber: start });
  if (atStart === undefined || atStart === '0x') failures.push('NO_CODE_AT_START');
  const version = await client.readContract({
    address: registry,
    abi: proofOfReviewRegistryAbi,
    functionName: 'protocolVersion',
  });
  if (version !== 1n) failures.push('PROTOCOL_VERSION_MISMATCH');
  const startBlock = await client.getBlock({ blockNumber: start });
  console.log(`deployment block ${start.toString()} hash ${startBlock.hash}`);
} catch {
  failures.push('RPC_UNAVAILABLE');
}
if (failures.length > 0) {
  console.error(`BINDING_FAILED: ${failures.join(',')}`);
  process.exit(1);
}
console.log('binding verified');
