import { hashTypedData, isHex, type Hex } from 'viem';
import { z } from 'zod';
import {
  chainIdSchema,
  decimalAtMost,
  digestSchema,
  nonZeroAddressSchema,
  unsignedDecimalSchema,
} from '@lexaegis/protocol/v1';
import {
  EIP712_DOMAIN_FIELDS,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  REVIEW_ACTION_CODES,
  REVIEW_ACTION_FIELDS,
  REVIEW_ACTION_PRIMARY_TYPE,
  UINT256_MAX,
  ZERO_BYTES32,
} from './constants';
import { failWith, succeed, type RegistryResult } from './errors';

/*
 * EIP-712 signing data for registry actions. Everything here is pure: it prepares and hashes
 * data, and never unlocks an account, signs, broadcasts or approves a review.
 *
 * Integers are canonical decimal strings at JSON boundaries. They become bigint only for
 * EIP-712 and ABI processing and never pass through a JavaScript number. Deadlines are Unix
 * epoch seconds, not milliseconds.
 */

/** Canonical decimal string in the uint256 range. Zero is allowed. */
export const uint256DecimalSchema = unsignedDecimalSchema.refine(
  (value) => decimalAtMost(value, UINT256_MAX),
  { message: 'exceeds uint256' },
);

/** As uint256DecimalSchema, but zero is rejected. */
export const positiveUint256DecimalSchema = uint256DecimalSchema.refine((value) => value !== '0', {
  message: 'must be positive',
});

/** A commitment that may be issued or targeted: never bytes32(0). */
export const commitmentSchema = digestSchema.refine((value) => value !== ZERO_BYTES32, {
  message: 'zero commitment',
});

const { ISSUE, REVOKE, SUPERSEDE } = REVIEW_ACTION_CODES;

const actionShape = z.strictObject({
  reviewer: nonZeroAddressSchema,
  action: z.literal([ISSUE, REVOKE, SUPERSEDE]),
  commitment: commitmentSchema,
  replacementCommitment: digestSchema,
  nonce: uint256DecimalSchema,
  deadline: positiveUint256DecimalSchema,
});

/**
 * The six signed fields, in contract order. The replacement is bytes32(0) unless the action is
 * SUPERSEDE, where it must be a different, nonzero commitment.
 */
export const reviewActionSchema = actionShape.check((ctx) => {
  if (ctx.issues.length > 0) return;
  const { action, commitment, replacementCommitment } = ctx.value;
  const unused = replacementCommitment === ZERO_BYTES32;
  const misfit = action === SUPERSEDE ? unused || replacementCommitment === commitment : !unused;
  if (misfit) {
    ctx.issues.push({
      code: 'custom',
      message: 'replacement does not fit the action',
      input: ctx.value,
      path: ['replacementCommitment'],
    });
  }
});
export type ReviewActionV1 = z.infer<typeof reviewActionSchema>;

/**
 * An action together with the chain and registry it was built for. Builders take these from
 * the prepared snapshot or receipt reference, so a signing domain cannot be chosen freely later.
 */
export const boundReviewActionSchema = z.strictObject({
  chainId: chainIdSchema,
  registryAddress: nonZeroAddressSchema,
  action: reviewActionSchema,
});
export type BoundReviewAction = z.infer<typeof boundReviewActionSchema>;

function field<Name extends string, Type extends string>(name: Name, type: Type) {
  return z.strictObject({ name: z.literal(name), type: z.literal(type) });
}

/** JSON form of the typed data, suitable for an EIP-712 `eth_signTypedData_v4` request. */
export const reviewActionTypedDataSchema = z.strictObject({
  domain: z.strictObject({
    name: z.literal(EIP712_DOMAIN_NAME),
    version: z.literal(EIP712_DOMAIN_VERSION),
    chainId: chainIdSchema,
    verifyingContract: nonZeroAddressSchema,
  }),
  types: z.strictObject({
    EIP712Domain: z.tuple([
      field('name', 'string'),
      field('version', 'string'),
      field('chainId', 'uint256'),
      field('verifyingContract', 'address'),
    ]),
    ReviewAction: z.tuple([
      field('reviewer', 'address'),
      field('action', 'uint8'),
      field('commitment', 'bytes32'),
      field('replacementCommitment', 'bytes32'),
      field('nonce', 'uint256'),
      field('deadline', 'uint256'),
    ]),
  }),
  primaryType: z.literal(REVIEW_ACTION_PRIMARY_TYPE),
  message: reviewActionSchema,
});
export type ReviewActionTypedData = z.infer<typeof reviewActionTypedDataSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** @internal Shared by the action builders. */
export function freezeResult<T>(value: T): RegistryResult<T> {
  return succeed(deepFreeze(value));
}

/**
 * Builds the typed data a reviewer signs. `chainId` and `registryAddress` state the domain the
 * caller intends to sign for; they must equal the context the action was built from, so a
 * package prepared for one chain or registry can never be signed for another.
 *
 * @example
 * ```ts
 * import { buildTypedData, type BoundReviewAction } from '@lexaegis/sdk/registry';
 *
 * declare const bound: BoundReviewAction;
 * const typedData = buildTypedData(bound, bound.chainId, bound.registryAddress);
 * // Hand typedData.data to YOUR signer; this SDK never signs.
 * ```
 */
export function buildTypedData(
  action: unknown,
  chainId: unknown,
  registryAddress: unknown,
): RegistryResult<ReviewActionTypedData> {
  const bound = boundReviewActionSchema.safeParse(action);
  if (!bound.success) return failWith('ACTION_INVALID', bound.error.issues[0]?.path);
  const chain = chainIdSchema.safeParse(chainId);
  if (!chain.success) return failWith('CHAIN_ID_INVALID');
  const registry = nonZeroAddressSchema.safeParse(registryAddress);
  if (!registry.success) return failWith('REGISTRY_ADDRESS_INVALID');
  if (chain.data !== bound.data.chainId || registry.data !== bound.data.registryAddress) {
    return failWith('DOMAIN_MISMATCH');
  }
  // Parsing returns fresh objects, so freezing the result never freezes the shared constants.
  return freezeResult(
    reviewActionTypedDataSchema.parse({
      domain: {
        name: EIP712_DOMAIN_NAME,
        version: EIP712_DOMAIN_VERSION,
        chainId: chain.data,
        verifyingContract: registry.data,
      },
      types: { EIP712Domain: EIP712_DOMAIN_FIELDS, ReviewAction: REVIEW_ACTION_FIELDS },
      primaryType: REVIEW_ACTION_PRIMARY_TYPE,
      message: bound.data.action,
    }),
  );
}

function hex(value: string): Hex {
  // Every caller passes a schema-validated lowercase hex string.
  if (!isHex(value)) throw new TypeError('expected hex');
  return value;
}

/** The action as the ABI tuple that `execute` and `hashAction` take. */
export interface AbiReviewAction {
  readonly reviewer: Hex;
  readonly action: number;
  readonly commitment: Hex;
  readonly replacementCommitment: Hex;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

function abiAction(action: ReviewActionV1): AbiReviewAction {
  return {
    reviewer: hex(action.reviewer),
    action: action.action,
    commitment: hex(action.commitment),
    replacementCommitment: hex(action.replacementCommitment),
    nonce: BigInt(action.nonce),
    deadline: BigInt(action.deadline),
  };
}

/**
 * Converts a validated action to bigint ABI values for a contract call.
 *
 * @example
 * ```ts
 * import { toAbiReviewAction, type BoundReviewAction } from '@lexaegis/sdk/registry';
 *
 * declare const bound: BoundReviewAction;
 * const abiAction = toAbiReviewAction(bound.action); // bigint fields for a contract call
 * ```
 */
export function toAbiReviewAction(action: unknown): RegistryResult<AbiReviewAction> {
  const parsed = reviewActionSchema.safeParse(action);
  if (!parsed.success) return failWith('ACTION_INVALID', parsed.error.issues[0]?.path);
  return succeed(abiAction(parsed.data));
}

/** The typed data with bigint integers, in the shape EIP-712 libraries consume. */
export interface Eip712ReviewAction {
  readonly domain: {
    readonly name: typeof EIP712_DOMAIN_NAME;
    readonly version: typeof EIP712_DOMAIN_VERSION;
    readonly chainId: bigint;
    readonly verifyingContract: Hex;
  };
  readonly types: { readonly ReviewAction: typeof REVIEW_ACTION_FIELDS };
  readonly primaryType: typeof REVIEW_ACTION_PRIMARY_TYPE;
  readonly message: AbiReviewAction;
}

/**
 * Converts validated JSON typed data to bigint values for an EIP-712 library.
 *
 * @example
 * ```ts
 * import { buildTypedData, toEip712ReviewAction, type BoundReviewAction } from '@lexaegis/sdk/registry';
 *
 * declare const bound: BoundReviewAction;
 * const typedData = buildTypedData(bound, bound.chainId, bound.registryAddress);
 * if (typedData.ok) console.log(toEip712ReviewAction(typedData.data).ok);
 * ```
 */
export function toEip712ReviewAction(typedData: unknown): RegistryResult<Eip712ReviewAction> {
  const parsed = reviewActionTypedDataSchema.safeParse(typedData);
  if (!parsed.success) return failWith('TYPED_DATA_INVALID', parsed.error.issues[0]?.path);
  const { domain, message } = parsed.data;
  return succeed({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: BigInt(domain.chainId),
      verifyingContract: hex(domain.verifyingContract),
    },
    types: { ReviewAction: REVIEW_ACTION_FIELDS },
    primaryType: REVIEW_ACTION_PRIMARY_TYPE,
    message: abiAction(message),
  });
}

/**
 * EIP-712 digest of the typed data: the value the registry's `hashAction` returns and the
 * reviewer signs. It is not the Chapter 2 package digest and cannot be substituted for it.
 *
 * @example
 * ```ts
 * import { buildTypedData, hashReviewAction, type BoundReviewAction } from '@lexaegis/sdk/registry';
 *
 * declare const bound: BoundReviewAction;
 * const typedData = buildTypedData(bound, bound.chainId, bound.registryAddress);
 * if (typedData.ok) console.log(hashReviewAction(typedData.data)); // the digest the reviewer signs
 * ```
 */
export function hashReviewAction(typedData: unknown): RegistryResult<string> {
  const converted = toEip712ReviewAction(typedData);
  if (!converted.ok) return converted;
  return succeed(hashTypedData(converted.data));
}
