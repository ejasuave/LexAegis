import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { proofOfReviewRegistryAbi } from '@lexaegis/sdk/registry';
import {
  canonicalJson,
  indexerRoot,
  loadTestnetBinding,
  publicBinding,
  renderBindingModule,
  renderConfigYaml,
  validateBinding,
  type AbiEntry,
  type BindingInput,
} from './binding';

const check = process.argv.includes('--check');
const local = process.argv.includes('--local');

function localInput(): BindingInput {
  const get = (name: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    if (v === undefined) throw new Error(`MISSING_ARGUMENT: --${name}`);
    return v;
  };
  return {
    mode: 'local-rpc',
    chainId: get('chain'),
    registryAddress: get('registry'),
    startBlock: get('start'),
    genesisHash: get('genesis'),
    runtimeCodeKeccak256: get('code-hash'),
    deploymentTransactionHash: get('tx'),
    rpcUrl: get('rpc'),
  };
}

const input = validateBinding(local ? localInput() : loadTestnetBinding());
const abi = proofOfReviewRegistryAbi as unknown as readonly AbiEntry[];
const binding = publicBinding(input, abi);
const outputs: ReadonlyArray<readonly [string, string]> = [
  ['abi/ProofOfReviewRegistry.json', `${JSON.stringify(abi, null, 2)}\n`],
  ['config.yaml', renderConfigYaml(input)],
  ['src/binding.generated.ts', renderBindingModule(binding)],
  ['deployment-binding.json', `${canonicalJson(binding)}\n`],
];

let drift = false;
for (const [rel, content] of outputs) {
  const path = resolve(indexerRoot, rel);
  if (check) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current !== content) {
      drift = true;
      console.error(`DRIFT ${rel}`);
    }
  } else {
    writeFileSync(path, content);
  }
}
if (check) {
  if (drift) process.exit(1);
  console.log('indexer config matches the deployment record');
} else {
  console.log(`indexer config written (${binding.configFingerprint})`);
}
