/**
 * pnpm verifier:policy [--check]: generates the verifier's secret-free default registry policy
 * from the actual verified Monad Testnet deployment record. It never invents an address: with no
 * deployed record, no genesis pin or a record that does not match the testnet, the policy is
 * null and live verification is unavailable. Reads files only; imports no workspace package.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ROOT } from './lib';

const deploymentPath = join(ROOT, 'contracts', 'deployments', 'monad-testnet.json');
const outputPath = join(ROOT, 'apps', 'verifier', 'src', 'generated', 'default-policy.json');

const digest = z.string().regex(/^0x[0-9a-f]{64}$/);
const deployed = z.looseObject({
  schema: z.literal('lexaegis.registry-deployment.v1'),
  environment: z.literal('testnet'),
  status: z.literal('deployed'),
  chainId: z.literal('10143'),
  registryAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  transactionHash: digest,
  blockNumber: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  runtimeCodeKeccak256: digest,
  genesisHash: digest,
});

function sourceConstant(file: string, pattern: RegExp): string {
  const found = pattern.exec(readFileSync(join(ROOT, file), 'utf8'));
  if (found?.[1] === undefined) throw new Error(`could not read a constant from ${file}`);
  return found[1];
}

function build(): unknown {
  const source = 'contracts/deployments/monad-testnet.json';
  if (!existsSync(deploymentPath))
    return {
      schema: 'lexaegis.verifier-default-policy.v1',
      policy: null,
      reason: 'NO_DEPLOYMENT_RECORD',
      source,
    };
  const record = deployed.safeParse(JSON.parse(readFileSync(deploymentPath, 'utf8')));
  if (!record.success) {
    return {
      schema: 'lexaegis.verifier-default-policy.v1',
      policy: null,
      reason: 'DEPLOYMENT_NOT_VERIFIED_OR_NOT_PINNED',
      source,
    };
  }
  const protocolVersion = sourceConstant(
    'contracts/src/ProofOfReviewRegistry.sol',
    /protocolVersion\(\)[^{]*\{\s*return\s+(\d+);/,
  );
  const delay = sourceConstant(
    'packages/sdk/src/registry/live-reader.ts',
    /MONAD_EXECUTION_DELAY_BLOCKS\s*=\s*(\d+);/,
  );
  const revision = sourceConstant(
    'packages/sdk/src/registry/live-reader.ts',
    /MONAD_EXECUTION_DELAY_REVISION\s*=\s*'([^']+)'/,
  );
  return {
    schema: 'lexaegis.verifier-default-policy.v1',
    source,
    reason: null,
    policy: {
      id: 'lexaegis.monad-testnet.registry-v1',
      chainId: record.data.chainId,
      genesisHash: record.data.genesisHash,
      registryAddress: record.data.registryAddress,
      protocolVersion,
      deploymentBlock: record.data.blockNumber,
      deploymentTransactionHash: record.data.transactionHash,
      runtimeCodeKeccak256: record.data.runtimeCodeKeccak256,
      executionDelayBlocks: Number(delay),
      executionDelayRevision: revision,
    },
  };
}

const text = `${JSON.stringify(build(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  if (current !== text) {
    console.error(
      'apps/verifier/src/generated/default-policy.json is stale: run pnpm verifier:policy',
    );
    process.exit(1);
  }
  console.log('verifier default policy is current');
} else {
  writeFileSync(outputPath, text);
  console.log(`wrote ${outputPath}`);
}
