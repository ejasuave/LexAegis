import { toEventSelector, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import buildDescriptor from '../../../../contracts/artifacts/registry-v1.json';
import deploymentTemplate from '../../../../contracts/deployments/template.json';
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  REGISTRY_PROTOCOL_VERSION,
  REVIEW_ACTION_CODES,
  REVIEW_ACTION_FIELDS,
  REVIEW_ACTION_TYPE_STRING,
  SUPERSESSION_EVENT_ORDER,
} from './constants';
import { registryDeploymentSchema } from './deployment';
import { proofOfReviewRegistryAbi as abi } from './generated/registry-abi';
import * as registry from './index';

const DEPLOYED = {
  schema: 'lexaegis.registry-deployment.v1',
  status: 'deployed',
  environment: 'local',
  network: 'anvil',
  contract: 'ProofOfReviewRegistry',
  build: deploymentTemplate.build,
  chainId: '31337',
  registryAddress: `0x${'5f'.repeat(20)}`,
  transactionHash: `0x${'ab'.repeat(32)}`,
  blockNumber: '1',
  runtimeCodeKeccak256: `0x${'cd'.repeat(32)}`,
};

describe('generated build descriptor', () => {
  it('agrees with the SDK constants', () => {
    expect(buildDescriptor.protocolVersion).toBe(REGISTRY_PROTOCOL_VERSION);
    expect(buildDescriptor.eip712.domain).toEqual({
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
    });
    expect(buildDescriptor.eip712.typeString).toBe(REVIEW_ACTION_TYPE_STRING);
    expect(buildDescriptor.eip712.fields).toEqual([...REVIEW_ACTION_FIELDS]);
    expect(buildDescriptor.actionCodes).toEqual({ ...REVIEW_ACTION_CODES });
    expect(buildDescriptor.supersessionEventOrder).toEqual([...SUPERSESSION_EVENT_ORDER]);
  });

  it('lists the selectors of the generated ABI', () => {
    for (const item of abi) {
      const signature = `${item.name}(${item.inputs.map((input) => ('components' in input ? `(${input.components.map((component) => component.type).join(',')})` : input.type)).join(',')})`;
      if (item.type === 'event') {
        expect(Reflect.get(buildDescriptor.selectors.events, signature)).toBe(
          toEventSelector(item),
        );
      } else {
        const group = item.type === 'function' ? 'functions' : 'errors';
        expect(Reflect.get(buildDescriptor.selectors[group], signature)).toBe(
          toFunctionSelector(signature),
        );
      }
    }
  });

  it('records a pinned compiler, EVM target and dependency set', () => {
    expect(buildDescriptor.compiler).toEqual({
      solc: '0.8.37+commit.f401782d',
      evmVersion: 'osaka',
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
      bytecodeHash: 'none',
    });
    expect(buildDescriptor.dependencies).toMatchObject({
      foundry: '1.8.5',
      openzeppelinContracts: '5.6.1',
      forgeStd: '1.17.0',
    });
  });
});

describe('registry deployment records', () => {
  it('accepts the committed template, which claims no deployment', () => {
    const template = registryDeploymentSchema.parse(deploymentTemplate);
    expect(template.status).toBe('not_deployed');
    expect(template.environment).toBe('testnet');
    expect(template.build.creationCodeKeccak256).toBe(
      buildDescriptor.bytecode.creationCodeKeccak256,
    );
    for (const observed of [
      'chainId',
      'registryAddress',
      'transactionHash',
      'blockNumber',
      'runtimeCodeKeccak256',
    ]) {
      expect(Object.hasOwn(deploymentTemplate, observed)).toBe(false);
    }
  });

  it('has no place for observed values on a record that is not deployed', () => {
    for (const [key, value] of Object.entries({
      chainId: '10143',
      registryAddress: DEPLOYED.registryAddress,
      transactionHash: DEPLOYED.transactionHash,
      blockNumber: '0',
      runtimeCodeKeccak256: DEPLOYED.runtimeCodeKeccak256,
    })) {
      expect(
        registryDeploymentSchema.safeParse({ ...deploymentTemplate, [key]: value }).success,
      ).toBe(false);
    }
  });

  it('requires every observed value on a deployed record, and none zero-filled', () => {
    expect(registryDeploymentSchema.safeParse(DEPLOYED).success).toBe(true);
    for (const key of [
      'chainId',
      'registryAddress',
      'transactionHash',
      'blockNumber',
      'runtimeCodeKeccak256',
    ]) {
      const { [key]: _omitted, ...partial } = DEPLOYED as Record<string, unknown>;
      expect(registryDeploymentSchema.safeParse(partial).success).toBe(false);
    }
    expect(
      registryDeploymentSchema.safeParse({ ...DEPLOYED, registryAddress: `0x${'00'.repeat(20)}` })
        .success,
    ).toBe(false);
    expect(
      registryDeploymentSchema.safeParse({ ...DEPLOYED, intendedChainId: '31337' }).success,
    ).toBe(false);
  });

  it('keeps local, testnet and mainnet evidence apart', () => {
    const parse = (overrides: Record<string, string>) =>
      registryDeploymentSchema.safeParse({ ...DEPLOYED, ...overrides }).success;
    // A local record can never carry a public chain ID, and vice versa.
    expect(parse({ environment: 'local', chainId: '10143' })).toBe(false);
    expect(parse({ environment: 'local', chainId: '143' })).toBe(false);
    expect(parse({ environment: 'testnet', chainId: '31337' })).toBe(false);
    expect(parse({ environment: 'mainnet', chainId: '10143' })).toBe(false);
    expect(parse({ environment: 'testnet', chainId: '10143' })).toBe(true);
    expect(parse({ environment: 'mainnet', chainId: '143' })).toBe(true);
    expect(parse({ environment: 'staging', chainId: '31337' })).toBe(false);
  });
});

describe('registry entry point', () => {
  it('prepares and decodes only: nothing signs, sends or approves', () => {
    for (const name of Object.keys(registry)) {
      expect(name).not.toMatch(/^(sign|send|submit|broadcast|unlock|approve|execute|write)/i);
    }
    expect(Object.keys(registry)).toEqual(
      expect.arrayContaining([
        'buildIssueAction',
        'buildRevokeAction',
        'buildSupersedeAction',
        'buildTypedData',
        'hashReviewAction',
        'proofOfReviewRegistryAbi',
        'decodeReceipt',
        'decodeRegistryEvent',
        'decodeRegistryError',
        'validateReceiptBinding',
      ]),
    );
  });
});
