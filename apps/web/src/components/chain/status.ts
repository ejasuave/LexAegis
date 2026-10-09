import { formatMon } from '@lexaegis/sdk/transactions';
import type { TransactionStage } from '@/features/transactions/public';

/** One honest status line, driven only by real controller events. */
export const STAGE_LABEL: Record<TransactionStage, string> = {
  idle: 'No transaction',
  checking_network: 'Checking network',
  awaiting_confirmation: 'Awaiting confirmation',
  signing: 'Signing',
  sending: 'Sending',
  pending: 'Pending',
  checking_execution: 'Checking execution',
  confirmed: 'Confirmed',
  reverted: 'Reverted',
  unknown: 'Status unknown',
  failed: 'Not sent',
  cancelled: 'Cancelled',
};

export function monText(wei: string | null): string {
  if (wei === null || !/^[0-9]+$/.test(wei)) return 'unknown';
  return `${formatMon(BigInt(wei))} MON`;
}

export interface FundingView {
  readonly status: string;
  readonly transactionHash?: string;
  readonly retryAfter?: string;
}

const FUNDING_TEXT: Record<string, string> = {
  confirmed: 'Test MON arrived.',
  pending: 'Funding sent. Waiting for the network to execute it.',
  unavailable: 'Funding is unavailable. Use the official faucet.',
  disabled: 'Funding from this app is switched off. Use the official faucet.',
  already_funded: 'This account already has enough test MON.',
  cooldown: 'One grant per address every 24 hours. Use the official faucet meanwhile.',
  budget_exhausted: 'Today’s funding budget is used up. Use the official faucet.',
  funder_low: 'The funding account is low. Use the official faucet.',
  account_delegated: 'This account has code or a delegation, so it cannot be funded here.',
  failed: 'The funding transfer failed. Nothing arrived.',
  unknown: 'The funding outcome is not known yet. Retry status.',
};
export const fundingText = (status: string): string =>
  FUNDING_TEXT[status] ?? 'Funding status is not known.';

export function explorerAddressUrl(base: string, address: string): string {
  return `${base}/address/${address}`;
}
export function explorerTxUrl(base: string, hash: string): string {
  return `${base}/tx/${hash}`;
}
