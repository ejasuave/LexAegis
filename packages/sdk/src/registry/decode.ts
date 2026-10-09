import {
  decodeEventLog,
  decodeFunctionResult,
  getAbiItem,
  toEventSelector,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { z } from 'zod';
import {
  chainIdSchema,
  digestSchema,
  nonZeroAddressSchema,
  parseReceiptReference,
} from '@lexaegis/protocol/v1';
import type { ReceiptLifecycle } from '@lexaegis/protocol';
import { RECEIPT_STATUS_ORDER, ZERO_BYTES32 } from './constants';
import { failWith, succeed, type RegistryResult } from './errors';
import { proofOfReviewRegistryAbi } from './generated/registry-abi';
import { uint256DecimalSchema } from './typed-data';

/*
 * Strict decoding of data observed from the registry: a receipt record, the four events and the
 * known custom errors. Layouts come from the generated ABI; nothing here is a second,
 * handwritten ABI.
 *
 * Decoding says what the bytes mean. It does not establish that they came from a trustworthy
 * RPC endpoint, from the intended block, or from a reviewer anyone should accept. A failure of
 * any kind (RPC error, missing contract code, empty response, unknown enum value) is a typed
 * failure and must be shown as "unknown", never as "not found".
 */

const abi = proofOfReviewRegistryAbi;
const WORD = 32;

const lowerHexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);

function readHex(input: unknown): Hex | null {
  const parsed = lowerHexSchema.safeParse(input);
  if (!parsed.success) return null;
  return `0x${parsed.data.slice(2).toLowerCase()}`;
}

const byteLength = (data: Hex): number => (data.length - 2) / 2;
const absentIfZero = (value: string): string | null => (value === ZERO_BYTES32 ? null : value);

function lifecycleFromStatus(
  status: bigint | number,
): (typeof RECEIPT_STATUS_ORDER)[number] | null {
  const index = BigInt(status);
  if (index < 0n || index >= BigInt(RECEIPT_STATUS_ORDER.length)) return null;
  return RECEIPT_STATUS_ORDER[Number(index)] ?? null;
}

// ---- Receipt -----------------------------------------------------------------------------------

/** Chain and registry an observation was read from. */
export const registryContextSchema = z.strictObject({
  chainId: chainIdSchema,
  registryAddress: nonZeroAddressSchema,
});
export type RegistryContext = z.infer<typeof registryContextSchema>;

/**
 * One registry record as decoded, with the lookup tuple it was read for. Absent links are null.
 * Times are Unix seconds as decimal strings. `receiptLifecycle` is never "unknown" here: an
 * unreadable record is a failure, not an observation.
 */
export const observedReceiptSchema = z.strictObject({
  chainId: chainIdSchema,
  registryAddress: nonZeroAddressSchema,
  reviewerAddress: nonZeroAddressSchema,
  commitment: digestSchema,
  receiptLifecycle: z.enum(RECEIPT_STATUS_ORDER),
  predecessor: digestSchema.nullable(),
  successor: digestSchema.nullable(),
  issuedAt: uint256DecimalSchema,
  updatedAt: uint256DecimalSchema,
});
export type ObservedReceipt = z.infer<typeof observedReceiptSchema>;

const receiptWords = getAbiItem({ abi, name: 'getReceipt' }).outputs[0].components.length;

/**
 * Decodes the return data of `getReceipt(reviewer, commitment)` for the receipt identified by
 * `receiptReference`. The data must be exactly one Receipt struct.
 */
export function decodeReceipt(
  receiptReference: unknown,
  returnData: unknown,
): RegistryResult<ObservedReceipt> {
  const reference = parseReceiptReference(receiptReference);
  if (!reference.ok) return failWith('CONTEXT_INVALID', reference.error.path?.split('.'));
  const data = readHex(returnData);
  if (data === null) return failWith('RESPONSE_MALFORMED');
  // A call to an address without code succeeds with no data: that is not a NotFound receipt.
  if (byteLength(data) === 0) return failWith('EMPTY_RESPONSE');
  if (byteLength(data) !== receiptWords * WORD) return failWith('RESPONSE_MALFORMED');

  // The status is checked as a whole word, so stray high bits are never read as a valid enum.
  const receiptLifecycle = lifecycleFromStatus(BigInt(data.slice(0, 2 + WORD * 2)));
  if (receiptLifecycle === null) return failWith('STATUS_UNKNOWN');

  const receipt = decodeFunctionResult({ abi, functionName: 'getReceipt', data });
  return succeed({
    chainId: reference.data.chainId,
    registryAddress: reference.data.registryAddress,
    reviewerAddress: reference.data.reviewerAddress,
    commitment: reference.data.commitment,
    receiptLifecycle,
    predecessor: absentIfZero(receipt.predecessor),
    successor: absentIfZero(receipt.successor),
    issuedAt: receipt.issuedAt.toString(),
    updatedAt: receipt.updatedAt.toString(),
  });
}

/**
 * Lifecycle to display for a read. A failed or undecodable read is "unknown"; only a
 * successfully decoded NotFound record is "not_found".
 */
export function receiptLifecycleOf(read: RegistryResult<ObservedReceipt>): ReceiptLifecycle {
  return read.ok ? read.data.receiptLifecycle : 'unknown';
}

// ---- Events ------------------------------------------------------------------------------------

const eventContext = {
  chainId: chainIdSchema,
  registryAddress: nonZeroAddressSchema,
  reviewerAddress: nonZeroAddressSchema,
};

/**
 * A decoded registry event. A SUPERSEDE emits `issued` (for the replacement, with its
 * predecessor set) and then `superseded`, both with the same nonce: one atomic action, in which
 * the replacement receipt must be counted once.
 */
export const registryEventSchema = z.discriminatedUnion('eventKind', [
  z.strictObject({
    eventKind: z.literal('issued'),
    ...eventContext,
    commitment: digestSchema,
    predecessor: digestSchema.nullable(),
    nonce: uint256DecimalSchema,
    timestamp: uint256DecimalSchema,
  }),
  z.strictObject({
    eventKind: z.literal('revoked'),
    ...eventContext,
    commitment: digestSchema,
    nonce: uint256DecimalSchema,
    timestamp: uint256DecimalSchema,
  }),
  z.strictObject({
    eventKind: z.literal('superseded'),
    ...eventContext,
    previousCommitment: digestSchema,
    replacementCommitment: digestSchema,
    nonce: uint256DecimalSchema,
    timestamp: uint256DecimalSchema,
  }),
  z.strictObject({
    eventKind: z.literal('nonce_invalidated'),
    ...eventContext,
    previousNonce: uint256DecimalSchema,
    newNonce: uint256DecimalSchema,
    timestamp: uint256DecimalSchema,
  }),
]);
export type RegistryEvent = z.infer<typeof registryEventSchema>;

const topicSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** The three log fields that decoding needs. Block context is validated by the caller. */
export const registryLogSchema = z.strictObject({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  topics: z.array(topicSchema).min(1).max(4),
  data: lowerHexSchema,
});
export type RegistryLog = z.infer<typeof registryLogSchema>;

const REGISTRY_EVENT_NAMES = [
  'ReceiptIssued',
  'ReceiptRevoked',
  'ReceiptSuperseded',
  'NonceInvalidated',
] as const;

interface EventLayout {
  readonly topics: number;
  readonly dataBytes: number;
  /** Positions in `topics` that hold an indexed address. */
  readonly addressTopics: readonly number[];
}

/** Topic and data sizes of the four registry events, read from the generated ABI. */
function eventLayouts(): ReadonlyMap<string, EventLayout> {
  const layouts = new Map<string, EventLayout>();
  for (const item of abi) {
    if (item.type !== 'event') continue;
    if (!REGISTRY_EVENT_NAMES.some((name) => name === item.name)) continue;
    const indexed = item.inputs.filter((input) => input.indexed);
    layouts.set(toEventSelector(item), {
      topics: 1 + indexed.length,
      dataBytes: (item.inputs.length - indexed.length) * WORD,
      addressTopics: indexed.flatMap((input, index) =>
        input.type === 'address' ? [index + 1] : [],
      ),
    });
  }
  return layouts;
}

const ADDRESS_TOPIC = /^0x0{24}[0-9a-f]{40}$/;

let cachedLayouts: ReadonlyMap<string, EventLayout> | undefined;

/** Decodes one registry log emitted by the registry named in `context`. */
export function decodeRegistryEvent(context: unknown, log: unknown): RegistryResult<RegistryEvent> {
  const where = registryContextSchema.safeParse(context);
  if (!where.success) return failWith('CONTEXT_INVALID', where.error.issues[0]?.path);
  const parsed = registryLogSchema.safeParse(log);
  if (!parsed.success) return failWith('LOG_MALFORMED', parsed.error.issues[0]?.path);
  if (parsed.data.address.toLowerCase() !== where.data.registryAddress) {
    return failWith('LOG_ADDRESS_MISMATCH');
  }

  const [signature, ...indexed] = parsed.data.topics.map((topic) => readHex(topic));
  const data = readHex(parsed.data.data);
  if (signature === undefined || signature === null || data === null)
    return failWith('LOG_MALFORMED');
  const args = indexed.filter((topic) => topic !== null);

  cachedLayouts ??= eventLayouts();
  const layout = cachedLayouts.get(signature);
  if (layout === undefined) return failWith('EVENT_UNKNOWN');
  if (parsed.data.topics.length !== layout.topics || byteLength(data) !== layout.dataBytes) {
    return failWith('LOG_MALFORMED');
  }
  // An address topic is left-padded with zeros; anything else is not a canonical log.
  if (layout.addressTopics.some((index) => !ADDRESS_TOPIC.test(args[index - 1] ?? ''))) {
    return failWith('LOG_MALFORMED');
  }

  let decoded;
  try {
    decoded = decodeEventLog({ abi, topics: [signature, ...args], data, strict: true });
  } catch {
    return failWith('LOG_MALFORMED');
  }

  const base = { chainId: where.data.chainId, registryAddress: where.data.registryAddress };
  const event = ((): RegistryEvent | null => {
    switch (decoded.eventName) {
      case 'ReceiptIssued':
        return {
          eventKind: 'issued',
          ...base,
          reviewerAddress: decoded.args.reviewer.toLowerCase(),
          commitment: decoded.args.commitment,
          predecessor: absentIfZero(decoded.args.predecessor),
          nonce: decoded.args.nonce.toString(),
          timestamp: decoded.args.timestamp.toString(),
        };
      case 'ReceiptRevoked':
        return {
          eventKind: 'revoked',
          ...base,
          reviewerAddress: decoded.args.reviewer.toLowerCase(),
          commitment: decoded.args.commitment,
          nonce: decoded.args.nonce.toString(),
          timestamp: decoded.args.timestamp.toString(),
        };
      case 'ReceiptSuperseded':
        return {
          eventKind: 'superseded',
          ...base,
          reviewerAddress: decoded.args.reviewer.toLowerCase(),
          previousCommitment: decoded.args.previousCommitment,
          replacementCommitment: decoded.args.replacementCommitment,
          nonce: decoded.args.nonce.toString(),
          timestamp: decoded.args.timestamp.toString(),
        };
      case 'NonceInvalidated':
        return {
          eventKind: 'nonce_invalidated',
          ...base,
          reviewerAddress: decoded.args.reviewer.toLowerCase(),
          previousNonce: decoded.args.previousNonce.toString(),
          newNonce: decoded.args.newNonce.toString(),
          timestamp: decoded.args.timestamp.toString(),
        };
      default:
        return null;
    }
  })();
  if (event === null) return failWith('EVENT_UNKNOWN');

  // A zero reviewer, which the registry never emits, does not pass the schema.
  const checked = registryEventSchema.safeParse(event);
  return checked.success ? succeed(checked.data) : failWith('LOG_MALFORMED');
}

// ---- Custom errors -----------------------------------------------------------------------------

const plainRevert = <Name extends string>(name: Name) => z.strictObject({ name: z.literal(name) });

/** A known registry revert. Arguments are public values only. */
export const registryRevertSchema = z.discriminatedUnion('name', [
  plainRevert('InvalidActionShape'),
  plainRevert('ZeroReviewer'),
  plainRevert('ZeroCommitment'),
  z.strictObject({ name: z.literal('InvalidNonce'), currentNonce: uint256DecimalSchema }),
  plainRevert('NonceExhausted'),
  plainRevert('AuthorizationExpired'),
  plainRevert('InvalidSignature'),
  plainRevert('ReceiptAlreadyIssued'),
  z.strictObject({
    name: z.literal('InvalidLifecycleTransition'),
    currentStatus: z.enum(RECEIPT_STATUS_ORDER),
  }),
]);
export type RegistryRevert = z.infer<typeof registryRevertSchema>;

const SELECTOR_BYTES = 4;

const REGISTRY_ERROR_NAMES = [
  'InvalidActionShape',
  'ZeroReviewer',
  'ZeroCommitment',
  'InvalidNonce',
  'NonceExhausted',
  'AuthorizationExpired',
  'InvalidSignature',
  'ReceiptAlreadyIssued',
  'InvalidLifecycleTransition',
] as const;
type RegistryErrorName = (typeof REGISTRY_ERROR_NAMES)[number];

interface ErrorLayout {
  readonly name: RegistryErrorName;
  /** Every registry error argument is one static word. */
  readonly words: number;
}

/** Selector and argument count of the nine registry errors, read from the generated ABI. */
function errorLayouts(): ReadonlyMap<string, ErrorLayout> {
  const layouts = new Map<string, ErrorLayout>();
  for (const item of abi) {
    if (item.type !== 'error') continue;
    const name = REGISTRY_ERROR_NAMES.find((candidate) => candidate === item.name);
    if (name === undefined) continue;
    const signature = `${item.name}(${item.inputs.map((input) => input.type).join(',')})`;
    layouts.set(toFunctionSelector(signature), { name, words: item.inputs.length });
  }
  return layouts;
}

let cachedErrorLayouts: ReadonlyMap<string, ErrorLayout> | undefined;

/**
 * Decodes revert data into a known registry error. Anything else, including library errors
 * and plain `Error(string)` reverts, is ERROR_UNKNOWN.
 */
export function decodeRegistryError(revertData: unknown): RegistryResult<RegistryRevert> {
  const data = readHex(revertData);
  if (data === null) return failWith('RESPONSE_MALFORMED');
  if (byteLength(data) === 0) return failWith('EMPTY_RESPONSE');
  if (byteLength(data) < SELECTOR_BYTES) return failWith('RESPONSE_MALFORMED');

  cachedErrorLayouts ??= errorLayouts();
  const layout = cachedErrorLayouts.get(data.slice(0, 2 + SELECTOR_BYTES * 2));
  if (layout === undefined) return failWith('ERROR_UNKNOWN');
  if (byteLength(data) !== SELECTOR_BYTES + layout.words * WORD)
    return failWith('RESPONSE_MALFORMED');

  // The single argument, when there is one, is read as a whole word.
  const argument = layout.words === 1 ? BigInt(`0x${data.slice(2 + SELECTOR_BYTES * 2)}`) : 0n;
  switch (layout.name) {
    case 'InvalidNonce':
      return succeed({ name: layout.name, currentNonce: argument.toString() });
    case 'InvalidLifecycleTransition': {
      const currentStatus = lifecycleFromStatus(argument);
      if (currentStatus === null) return failWith('STATUS_UNKNOWN');
      return succeed({ name: layout.name, currentStatus });
    }
    default:
      return succeed({ name: layout.name });
  }
}
