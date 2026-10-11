/*
 * Integer-only fee arithmetic for Monad testnet. Monad charges by gas LIMIT, not gas used, so the
 * limit is kept tight and no unused-gas refund is ever assumed.
 */

export const MON_DECIMALS = 18;
const WEI_PER_MON = 10n ** 18n;

export const REGISTRY_GAS_LIMIT_CEILING = 1_000_000n;
/** Default maximum total fee for one registry transaction: 0.2 MON. */
export const DEFAULT_MAX_REGISTRY_FEE_WEI = 2n * 10n ** 17n;
/** Default maximum fee for one funding transfer: 0.01 MON. */
export const DEFAULT_MAX_FUNDING_FEE_WEI = 10n ** 16n;

export type GasLimitResult =
  | { readonly ok: true; readonly gasLimit: bigint }
  | { readonly ok: false; readonly code: 'ESTIMATE_INVALID' | 'GAS_LIMIT_TOO_HIGH' };

/**
 * gasLimit = ceil(estimatedGas * 110 / 100); a result above the ceiling is rejected, never clipped.
 *
 * @example
 * ```ts
 * import { registryGasLimit } from '@lexaegis/sdk/transactions';
 *
 * const limit = registryGasLimit(120_000n); // { ok: true, gasLimit: 132000n }
 * ```
 */
export function registryGasLimit(
  estimatedGas: bigint,
  ceiling: bigint = REGISTRY_GAS_LIMIT_CEILING,
): GasLimitResult {
  if (estimatedGas <= 0n) return { ok: false, code: 'ESTIMATE_INVALID' };
  const gasLimit = (estimatedGas * 110n + 99n) / 100n;
  return gasLimit > ceiling ? { ok: false, code: 'GAS_LIMIT_TOO_HIGH' } : { ok: true, gasLimit };
}

export interface FeeInputs {
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export type FeeCheck =
  | { readonly ok: true; readonly maxFeeWei: bigint }
  | {
      readonly ok: false;
      readonly code: 'FEE_FIELDS_INVALID' | 'FEE_CEILING_EXCEEDED' | 'INSUFFICIENT_BALANCE';
    };

/**
 * Validates the fee ceiling and, when a balance is supplied, that gasLimit * maxFeePerGas is covered.
 *
 * @example
 * ```ts
 * import { DEFAULT_MAX_REGISTRY_FEE_WEI, checkFees } from '@lexaegis/sdk/transactions';
 *
 * const check = checkFees(
 *   { gasLimit: 132_000n, maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
 *   DEFAULT_MAX_REGISTRY_FEE_WEI,
 * );
 * ```
 */
export function checkFees(
  fees: FeeInputs,
  ceilingWei: bigint,
  balanceWei?: bigint,
  valueWei = 0n,
): FeeCheck {
  if (fees.gasLimit <= 0n || fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n) {
    return { ok: false, code: 'FEE_FIELDS_INVALID' };
  }
  if (fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
    return { ok: false, code: 'FEE_FIELDS_INVALID' };
  }
  const maxFeeWei = fees.gasLimit * fees.maxFeePerGas;
  if (maxFeeWei > ceilingWei) return { ok: false, code: 'FEE_CEILING_EXCEEDED' };
  if (balanceWei !== undefined && balanceWei < maxFeeWei + valueWei) {
    return { ok: false, code: 'INSUFFICIENT_BALANCE' };
  }
  return { ok: true, maxFeeWei };
}

/** Expected fee: the limit times the price the network is expected to charge. */
export const expectedFeeWei = (gasLimit: bigint, effectiveGasPrice: bigint): bigint =>
  gasLimit * effectiveGasPrice;

/** The fee Monad actually charged: gas LIMIT times the effective gas price. */
export const monadChargedFeeWei = (gasLimit: bigint, effectiveGasPrice: bigint): bigint =>
  gasLimit * effectiveGasPrice;

/**
 * Exact decimal MON text for a wei amount, trimmed of trailing zeros.
 *
 * @example
 * ```ts
 * import { formatMon } from '@lexaegis/sdk/transactions';
 *
 * console.log(formatMon(200_000_000_000_000_000n)); // "0.2"
 * ```
 */
export function formatMon(wei: bigint): string {
  if (wei < 0n) throw new RangeError('negative amount');
  const whole = wei / WEI_PER_MON;
  const fraction = (wei % WEI_PER_MON).toString().padStart(MON_DECIMALS, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/**
 * Parses a decimal MON string such as "0.2" to wei. Returns null for anything inexact.
 *
 * @example
 * ```ts
 * import { parseMon } from '@lexaegis/sdk/transactions';
 *
 * console.log(parseMon('0.2')); // 200000000000000000n
 * ```
 */
export function parseMon(text: string): bigint | null {
  const match = /^(0|[1-9][0-9]{0,15})(?:\.([0-9]{1,18}))?$/.exec(text);
  if (match === null) return null;
  const fraction = (match[2] ?? '').padEnd(MON_DECIMALS, '0');
  return BigInt(match[1] ?? '0') * WEI_PER_MON + BigInt(fraction);
}
