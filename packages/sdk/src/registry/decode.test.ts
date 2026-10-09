import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  toHex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { RECEIPT_STATUS_ORDER, SUPERSESSION_EVENT_ORDER } from './constants';
import {
  decodeReceipt,
  decodeRegistryError,
  decodeRegistryEvent,
  receiptLifecycleOf,
} from './decode';
import { proofOfReviewRegistryAbi as abi } from './generated/registry-abi';
import { expectOk, failureCode, UINT256_MAX_DECIMAL, ZERO32 } from './test-helpers';

const REFERENCE = {
  schema: 'lexaegis.receipt-ref.v1',
  chainId: '10143',
  registryAddress: `0x${'11'.repeat(20)}`,
  reviewerAddress: `0x${'22'.repeat(20)}`,
  commitment: `0x${'aa'.repeat(32)}`,
} as const;
const CONTEXT = { chainId: REFERENCE.chainId, registryAddress: REFERENCE.registryAddress };
const REVIEWER = REFERENCE.reviewerAddress;
const A = REFERENCE.commitment;
const B = `0x${'bb'.repeat(32)}` as const;
const ZERO = ZERO32 as `0x${string}`;

interface ReceiptFields {
  status: number;
  predecessor?: `0x${string}`;
  successor?: `0x${string}`;
  issuedAt?: bigint;
  updatedAt?: bigint;
}

function encodeReceipt(fields: ReceiptFields): `0x${string}` {
  return encodeFunctionResult({
    abi,
    functionName: 'getReceipt',
    result: {
      status: fields.status,
      predecessor: fields.predecessor ?? ZERO,
      successor: fields.successor ?? ZERO,
      issuedAt: fields.issuedAt ?? 0n,
      updatedAt: fields.updatedAt ?? 0n,
    },
  });
}

describe('generated registry ABI', () => {
  const names = (type: string) => abi.filter((item) => item.type === type).map((item) => item.name);

  it('is exactly the ownerless v1 surface', () => {
    expect(names('function')).toEqual([
      'REVIEW_ACTION_TYPEHASH',
      'eip712Domain',
      'execute',
      'getReceipt',
      'hashAction',
      'invalidateNonce',
      'nonceOf',
      'protocolVersion',
    ]);
    const mutating = abi.filter(
      (item) =>
        item.type === 'function' &&
        item.stateMutability !== 'view' &&
        item.stateMutability !== 'pure',
    );
    expect(mutating.map((item) => item.name)).toEqual(['execute', 'invalidateNonce']);
    // Nothing accepts value, and there is no privileged or upgrade entry point.
    const mutabilities: string[] = abi.flatMap((item) =>
      item.type === 'function' ? [item.stateMutability] : [],
    );
    expect([...new Set(mutabilities)].sort()).toEqual(['nonpayable', 'pure', 'view']);
    expect(abi.map((item) => item.type)).not.toContain('constructor');
    for (const item of abi) {
      expect(item.name).not.toMatch(/owner|admin|upgrade|pause|allow|trusted|initialize|role/i);
    }
  });

  it('declares the four events and nine registry errors', () => {
    expect(names('event')).toEqual([
      'EIP712DomainChanged',
      'NonceInvalidated',
      'ReceiptIssued',
      'ReceiptRevoked',
      'ReceiptSuperseded',
    ]);
    expect(names('error')).toEqual([
      'AuthorizationExpired',
      'InvalidActionShape',
      'InvalidLifecycleTransition',
      'InvalidNonce',
      'InvalidShortString',
      'InvalidSignature',
      'NonceExhausted',
      'ReceiptAlreadyIssued',
      'StringTooLong',
      'ZeroCommitment',
      'ZeroReviewer',
    ]);
  });

  it('carries no private field in any event or error argument', () => {
    const argumentNames = abi
      .filter((item) => item.type === 'event' || item.type === 'error')
      .flatMap((item) => item.inputs.map((input) => input.name));
    expect([...new Set(argumentNames)].sort()).toEqual([
      'commitment',
      'currentNonce',
      'currentStatus',
      'newNonce',
      'nonce',
      'predecessor',
      'previousCommitment',
      'previousNonce',
      'replacementCommitment',
      'reviewer',
      'str',
      'timestamp',
    ]);
  });
});

describe('decodeReceipt', () => {
  it('maps each contract status and keeps the lookup context', () => {
    expect(expectOk(decodeReceipt(REFERENCE, encodeReceipt({ status: 0 })))).toEqual({
      chainId: '10143',
      registryAddress: REFERENCE.registryAddress,
      reviewerAddress: REVIEWER,
      commitment: A,
      receiptLifecycle: 'not_found',
      predecessor: null,
      successor: null,
      issuedAt: '0',
      updatedAt: '0',
    });
    expect(
      expectOk(decodeReceipt(REFERENCE, encodeReceipt({ status: 1, issuedAt: 5n, updatedAt: 5n }))),
    ).toMatchObject({ receiptLifecycle: 'active', issuedAt: '5', updatedAt: '5' });
    expect(
      expectOk(decodeReceipt(REFERENCE, encodeReceipt({ status: 2, issuedAt: 5n, updatedAt: 9n }))),
    ).toMatchObject({ receiptLifecycle: 'revoked', updatedAt: '9' });
    expect(
      expectOk(
        decodeReceipt(
          REFERENCE,
          encodeReceipt({ status: 3, predecessor: B, successor: B, issuedAt: 5n, updatedAt: 9n }),
        ),
      ),
    ).toMatchObject({ receiptLifecycle: 'superseded', predecessor: B, successor: B });
    expect(RECEIPT_STATUS_ORDER).toEqual(['not_found', 'active', 'revoked', 'superseded']);
  });

  it('keeps large timestamps exact and normalizes hex case', () => {
    const max = 2n ** 256n - 1n;
    const data = encodeReceipt({ status: 1, issuedAt: max, updatedAt: max });
    expect(
      expectOk(decodeReceipt(REFERENCE, data.toUpperCase().replace('0X', '0x'))),
    ).toMatchObject({
      issuedAt: UINT256_MAX_DECIMAL,
      updatedAt: UINT256_MAX_DECIMAL,
    });
  });

  it('never reports a failed or empty read as not found', () => {
    const noCode = decodeReceipt(REFERENCE, '0x');
    expect(failureCode(noCode)).toBe('EMPTY_RESPONSE');
    expect(receiptLifecycleOf(noCode)).toBe('unknown');

    for (const response of [undefined, null, { error: 'rate limited' }, 'not hex', '0x0', 42]) {
      const read = decodeReceipt(REFERENCE, response);
      expect(failureCode(read)).toBe('RESPONSE_MALFORMED');
      expect(receiptLifecycleOf(read)).toBe('unknown');
    }
    expect(receiptLifecycleOf(decodeReceipt(REFERENCE, encodeReceipt({ status: 0 })))).toBe(
      'not_found',
    );
  });

  it('treats an unknown enum value as unknown, including stray high bits', () => {
    const word = (value: bigint) => toHex(value, { size: 32 }).slice(2);
    const rest = encodeReceipt({ status: 0 }).slice(2 + 64);
    for (const status of [4n, 255n, 256n, 2n ** 255n + 1n]) {
      const read = decodeReceipt(REFERENCE, `0x${word(status)}${rest}`);
      expect(failureCode(read)).toBe('STATUS_UNKNOWN');
      expect(receiptLifecycleOf(read)).toBe('unknown');
    }
  });

  it('requires exactly one Receipt struct', () => {
    const data = encodeReceipt({ status: 1, issuedAt: 5n, updatedAt: 5n });
    expect(failureCode(decodeReceipt(REFERENCE, data.slice(0, -2)))).toBe('RESPONSE_MALFORMED');
    expect(failureCode(decodeReceipt(REFERENCE, `${data}00`))).toBe('RESPONSE_MALFORMED');
    expect(failureCode(decodeReceipt(REFERENCE, `${data}${'00'.repeat(32)}`))).toBe(
      'RESPONSE_MALFORMED',
    );
    expect(failureCode(decodeReceipt(REFERENCE, data.slice(0, 2 + 64)))).toBe('RESPONSE_MALFORMED');
  });

  it('requires a valid lookup reference', () => {
    const data = encodeReceipt({ status: 1 });
    expect(failureCode(decodeReceipt({ ...REFERENCE, chainId: '0' }, data))).toBe(
      'CONTEXT_INVALID',
    );
    expect(failureCode(decodeReceipt(CONTEXT, data))).toBe('CONTEXT_INVALID');
  });
});

function encodeLog(
  eventName: 'ReceiptIssued' | 'ReceiptRevoked' | 'ReceiptSuperseded' | 'NonceInvalidated',
  indexed: readonly `0x${string}`[],
  values: readonly bigint[],
) {
  const [signature] = encodeEventTopics({ abi, eventName });
  return {
    address: REFERENCE.registryAddress,
    topics: [signature, ...indexed],
    data: encodeAbiParameters(
      values.map(() => ({ type: 'uint256' })),
      [...values],
    ),
  };
}

const reviewerTopic = `0x${'00'.repeat(12)}${REVIEWER.slice(2)}` as const;

describe('decodeRegistryEvent', () => {
  it('decodes the four events with their context', () => {
    expect(
      expectOk(
        decodeRegistryEvent(
          CONTEXT,
          encodeLog('ReceiptIssued', [reviewerTopic, A, ZERO], [3n, 99n]),
        ),
      ),
    ).toEqual({
      eventKind: 'issued',
      ...CONTEXT,
      reviewerAddress: REVIEWER,
      commitment: A,
      predecessor: null,
      nonce: '3',
      timestamp: '99',
    });
    expect(
      expectOk(
        decodeRegistryEvent(CONTEXT, encodeLog('ReceiptRevoked', [reviewerTopic, A], [4n, 100n])),
      ),
    ).toEqual({
      eventKind: 'revoked',
      ...CONTEXT,
      reviewerAddress: REVIEWER,
      commitment: A,
      nonce: '4',
      timestamp: '100',
    });
    expect(
      expectOk(
        decodeRegistryEvent(
          CONTEXT,
          encodeLog('ReceiptSuperseded', [reviewerTopic, A, B], [5n, 101n]),
        ),
      ),
    ).toEqual({
      eventKind: 'superseded',
      ...CONTEXT,
      reviewerAddress: REVIEWER,
      previousCommitment: A,
      replacementCommitment: B,
      nonce: '5',
      timestamp: '101',
    });
    expect(
      expectOk(
        decodeRegistryEvent(
          CONTEXT,
          encodeLog('NonceInvalidated', [reviewerTopic], [6n, 7n, 102n]),
        ),
      ),
    ).toEqual({
      eventKind: 'nonce_invalidated',
      ...CONTEXT,
      reviewerAddress: REVIEWER,
      previousNonce: '6',
      newNonce: '7',
      timestamp: '102',
    });
  });

  it('reads one supersession as two logs with one nonce, issuance first', () => {
    expect(SUPERSESSION_EVENT_ORDER).toEqual(['ReceiptIssued', 'ReceiptSuperseded']);
    const logs = [
      encodeLog('ReceiptIssued', [reviewerTopic, B, A], [5n, 101n]),
      encodeLog('ReceiptSuperseded', [reviewerTopic, A, B], [5n, 101n]),
    ];
    const [issued, superseded] = logs.map((log) => expectOk(decodeRegistryEvent(CONTEXT, log)));
    expect(issued).toMatchObject({
      eventKind: 'issued',
      commitment: B,
      predecessor: A,
      nonce: '5',
    });
    expect(superseded).toMatchObject({
      eventKind: 'superseded',
      previousCommitment: A,
      replacementCommitment: B,
      nonce: '5',
    });
  });

  it('rejects logs from another address and unknown events', () => {
    const log = encodeLog('ReceiptRevoked', [reviewerTopic, A], [4n, 100n]);
    expect(
      failureCode(decodeRegistryEvent(CONTEXT, { ...log, address: `0x${'12'.repeat(20)}` })),
    ).toBe('LOG_ADDRESS_MISMATCH');
    // A checksummed or upper-case emitter address is the same address.
    expect(
      decodeRegistryEvent(CONTEXT, {
        ...log,
        address: log.address.toUpperCase().replace('0X', '0x'),
      }).ok,
    ).toBe(true);

    const [domainChanged] = encodeEventTopics({ abi, eventName: 'EIP712DomainChanged' });
    expect(
      failureCode(
        decodeRegistryEvent(CONTEXT, { address: log.address, topics: [domainChanged], data: '0x' }),
      ),
    ).toBe('EVENT_UNKNOWN');
    expect(
      failureCode(
        decodeRegistryEvent(CONTEXT, {
          ...log,
          topics: [`0x${'fe'.repeat(32)}`, reviewerTopic, A],
        }),
      ),
    ).toBe('EVENT_UNKNOWN');
  });

  it('rejects malformed logs', () => {
    const log = encodeLog('ReceiptIssued', [reviewerTopic, A, ZERO], [3n, 99n]);
    const malformed: unknown[] = [
      { ...log, topics: log.topics.slice(0, 3) },
      { ...log, data: log.data.slice(0, -64) },
      { ...log, data: `${log.data}${'00'.repeat(32)}` },
      { ...log, data: '0x' },
      { ...log, topics: [log.topics[0], `0x${'01'.repeat(12)}${REVIEWER.slice(2)}`, A, ZERO] },
      { ...log, topics: [log.topics[0], `0x${'00'.repeat(32)}`, A, ZERO] },
      { ...log, topics: [] },
      { ...log, blockNumber: '0x1' },
      { address: log.address, topics: log.topics },
      null,
    ];
    for (const candidate of malformed) {
      expect(failureCode(decodeRegistryEvent(CONTEXT, candidate))).toBe('LOG_MALFORMED');
    }
    expect(failureCode(decodeRegistryEvent({ chainId: '10143' }, log))).toBe('CONTEXT_INVALID');
  });
});

describe('decodeRegistryError', () => {
  it('decodes every registry error', () => {
    const plain = [
      'InvalidActionShape',
      'ZeroReviewer',
      'ZeroCommitment',
      'NonceExhausted',
      'AuthorizationExpired',
      'InvalidSignature',
      'ReceiptAlreadyIssued',
    ] as const;
    for (const errorName of plain) {
      expect(expectOk(decodeRegistryError(encodeErrorResult({ abi, errorName })))).toEqual({
        name: errorName,
      });
    }
    expect(
      expectOk(
        decodeRegistryError(
          encodeErrorResult({ abi, errorName: 'InvalidNonce', args: [2n ** 256n - 1n] }),
        ),
      ),
    ).toEqual({ name: 'InvalidNonce', currentNonce: UINT256_MAX_DECIMAL });
    for (const [status, lifecycle] of RECEIPT_STATUS_ORDER.entries()) {
      expect(
        expectOk(
          decodeRegistryError(
            encodeErrorResult({ abi, errorName: 'InvalidLifecycleTransition', args: [status] }),
          ),
        ),
      ).toEqual({ name: 'InvalidLifecycleTransition', currentStatus: lifecycle });
    }
  });

  it('does not guess at anything else', () => {
    const selector = encodeErrorResult({
      abi,
      errorName: 'InvalidLifecycleTransition',
      args: [0],
    }).slice(0, 10);
    expect(failureCode(decodeRegistryError(`${selector}${'00'.repeat(31)}04`))).toBe(
      'STATUS_UNKNOWN',
    );
    expect(failureCode(decodeRegistryError(`${selector}${'01'.repeat(32)}`))).toBe(
      'STATUS_UNKNOWN',
    );

    // Library errors that share the ABI are not registry errors.
    expect(
      failureCode(decodeRegistryError(encodeErrorResult({ abi, errorName: 'InvalidShortString' }))),
    ).toBe('ERROR_UNKNOWN');
    // Error(string), Panic(uint256) and an unknown selector.
    expect(failureCode(decodeRegistryError(`0x08c379a0${'00'.repeat(96)}`))).toBe('ERROR_UNKNOWN');
    expect(failureCode(decodeRegistryError(`0x4e487b71${'00'.repeat(31)}11`))).toBe(
      'ERROR_UNKNOWN',
    );
    expect(failureCode(decodeRegistryError('0xdeadbeef'))).toBe('ERROR_UNKNOWN');

    const invalidSignature = encodeErrorResult({ abi, errorName: 'InvalidSignature' });
    expect(failureCode(decodeRegistryError(`${invalidSignature}00`))).toBe('RESPONSE_MALFORMED');
    expect(failureCode(decodeRegistryError('0x'))).toBe('EMPTY_RESPONSE');
    expect(failureCode(decodeRegistryError('0x8baa'))).toBe('RESPONSE_MALFORMED');
    expect(failureCode(decodeRegistryError(undefined))).toBe('RESPONSE_MALFORMED');
  });
});
