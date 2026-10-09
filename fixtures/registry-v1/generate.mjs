/**
 * Fixture-generation utility for the registry v1 EIP-712 test vectors.
 *
 * INDEPENDENCE RULE: this file must never import @lexaegis/* or anything under packages/, and
 * it does not use viem or the compiled contract. The EIP-712 encoding below is written out by
 * hand from the specification (https://eips.ethereum.org/EIPS/eip-712) on top of a bare
 * Keccak-256 and secp256k1 implementation. The domain and type strings are literals. Three
 * implementations must then agree with these values: this file, the Solidity registry (Foundry
 * tests) and the TypeScript SDK.
 *
 *   node fixtures/registry-v1/generate.mjs          write vectors.json
 *   node fixtures/registry-v1/generate.mjs --check  fail if vectors.json is not reproducible
 *
 * Everything here is SYNTHETIC. The signing key is a published test value: it must never hold
 * funds or sign anything real. No vector describes a real approval or an on-chain receipt.
 */
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

const DOMAIN_NAME = 'LexAegisProofOfReview';
const DOMAIN_VERSION = '1';
const DOMAIN_TYPE =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const ACTION_TYPE =
  'ReviewAction(address reviewer,uint8 action,bytes32 commitment,bytes32 replacementCommitment,uint256 nonce,uint256 deadline)';
const ISSUE = 0;
const REVOKE = 1;
const SUPERSEDE = 2;

const UINT256_MAX = 2n ** 256n - 1n;
const ZERO32 = `0x${'00'.repeat(32)}`;

const keccak = (...parts) => Buffer.from(keccak_256(Buffer.concat(parts)));
const hex = (buffer) => `0x${Buffer.from(buffer).toString('hex')}`;
const text = (value) => Buffer.from(value, 'utf8');
const unhex = (value) => Buffer.from(value.slice(2), 'hex');

// Known answer: this must be Keccak-256, not NIST SHA3-256.
if (hex(keccak()) !== '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') {
  throw new Error('hash primitive is not Keccak-256');
}

/** ABI word encoders. Every ReviewAction and domain field is a static 32-byte word. */
function uintWord(value) {
  const number = BigInt(value);
  if (number < 0n || number > UINT256_MAX) throw new Error('uint256 out of range');
  return Buffer.from(number.toString(16).padStart(64, '0'), 'hex');
}
function addressWord(value) {
  if (!/^0x[0-9a-f]{40}$/.test(value)) throw new Error('address must be lowercase hex');
  return Buffer.concat([Buffer.alloc(12), unhex(value)]);
}
function bytes32Word(value) {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error('bytes32 must be lowercase hex');
  return unhex(value);
}

const DOMAIN_TYPEHASH = keccak(text(DOMAIN_TYPE));
const ACTION_TYPEHASH = keccak(text(ACTION_TYPE));

function domainSeparator(chainId, registryAddress) {
  return keccak(
    DOMAIN_TYPEHASH,
    keccak(text(DOMAIN_NAME)),
    keccak(text(DOMAIN_VERSION)),
    uintWord(chainId),
    addressWord(registryAddress),
  );
}

function structHash(action) {
  return keccak(
    ACTION_TYPEHASH,
    addressWord(action.reviewer),
    uintWord(action.action),
    bytes32Word(action.commitment),
    bytes32Word(action.replacementCommitment),
    uintWord(action.nonce),
    uintWord(action.deadline),
  );
}

// Synthetic signer: the key is the hash of a label, so it is obviously not a real secret.
const PRIVATE_KEY = keccak(text('lexaegis registry-v1 SYNTHETIC test signer: never fund'));
const PUBLIC_KEY = Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, false));
const SIGNER = hex(keccak(PUBLIC_KEY.subarray(1)).subarray(12));

/** 65-byte r || s || v with low s and v in {27, 28}; RFC 6979 makes it deterministic. */
function sign(digest) {
  const signature = secp256k1.sign(digest, PRIVATE_KEY, { lowS: true });
  return hex(
    Buffer.concat([
      uintWord(signature.r),
      uintWord(signature.s),
      Buffer.from([27 + signature.recovery]),
    ]),
  );
}

const commitment = (label) => hex(keccak(text(`SYNTHETIC registry-v1 commitment ${label}`)));

function vector(id, description, chainId, registryAddress, action) {
  const separator = domainSeparator(chainId, registryAddress);
  const hashed = structHash(action);
  const digest = keccak(Buffer.from([0x19, 0x01]), separator, hashed);
  return {
    id,
    description,
    chainId,
    registryAddress,
    action,
    expected: {
      domainSeparator: hex(separator),
      structHash: hex(hashed),
      digest: hex(digest),
      signature: sign(digest),
    },
  };
}

const MONAD_TESTNET = '10143';
const MONAD_MAINNET = '143';
const LOCAL = '31337';
const REGISTRY = `0x${'11'.repeat(20)}`;
// First contract created by the first default account of a fresh local Anvil chain.
const LOCAL_REGISTRY = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const CONTRACT_REVIEWER = `0x${'33'.repeat(20)}`;
const DEADLINE = '1800000600';

const vectors = {
  $comment:
    'SYNTHETIC registry v1 EIP-712 test vectors. Generated by fixtures/registry-v1/generate.mjs, independently of the contract and the SDK. The private key is a published TEST value and must never be used for anything else. Do not edit by hand.',
  format: 'lexaegis.registry-v1.test-vectors/1',
  eip712: {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION },
    domainTypeString: DOMAIN_TYPE,
    domainTypeHash: hex(DOMAIN_TYPEHASH),
    primaryType: 'ReviewAction',
    typeString: ACTION_TYPE,
    typeHash: hex(ACTION_TYPEHASH),
  },
  actionCodes: { ISSUE, REVOKE, SUPERSEDE },
  signer: { privateKey: hex(PRIVATE_KEY), address: SIGNER },
  vectors: [
    vector('issue', 'ISSUE with nonce zero on Monad testnet', MONAD_TESTNET, REGISTRY, {
      reviewer: SIGNER,
      action: ISSUE,
      commitment: commitment('A'),
      replacementCommitment: ZERO32,
      nonce: '0',
      deadline: DEADLINE,
    }),
    vector('revoke', 'REVOKE of the same commitment', MONAD_TESTNET, REGISTRY, {
      reviewer: SIGNER,
      action: REVOKE,
      commitment: commitment('A'),
      replacementCommitment: ZERO32,
      nonce: '1',
      deadline: DEADLINE,
    }),
    vector('supersede', 'SUPERSEDE of A by B', MONAD_TESTNET, REGISTRY, {
      reviewer: SIGNER,
      action: SUPERSEDE,
      commitment: commitment('A'),
      replacementCommitment: commitment('B'),
      nonce: '1',
      deadline: DEADLINE,
    }),
    vector(
      'issue-other-registry',
      'The first ISSUE again, for a different registry address on the same chain',
      MONAD_TESTNET,
      `0x${'44'.repeat(20)}`,
      {
        reviewer: SIGNER,
        action: ISSUE,
        commitment: commitment('A'),
        replacementCommitment: ZERO32,
        nonce: '0',
        deadline: DEADLINE,
      },
    ),
    vector(
      'issue-local',
      'The first ISSUE again, for a fresh local Anvil chain and its first deployed contract',
      LOCAL,
      LOCAL_REGISTRY,
      {
        reviewer: SIGNER,
        action: ISSUE,
        commitment: commitment('A'),
        replacementCommitment: ZERO32,
        nonce: '0',
        deadline: DEADLINE,
      },
    ),
    vector(
      'supersede-uint256-limits',
      'Largest usable nonce and largest deadline: integers far beyond 2^53',
      MONAD_MAINNET,
      REGISTRY,
      {
        reviewer: SIGNER,
        action: SUPERSEDE,
        commitment: commitment('C'),
        replacementCommitment: commitment('D'),
        nonce: (UINT256_MAX - 1n).toString(),
        deadline: UINT256_MAX.toString(),
      },
    ),
    vector(
      'issue-contract-reviewer',
      'ISSUE for a contract-account reviewer; the signature is by the account owner key',
      MONAD_TESTNET,
      REGISTRY,
      {
        reviewer: CONTRACT_REVIEWER,
        action: ISSUE,
        commitment: commitment('E'),
        replacementCommitment: ZERO32,
        nonce: '0',
        deadline: DEADLINE,
      },
    ),
  ],
};

const path = join(dirname(fileURLToPath(import.meta.url)), 'vectors.json');
const output = `${JSON.stringify(vectors, null, 2)}\n`;

function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

if (process.argv.includes('--check')) {
  if (readOrNull(path) !== output) {
    console.error('fixtures/registry-v1/vectors.json is not reproducible from generate.mjs');
    process.exit(1);
  }
  console.log('fixtures/registry-v1/vectors.json is reproducible');
} else {
  writeFileSync(path, output);
  console.log(`wrote ${vectors.vectors.length} vectors to fixtures/registry-v1/vectors.json`);
}
