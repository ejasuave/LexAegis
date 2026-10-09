import { hashTypedData, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  EIP712_DOMAIN_FIELDS,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  REVIEW_ACTION_CODES,
  REVIEW_ACTION_FIELDS,
  REVIEW_ACTION_PRIMARY_TYPE,
  REVIEW_ACTION_TYPE_STRING,
} from './constants';
import {
  boundActionOf,
  expectOk,
  failureCode,
  registryVectors,
  UINT256_MAX_DECIMAL,
  ZERO32,
  type RegistryVector,
} from './test-helpers';
import {
  buildTypedData,
  hashReviewAction,
  reviewActionSchema,
  reviewActionTypedDataSchema,
  toAbiReviewAction,
  toEip712ReviewAction,
} from './typed-data';

/*
 * Expected values are literals from fixtures/registry-v1/vectors.json, produced by a generator
 * that shares no code with this SDK or with viem's typed-data encoder. The Solidity registry is
 * checked against the same file in contracts/test/Vectors.t.sol.
 */

const encodeType = (name: string, fields: readonly { name: string; type: string }[]): string =>
  `${name}(${fields.map((field) => `${field.type} ${field.name}`).join(',')})`;

function typedDataOf(vector: RegistryVector) {
  return expectOk(buildTypedData(boundActionOf(vector), vector.chainId, vector.registryAddress));
}

function vectorById(id: string): RegistryVector {
  const found = registryVectors.vectors.find((vector) => vector.id === id);
  if (found === undefined) throw new Error(`missing vector ${id}`);
  return found;
}

describe('registry constants', () => {
  it('match the independent specification literals', () => {
    const { eip712, actionCodes } = registryVectors;
    expect(EIP712_DOMAIN_NAME).toBe(eip712.domain.name);
    expect(EIP712_DOMAIN_VERSION).toBe(eip712.domain.version);
    expect(REVIEW_ACTION_PRIMARY_TYPE).toBe(eip712.primaryType);
    expect(REVIEW_ACTION_TYPE_STRING).toBe(eip712.typeString);
    expect(keccak256(toBytes(REVIEW_ACTION_TYPE_STRING))).toBe(eip712.typeHash);
    expect({ ...REVIEW_ACTION_CODES }).toEqual(actionCodes);
  });

  it('declare fields in exactly the order of the type strings', () => {
    expect(encodeType('ReviewAction', REVIEW_ACTION_FIELDS)).toBe(REVIEW_ACTION_TYPE_STRING);
    expect(encodeType('EIP712Domain', EIP712_DOMAIN_FIELDS)).toBe(
      registryVectors.eip712.domainTypeString,
    );
  });
});

describe('registry v1 vectors', () => {
  it('covers every action, three chains and the uint256 limits', () => {
    expect(registryVectors.vectors.map((vector) => vector.id)).toEqual([
      'issue',
      'revoke',
      'supersede',
      'issue-other-registry',
      'issue-local',
      'supersede-uint256-limits',
      'issue-contract-reviewer',
    ]);
  });

  describe.each(registryVectors.vectors.map((vector) => [vector.id, vector] as const))(
    '%s',
    (_id, vector) => {
      it('reproduces the literal EIP-712 digest', () => {
        expect(expectOk(hashReviewAction(typedDataOf(vector)))).toBe(vector.expected.digest);
      });

      it('reproduces the literal signature with the synthetic test key', async () => {
        const account = privateKeyToAccount(registryVectors.signer.privateKey as `0x${string}`);
        expect(account.address.toLowerCase()).toBe(registryVectors.signer.address);
        const signature = await account.signTypedData(
          expectOk(toEip712ReviewAction(typedDataOf(vector))),
        );
        expect(signature).toBe(vector.expected.signature);
      });

      it('gives the same digest when the full JSON typed data is hashed by viem directly', () => {
        const typedData = typedDataOf(vector);
        // The wallet-facing JSON form, including the explicit EIP712Domain type.
        const digest = hashTypedData({
          domain: {
            ...typedData.domain,
            chainId: BigInt(typedData.domain.chainId),
            verifyingContract: typedData.domain.verifyingContract as `0x${string}`,
          },
          types: typedData.types,
          primaryType: typedData.primaryType,
          message: expectOk(toAbiReviewAction(typedData.message)),
        });
        expect(digest).toBe(vector.expected.digest);
      });

      it('survives a JSON round trip unchanged', () => {
        const typedData = typedDataOf(vector);
        const roundTripped: unknown = JSON.parse(JSON.stringify(typedData));
        expect(roundTripped).toEqual(typedData);
        expect(expectOk(hashReviewAction(roundTripped))).toBe(vector.expected.digest);
      });
    },
  );

  it('binds the digest to chain, registry and every signed field', () => {
    const base = vectorById('issue');
    const digests = new Set([base.expected.digest]);
    const variants: RegistryVector[] = [
      { ...base, chainId: '10144' },
      { ...base, registryAddress: `0x${'12'.repeat(20)}` },
      { ...base, action: { ...base.action, reviewer: `0x${'55'.repeat(20)}` } },
      { ...base, action: { ...base.action, action: 1 } },
      { ...base, action: { ...base.action, commitment: `0x${'66'.repeat(32)}` } },
      { ...base, action: { ...base.action, nonce: '1' } },
      { ...base, action: { ...base.action, deadline: '1800000601' } },
      {
        ...base,
        action: { ...base.action, action: 2, replacementCommitment: `0x${'77'.repeat(32)}` },
      },
    ];
    for (const variant of variants) digests.add(expectOk(hashReviewAction(typedDataOf(variant))));
    expect(digests.size).toBe(variants.length + 1);
  });

  it('keeps integers beyond 2^53 exact', () => {
    const vector = vectorById('supersede-uint256-limits');
    expect(vector.action.deadline).toBe(UINT256_MAX_DECIMAL);
    const abi = expectOk(toAbiReviewAction(vector.action));
    expect(abi.deadline).toBe(2n ** 256n - 1n);
    expect(abi.nonce).toBe(2n ** 256n - 2n);
    expect(typeof abi.action).toBe('number');
  });
});

describe('review action schema', () => {
  const valid = vectorById('issue').action;
  const supersede = vectorById('supersede').action;

  it('accepts the three well-formed shapes', () => {
    expect(reviewActionSchema.safeParse(valid).success).toBe(true);
    expect(reviewActionSchema.safeParse(vectorById('revoke').action).success).toBe(true);
    expect(reviewActionSchema.safeParse(supersede).success).toBe(true);
    expect(reviewActionSchema.safeParse({ ...valid, nonce: UINT256_MAX_DECIMAL }).success).toBe(
      true,
    );
  });

  it.each([
    ['an extra field', { ...valid, memo: 'x' }],
    ['a missing field', { ...valid, deadline: undefined }],
    ['an unknown action code', { ...valid, action: 3 }],
    ['an action code given as a string', { ...valid, action: '0' }],
    ['a checksummed (mixed-case) reviewer', { ...valid, reviewer: valid.reviewer.toUpperCase() }],
    ['the zero reviewer', { ...valid, reviewer: `0x${'00'.repeat(20)}` }],
    ['a zero commitment', { ...valid, commitment: ZERO32 }],
    ['a short commitment', { ...valid, commitment: '0x1234' }],
    ['a numeric nonce', { ...valid, nonce: 0 }],
    ['a bigint nonce', { ...valid, nonce: 0n }],
    ['a nonce with a leading zero', { ...valid, nonce: '01' }],
    ['a negative nonce', { ...valid, nonce: '-1' }],
    ['a hexadecimal nonce', { ...valid, nonce: '0x1' }],
    ['a nonce above uint256', { ...valid, nonce: (2n ** 256n).toString() }],
    ['a zero deadline', { ...valid, deadline: '0' }],
    ['a numeric deadline', { ...valid, deadline: 1800000600 }],
    ['a fractional deadline', { ...valid, deadline: '1800000600.5' }],
    ['a deadline above uint256', { ...valid, deadline: (2n ** 256n).toString() }],
    ['ISSUE with a replacement', { ...valid, replacementCommitment: supersede.commitment }],
    [
      'REVOKE with a replacement',
      { ...valid, action: 1, replacementCommitment: supersede.commitment },
    ],
    ['SUPERSEDE without a replacement', { ...supersede, replacementCommitment: ZERO32 }],
    ['SUPERSEDE onto itself', { ...supersede, replacementCommitment: supersede.commitment }],
  ])('rejects %s', (_label, candidate) => {
    expect(reviewActionSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('buildTypedData', () => {
  const vector = vectorById('issue');
  const bound = boundActionOf(vector);

  it('produces the fixed domain, types and message', () => {
    const typedData = typedDataOf(vector);
    expect(typedData).toEqual({
      domain: {
        name: 'LexAegisProofOfReview',
        version: '1',
        chainId: '10143',
        verifyingContract: vector.registryAddress,
      },
      types: {
        EIP712Domain: [...EIP712_DOMAIN_FIELDS],
        ReviewAction: [...REVIEW_ACTION_FIELDS],
      },
      primaryType: 'ReviewAction',
      message: vector.action,
    });
    expect(Object.isFrozen(typedData)).toBe(true);
    expect(Object.isFrozen(typedData.message)).toBe(true);
    expect(Object.isFrozen(typedData.types.ReviewAction)).toBe(true);
    // The shared constants themselves are untouched.
    expect(Object.isFrozen(REVIEW_ACTION_FIELDS[0])).toBe(false);
  });

  it('refuses a signing domain other than the one the action was built for', () => {
    expect(failureCode(buildTypedData(bound, '143', vector.registryAddress))).toBe(
      'DOMAIN_MISMATCH',
    );
    expect(failureCode(buildTypedData(bound, vector.chainId, `0x${'12'.repeat(20)}`))).toBe(
      'DOMAIN_MISMATCH',
    );
  });

  it('rejects malformed inputs with typed failures', () => {
    expect(failureCode(buildTypedData(vector.action, vector.chainId, vector.registryAddress))).toBe(
      'ACTION_INVALID',
    );
    expect(
      failureCode(
        buildTypedData({ ...bound, extra: true }, vector.chainId, vector.registryAddress),
      ),
    ).toBe('ACTION_INVALID');
    expect(failureCode(buildTypedData(bound, 10143, vector.registryAddress))).toBe(
      'CHAIN_ID_INVALID',
    );
    expect(failureCode(buildTypedData(bound, '0', vector.registryAddress))).toBe(
      'CHAIN_ID_INVALID',
    );
    expect(failureCode(buildTypedData(bound, vector.chainId, `0x${'00'.repeat(20)}`))).toBe(
      'REGISTRY_ADDRESS_INVALID',
    );
    expect(
      failureCode(buildTypedData(bound, vector.chainId, vector.registryAddress.toUpperCase())),
    ).toBe('REGISTRY_ADDRESS_INVALID');

    const failed = buildTypedData(
      { ...bound, action: { ...bound.action, nonce: '01' } },
      vector.chainId,
      vector.registryAddress,
    );
    expect(failed).toEqual({ ok: false, error: { code: 'ACTION_INVALID', path: 'action.nonce' } });
  });
});

describe('hashReviewAction', () => {
  const typedData = typedDataOf(vectorById('issue'));

  it.each([
    ['another domain name', { ...typedData, domain: { ...typedData.domain, name: 'Other' } }],
    ['protocol version 2', { ...typedData, domain: { ...typedData.domain, version: '2' } }],
    ['a salt', { ...typedData, domain: { ...typedData.domain, salt: ZERO32 } }],
    ['a numeric chain ID', { ...typedData, domain: { ...typedData.domain, chainId: 10143 } }],
    ['another primary type', { ...typedData, primaryType: 'Permit' }],
    [
      'reordered fields',
      {
        ...typedData,
        types: { ...typedData.types, ReviewAction: [...typedData.types.ReviewAction].reverse() },
      },
    ],
    ['an extra type', { ...typedData, types: { ...typedData.types, Extra: [] } }],
    ['an extra top-level field', { ...typedData, signature: '0x' }],
    ['the bare action', typedData.message],
  ])('rejects %s', (_label, candidate) => {
    expect(failureCode(hashReviewAction(candidate))).toBe('TYPED_DATA_INVALID');
  });

  it('accepts only typed data that passes the closed schema', () => {
    expect(reviewActionTypedDataSchema.safeParse(typedData).success).toBe(true);
    expect(expectOk(hashReviewAction(typedData))).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
