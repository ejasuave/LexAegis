import {
  REVIEW_ENGINE_VERSION,
  REVIEW_LIMITS,
  paymentInputSchema,
  paymentReconciliationSchema,
  type PaymentInput,
  type PaymentReconciliationV1,
} from '../contracts/review';

/*
 * One pure GBP arithmetic kernel. Integer pence only, no floating point. A match proves
 * arithmetic consistency of the supplied figures; it says nothing about tax, entitlements,
 * deadlines or whether anything was actually paid.
 */

const MAX_PENCE = 10n ** 18n - 1n;

export type ParsedAmount =
  | { readonly ok: true; readonly pence: bigint }
  | { readonly ok: false; readonly reason: 'negative' | 'invalid' };

/**
 * Parses "10,000", "£10,000.50", "0.5" to pence. Rejects exponents, odd grouping, a currency
 * other than a leading £, more than two fractional digits and values beyond 18 digits of pence.
 */
export function parseGbpAmount(text: string): ParsedAmount {
  const trimmed = text.trim();
  if (trimmed.startsWith('-') || trimmed.startsWith('(')) return { ok: false, reason: 'negative' };
  const body = trimmed.startsWith('£') ? trimmed.slice(1) : trimmed;
  const match = /^(?:(0|[1-9][0-9]*)|([1-9][0-9]{0,2}(?:,[0-9]{3})+))(?:\.([0-9]{1,2}))?$/.exec(
    body,
  );
  if (match === null) return { ok: false, reason: 'invalid' };
  const whole = (match[1] ?? match[2] ?? '0').replaceAll(',', '');
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const pence = BigInt(whole) * 100n + BigInt(fraction);
  return pence > MAX_PENCE ? { ok: false, reason: 'invalid' } : { ok: true, pence };
}

const fmt = (value: bigint): string => value.toString();

function result(
  input: PaymentInput,
  outcome: PaymentReconciliationV1['outcome'],
  parts: Partial<PaymentReconciliationV1>,
): PaymentReconciliationV1 {
  return paymentReconciliationSchema.parse({
    schema: 'lexaegis.payment-reconciliation.v1',
    engineVersion: REVIEW_ENGINE_VERSION,
    mode: input.mode,
    group: input.group,
    outcome,
    currency: 'GBP',
    basis: null,
    statedTotalPence: null,
    includedItems: [],
    comparableSumPence: null,
    differencePence: null,
    formula: 'statedTotal - sum(included instalments)',
    reasons: [],
    incompleteSubtotalPence: null,
    ...parts,
  });
}

/**
 * Reconciles a stated total with a complete instalment schedule. In review mode every input must
 * be confirmed; simulation accepts hypothetical values and never creates confirmations. Results
 * for identical inputs are identical: no timestamps live here.
 */
export function reconcilePayments(rawInput: PaymentInput): PaymentReconciliationV1 {
  const input = paymentInputSchema.parse(rawInput);
  const reasons = new Set<PaymentReconciliationV1['reasons'][number]>();
  const { statedTotal, items } = input;

  // Not comparable: unresolved currency, basis, scope or overlapping items.
  if (items.length > REVIEW_LIMITS.paymentLineItems) reasons.add('too_many_line_items');
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const item of items) {
    if (ids.has(item.lineItemId)) reasons.add('duplicate_line_item');
    ids.add(item.lineItemId);
    if (keys.has(item.sourceKey)) reasons.add('duplicate_source_occurrence');
    keys.add(item.sourceKey);
    if (item.currency !== 'GBP') reasons.add('currency_not_gbp');
  }
  if (statedTotal !== null && statedTotal.currency !== 'GBP') reasons.add('currency_not_gbp');

  const parsedItems = items.map((item) => ({ item, parsed: parseGbpAmount(item.amount) }));
  const parsedTotal = statedTotal === null ? null : parseGbpAmount(statedTotal.amount);
  for (const { parsed } of parsedItems) {
    if (!parsed.ok)
      reasons.add(parsed.reason === 'negative' ? 'negative_amount' : 'amount_invalid');
  }
  if (parsedTotal !== null && !parsedTotal.ok) {
    reasons.add(parsedTotal.reason === 'negative' ? 'negative_amount' : 'amount_invalid');
  }

  const bases = new Set<string | null>([
    ...(statedTotal === null ? [] : [statedTotal.basis]),
    ...items.map((item) => item.basis),
  ]);
  if (statedTotal !== null && items.length > 0) {
    if (bases.has(null)) reasons.add('basis_missing');
    else if (bases.size > 1) reasons.add('basis_mixed');
  }

  const diagnostic = parsedItems.reduce(
    (sum, { parsed }) => (parsed.ok ? sum + parsed.pence : sum),
    0n,
  );
  const base = { incompleteSubtotalPence: items.length > 0 ? fmt(diagnostic) : null };

  if (reasons.size > 0) {
    return result(input, 'not_comparable', { reasons: [...reasons].sort(), ...base });
  }

  // Needs input: absent or unconfirmed (review mode only).
  const missing: PaymentReconciliationV1['reasons'] = [];
  if (statedTotal === null) missing.push('total_missing');
  if (items.length === 0) missing.push('schedule_missing');
  if (
    input.mode === 'review' &&
    ((statedTotal !== null && !statedTotal.confirmed) || items.some((item) => !item.confirmed))
  ) {
    missing.push('fact_unconfirmed');
  }
  if (missing.length > 0) return result(input, 'needs_input', { reasons: missing, ...base });

  const total = (parsedTotal as { ok: true; pence: bigint }).pence;
  const sum = parsedItems.reduce(
    (acc, { parsed }) => acc + (parsed as { pence: bigint }).pence,
    0n,
  );
  const difference = total - sum;
  return result(input, difference === 0n ? 'match' : 'mismatch', {
    basis: (statedTotal as NonNullable<typeof statedTotal>).basis,
    statedTotalPence: fmt(total),
    includedItems: parsedItems.map(({ item, parsed }) => ({
      lineItemId: item.lineItemId,
      amountPence: fmt((parsed as { pence: bigint }).pence),
      factId: item.factId,
    })),
    comparableSumPence: fmt(sum),
    differencePence: fmt(difference),
    incompleteSubtotalPence: null,
  });
}

/** Formats pence as "£22,000.00" for display text (integer arithmetic only). */
export function formatGbp(pence: string): string {
  const negative = pence.startsWith('-');
  const digits = negative ? pence.slice(1) : pence;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}£${whole}.${padded.slice(-2)}`;
}

/** Short form used in finding text: "£2,000" when there are no pence. */
export function formatGbpShort(pence: string): string {
  const full = formatGbp(pence);
  return full.endsWith('.00') ? full.slice(0, -3) : full;
}
