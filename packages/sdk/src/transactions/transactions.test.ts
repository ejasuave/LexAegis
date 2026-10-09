import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  serializeTransaction,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { proofOfReviewRegistryAbi } from '../registry/generated/registry-abi';
import { boundActionOf, registryVectors } from '../registry/test-helpers';
import {
  checkFees,
  DEFAULT_MAX_REGISTRY_FEE_WEI,
  formatMon,
  parseMon,
  registryGasLimit,
} from './fees';
import {
  checkRegistryTransaction,
  decodeRegistryCalldata,
  decodeSignedRegistryTransaction,
  encodeExecuteCalldata,
  encodeInvalidateNonceCalldata,
} from './registry-transaction';

const signer = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const REGISTRY = `0x${'ab'.repeat(20)}`;
const scope = { chainId: 10143, registryAddress: REGISTRY };
const vector = registryVectors.vectors[0];
if (vector === undefined) throw new Error('missing vector');
const bound = boundActionOf(vector);
const SIGNATURE = vector.expected.signature as Hex;
const calldata = encodeExecuteCalldata(bound.action, SIGNATURE) as Hex;

const base = {
  type: 'eip1559' as const,
  chainId: 10143,
  to: REGISTRY as Hex,
  value: 0n,
  data: calldata,
  nonce: 3,
  gas: 200_000n,
  maxFeePerGas: 100_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  accessList: [] as never[],
};

const signRaw = (tx: Record<string, unknown>) =>
  signer.signTransaction(tx as never) as Promise<string>;

describe('fee arithmetic (integers only)', () => {
  it('adds 10% rounded up and rejects, never clips, above 1,000,000', () => {
    expect(registryGasLimit(100_000n)).toEqual({ ok: true, gasLimit: 110_000n });
    expect(registryGasLimit(100_001n)).toEqual({ ok: true, gasLimit: 110_002n });
    expect(registryGasLimit(909_091n)).toEqual({ ok: false, code: 'GAS_LIMIT_TOO_HIGH' });
    expect(registryGasLimit(0n)).toEqual({ ok: false, code: 'ESTIMATE_INVALID' });
  });

  it('enforces the fee ceiling, priority <= max and the balance', () => {
    const fees = { gasLimit: 100_000n, maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1n };
    expect(checkFees(fees, DEFAULT_MAX_REGISTRY_FEE_WEI, 10n ** 18n)).toEqual({
      ok: true,
      maxFeeWei: 10_000_000_000_000_000n,
    });
    expect(checkFees({ ...fees, maxPriorityFeePerGas: 10n ** 12n }, 10n ** 30n)).toMatchObject({
      code: 'FEE_FIELDS_INVALID',
    });
    expect(checkFees({ ...fees, maxFeePerGas: 10n ** 13n }, DEFAULT_MAX_REGISTRY_FEE_WEI)).toEqual({
      ok: false,
      code: 'FEE_CEILING_EXCEEDED',
    });
    expect(checkFees(fees, DEFAULT_MAX_REGISTRY_FEE_WEI, 1n)).toEqual({
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  it('formats and parses MON without floating point', () => {
    expect(formatMon(2n * 10n ** 17n)).toBe('0.2');
    expect(formatMon(10n * 10n ** 18n)).toBe('10');
    expect(formatMon(1n)).toBe('0.000000000000000001');
    expect(parseMon('0.2')).toBe(2n * 10n ** 17n);
    expect(parseMon('0.1234567890123456789')).toBeNull();
    expect(parseMon('1e3')).toBeNull();
  });
});

describe('registry calldata', () => {
  it('round-trips generated execute and invalidateNonce calldata', () => {
    expect(decodeRegistryCalldata(calldata)).toMatchObject({
      kind: 'execute',
      signature: SIGNATURE,
    });
    const invalidate = encodeInvalidateNonceCalldata('7') as Hex;
    expect(decodeRegistryCalldata(invalidate)).toEqual({
      kind: 'invalidate_nonce',
      expectedNonce: '7',
    });
  });

  it('rejects appended bytes, other selectors and noncanonical padding', () => {
    expect(decodeRegistryCalldata(`${calldata}00` as Hex)).toBeNull();
    expect(decodeRegistryCalldata(`${calldata}${'00'.repeat(32)}` as Hex)).toBeNull();
    const other = encodeFunctionData({
      abi: proofOfReviewRegistryAbi,
      functionName: 'nonceOf',
      args: [signer.address],
    });
    expect(decodeRegistryCalldata(other)).toBeNull();
    const invalidate = encodeInvalidateNonceCalldata('7') as Hex;
    expect(decodeRegistryCalldata(`${invalidate}ff` as Hex)).toBeNull();
    expect(
      decodeRegistryCalldata(
        `0x${invalidate.slice(2, 10)}${encodeAbiParameters([{ type: 'uint256' }], [7n]).slice(2)}` as Hex,
      ),
    ).not.toBeNull();
  });
});

describe('transaction scope', () => {
  it('accepts exactly the restricted type-2 registry call', () => {
    expect(checkRegistryTransaction(base, scope)).toMatchObject({ ok: true });
  });

  it.each([
    ['legacy type', { type: 'legacy' }, 'NOT_TYPE_2'],
    ['other chain', { chainId: 143 }, 'WRONG_CHAIN'],
    ['other recipient', { to: `0x${'cd'.repeat(20)}` }, 'WRONG_DESTINATION'],
    ['contract creation', { to: null }, 'WRONG_DESTINATION'],
    ['nonzero value', { value: 1n }, 'NONZERO_VALUE'],
    ['access list', { accessList: [{ address: REGISTRY, storageKeys: [] }] }, 'ACCESS_LIST'],
    ['EIP-7702 list', { authorizationList: [{}] }, 'AUTHORIZATION_LIST'],
    ['other calldata', { data: '0x' }, 'CALLDATA'],
    ['appended calldata', { data: `${calldata}00` }, 'CALLDATA'],
  ])('rejects %s', (_name, patch, reason) => {
    expect(checkRegistryTransaction({ ...base, ...patch }, scope)).toEqual({ ok: false, reason });
  });

  it('decodes a signed transaction, recovers the sender and hashes the raw bytes', async () => {
    const raw = await signRaw(base);
    const decoded = await decodeSignedRegistryTransaction(raw, scope);
    expect(decoded).toMatchObject({ ok: true, sender: signer.address.toLowerCase() });
    if (decoded.ok) expect(decoded.hash).toBe(keccak256(raw as Hex));
  });

  it('rejects oversized, legacy, malformed and EIP-7702 envelopes', async () => {
    expect(await decodeSignedRegistryTransaction('0x', scope)).toMatchObject({ ok: false });
    expect(await decodeSignedRegistryTransaction(`0x02${'00'.repeat(5000)}`, scope)).toEqual({
      ok: false,
      reason: 'TOO_LARGE',
    });
    const legacy = serializeTransaction({
      chainId: 10143,
      to: REGISTRY as Hex,
      nonce: 0,
      gas: 21000n,
      gasPrice: 1n,
    });
    expect(await decodeSignedRegistryTransaction(legacy, scope)).toMatchObject({ ok: false });
    expect(await decodeSignedRegistryTransaction(`0x04c0`, scope)).toMatchObject({ ok: false });
    const wrongTo = await signRaw({ ...base, to: `0x${'cd'.repeat(20)}` });
    expect(await decodeSignedRegistryTransaction(wrongTo, scope)).toEqual({
      ok: false,
      reason: 'WRONG_DESTINATION',
    });
    const withValue = await signRaw({ ...base, value: 5n });
    expect(await decodeSignedRegistryTransaction(withValue, scope)).toEqual({
      ok: false,
      reason: 'NONZERO_VALUE',
    });
  });
});
