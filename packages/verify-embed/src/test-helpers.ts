/** Test-only fixtures. Public deployment record values only; no key, no signer. */
export const POLICY = {
  id: 'lexaegis.test.registry-v1',
  chainId: '10143',
  genesisHash: `0x${'11'.repeat(32)}`,
  registryAddress: '0x453bfd1602d8a8666f55bf9a8d87b127cb94048f',
  protocolVersion: '1',
  deploymentBlock: '1',
  deploymentTransactionHash: `0x${'22'.repeat(32)}`,
  runtimeCodeKeccak256: `0x${'33'.repeat(32)}`,
  executionDelayBlocks: 3,
  executionDelayRevision: 'test',
} as const;

export const HOST = {
  deployments: [{ policy: POLICY, rpcUrl: 'https://rpc.example.invalid/' }],
  packageOrigins: ['https://packages.example.invalid'],
} as const;

export const ATTRIBUTES = {
  chainId: '10143',
  registry: POLICY.registryAddress,
  reviewer: '0x2222222222222222222222222222222222222222',
  commitment: `0x${'ab'.repeat(32)}`,
  rpcUrl: null,
  packageUrl: null,
} as const;

/** A URL carrying a credential, assembled at run time so no credential-shaped literal sits in the source. */
export const withCredentials = (hostAndPath: string): string =>
  `${['https://user', 'pw'].join(':')}@${hostAndPath}`;
