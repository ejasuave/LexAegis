import { INDEXER_STALE_MS, RUN_EVENT_STALE_MS, ageText, freshnessOf } from './hud.freshness';
import type {
  AccountInput,
  ActivityView,
  AssistantInput,
  AttentionView,
  CeilingInput,
  Connection,
  FindingInput,
  HudInput,
  HudView,
  IndexerInput,
  Reading,
  TransactionStageInput,
} from './hud.types';

/*
 * Pure mapping from controller snapshots to what the HUD shows. The DOM and the canvas both read
 * the one HudView, so a colour can never contradict its label. Nothing here advances business
 * state, and every reading comes from its own input: no field is derived from another concern.
 */

const MAX_HIGHLIGHTED = 3;

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function utcTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

function matterReading(input: CeilingInput): Reading {
  const versions = input.selectedVersionIds;
  const text =
    input.matterTitle === null
      ? 'None selected'
      : `${input.matterTitle}, ${
          versions.length === 0
            ? 'no document selected'
            : versions.length === 1
              ? `version ${versions[0]?.slice(0, 8) ?? ''}`
              : `${String(versions.length)} versions`
        }`;
  return { id: 'matter', label: 'Matter', text, tone: 'muted', fullValue: null };
}

function networkReading(input: CeilingInput): Reading {
  // The configured label states the network, such as "Monad Testnet (10143)". Nothing here
  // ever implies mainnet or production assurance.
  return {
    id: 'network',
    label: 'Network',
    text: input.chainId === null ? 'Not configured' : input.networkLabel,
    tone: input.chainId === null ? 'warn' : 'muted',
    fullValue: null,
  };
}

export function indexerReading(indexer: IndexerInput | null, nowMs: number): Reading {
  const base = { id: 'indexer', label: 'Envio indexing', fullValue: null } as const;
  if (indexer === null) return { ...base, text: 'Not checked', tone: 'muted' };
  const fresh = freshnessOf(indexer.observedAtMs, nowMs, INDEXER_STALE_MS);
  const updated =
    indexer.observedAtMs === null
      ? 'never updated'
      : `updated ${ageText(indexer.observedAtMs, nowMs)}`;
  if (indexer.availability === 'unavailable') {
    const word =
      indexer.indexConsistency === 'recovering'
        ? 'Recovering'
        : indexer.indexConsistency === 'inconsistent'
          ? 'Inconsistent'
          : 'Unavailable';
    return {
      ...base,
      text: `${word}; last ${updated}`,
      tone: word === 'Recovering' ? 'warn' : 'bad',
    };
  }
  const block = indexer.indexedBlock === null ? 'block unknown' : `block ${indexer.indexedBlock}`;
  // Incomparable or missing heads are "lag unknown", never zero.
  const lag = indexer.confirmedLag ?? indexer.sourceLag;
  const lagText = lag === null ? 'lag unknown' : `${lag} behind`;
  const state =
    fresh === 'stale'
      ? 'Stale'
      : indexer.freshness === 'caught_up' && lag !== null
        ? 'Caught up'
        : indexer.freshness === 'catching_up'
          ? 'Catching up'
          : 'Coverage unknown';
  return {
    ...base,
    text: `${state}, ${block}, ${lagText}, ${updated}`,
    tone:
      fresh === 'stale' || state === 'Coverage unknown'
        ? 'warn'
        : state === 'Caught up'
          ? 'ok'
          : 'warn',
  };
}

export function meraSessionReading(account: AccountInput, nowMs: number): Reading {
  const base = { id: 'mera-session', label: 'Mera session', fullValue: null } as const;
  if (account.availability === 'loading') return { ...base, text: 'Checking', tone: 'muted' };
  if (account.availability === 'unsupported') {
    return { ...base, text: 'Unsupported in this browser', tone: 'bad' };
  }
  if (account.availability === 'misconfigured')
    return { ...base, text: 'Unavailable', tone: 'bad' };
  if (account.ceremony === 'awaiting_passkey')
    return { ...base, text: 'Awaiting passkey', tone: 'warn' };
  if (account.address === null) return { ...base, text: 'No account', tone: 'muted' };
  if (account.signing === 'unlocked') {
    const expires = account.signingExpiresAtMs;
    if (expires !== null && expires <= nowMs) return { ...base, text: 'Expired', tone: 'warn' };
    return {
      ...base,
      text: expires === null ? 'Authenticated' : `Authenticated until ${utcTime(expires)}`,
      tone: 'ok',
    };
  }
  return account.lastEvent === 'signing_expired'
    ? { ...base, text: 'Expired', tone: 'warn' }
    : { ...base, text: 'Locked', tone: 'muted' };
}

function publicAccountReading(account: AccountInput): Reading {
  const base = { id: 'public-account', label: 'Public account' } as const;
  return account.address === null
    ? { ...base, text: 'None', tone: 'muted', fullValue: null }
    : { ...base, text: shortAddress(account.address), tone: 'muted', fullValue: account.address };
}

function vaultReading(label: string): Reading {
  const tone: Reading['tone'] =
    label === 'Saved' || label === 'Unlocked'
      ? 'ok'
      : label === 'Locked'
        ? 'muted'
        : label === 'Vault unavailable' || label === 'Recovery failed' || label === 'Conflict'
          ? 'bad'
          : 'warn';
  return { id: 'vault', label: 'Vault', text: label, tone, fullValue: null };
}

const TRANSACTION_TEXT: Record<TransactionStageInput, string> = {
  idle: 'None',
  checking_network: 'Checking network',
  awaiting_confirmation: 'Awaiting your Send confirmation',
  signing: 'Awaiting signature',
  sending: 'Broadcasting',
  pending: 'Pending',
  checking_execution: 'Checking execution',
  confirmed: 'Confirmed',
  reverted: 'Reverted',
  unknown: 'Status unknown',
  failed: 'Not sent',
  cancelled: 'Cancelled',
};

export function transactionReading(
  stage: TransactionStageInput,
  mayHaveBroadcast: boolean,
): Reading {
  const uncertain =
    (stage === 'unknown' || stage === 'failed' || stage === 'cancelled') && mayHaveBroadcast;
  const tone: Reading['tone'] =
    stage === 'confirmed'
      ? 'ok'
      : stage === 'reverted' || stage === 'failed'
        ? 'bad'
        : stage === 'idle' || stage === 'cancelled'
          ? 'muted'
          : 'warn';
  return {
    id: 'transaction',
    label: 'Transaction',
    text: `${TRANSACTION_TEXT[stage]}${uncertain ? ', may have been broadcast' : ''}`,
    tone,
    fullValue: null,
  };
}

function serverSignInReading(account: AccountInput): Reading {
  return {
    id: 'server-sign-in',
    label: 'Server sign-in',
    text:
      account.backend === 'signed_in'
        ? 'Signed in'
        : account.backend === 'signing_in'
          ? 'Signing in'
          : account.backend === 'unavailable'
            ? 'Unavailable'
            : 'Not signed in',
    tone: account.backend === 'unavailable' ? 'bad' : 'muted',
    fullValue: null,
  };
}

/** Seven separate readings; the order is the order of the ceiling. */
export function selectCeiling(input: CeilingInput): readonly Reading[] {
  return [
    matterReading(input),
    networkReading(input),
    indexerReading(input.indexer, input.nowMs),
    meraSessionReading(input.account, input.nowMs),
    publicAccountReading(input.account),
    vaultReading(input.vaultLabel),
    transactionReading(input.transaction.stage, input.transaction.mayHaveBroadcast),
    serverSignInReading(input.account),
  ];
}

function connectionOf(assistant: AssistantInput, nowMs: number): Connection {
  if (assistant.availability === 'unreachable') return 'offline';
  const run = assistant.activeRun;
  if (run !== null && (run.state === 'running' || run.state === 'queued')) {
    const fresh = freshnessOf(run.lastEventAtMs, nowMs, RUN_EVENT_STALE_MS);
    if (fresh === 'stale') return 'stale';
    if (fresh === 'unknown') return 'unknown';
  }
  return assistant.availability === 'ready' ? 'live' : 'unknown';
}

/** Activity is the assistant's own state. It never reads transaction, vault or finding state. */
export function selectActivity(assistant: AssistantInput, nowMs: number): ActivityView {
  const run = assistant.activeRun;
  const connection = connectionOf(assistant, nowMs);
  const steps = {
    stepsCompleted: run?.stepsCompleted ?? 0,
    stepsTotal: run?.stepsTotal ?? null,
  };
  const view = (
    state: ActivityView['state'],
    statusText: string,
    toolsRunning = false,
  ): ActivityView => ({ state, statusText, toolsRunning, connection, ...steps });

  if (assistant.availability === 'unreachable') {
    return view('offline', 'The assistant service could not be reached. Local checks still work.');
  }
  if (assistant.phase === 'stopping')
    return view(
      'stopping',
      'Stopping. The request was sent; the service has not yet acknowledged it.',
    );
  if (assistant.phase === 'running' && run !== null) {
    if (connection === 'stale' || connection === 'unknown') {
      return view(
        'stale',
        run.lastEventAtMs === null
          ? 'No update has arrived for this run, so its activity cannot be confirmed.'
          : 'Last update was too long ago to confirm this run is still working.',
      );
    }
    const progress =
      run.stepsTotal === null
        ? ''
        : `, step ${String(Math.min(run.stepsCompleted + 1, run.stepsTotal))} of ${String(run.stepsTotal)}`;
    return view(
      'running',
      `Running ${run.operation}${progress}.`,
      run.toolsStarted > run.toolsFinished,
    );
  }
  if (assistant.phase === 'preview') {
    return view('awaiting_user', 'Waiting for you to review what would be sent.');
  }
  switch (assistant.orb) {
    case 'queued':
      return view('queued', 'Queued.');
    case 'awaiting_input':
      return view('awaiting_user', 'Needs your input.');
    case 'completed':
      return view(
        'completed',
        `Finished ${run?.operation ?? 'the request'}. This approves nothing.`,
      );
    case 'cancelled':
      return view('cancelled', 'Cancelled.');
    case 'failed':
      return view('failed', run?.failureMessage ?? 'The run failed.');
    case 'interrupted':
      return view('interrupted', 'Interrupted: the outcome is not known.');
    case 'stopping':
      return view('stopping', 'Stopping.');
    case 'running':
      // The controller's reading says running but no active run is held: do not claim work.
      return view('stale', 'The run state cannot be confirmed.');
    case 'unavailable':
      return view(
        'unavailable',
        assistant.availability === 'signed_out'
          ? 'Sign in to use the assistant. Local checks still work.'
          : 'The assistant is unavailable. Local checks still work.',
      );
    case 'ready':
      return view('idle', 'Ready.');
  }
}

const SEVERITY: Record<FindingInput['state'], 'alert' | 'failure' | 'input' | null> = {
  ok: null,
  not_comparable: null,
  attention: 'alert',
  technical_failure: 'failure',
  needs_input: 'input',
};
const PRIORITY = { failure: 0, alert: 1, input: 2 } as const;

/** Which findings the canvas may draw to. Every finding stays in the DOM list regardless. */
export function selectAttention(findings: readonly FindingInput[]): AttentionView {
  const severityById: Record<string, 'alert' | 'failure' | 'input'> = {};
  const unresolved: { f: FindingInput; severity: 'alert' | 'failure' | 'input' }[] = [];
  for (const f of findings) {
    const severity = SEVERITY[f.state];
    if (severity === null || f.resolved) continue;
    severityById[f.id] = severity;
    unresolved.push({ f, severity });
  }
  const visible = unresolved
    .filter(({ f }) => f.visible)
    .sort(
      (a, b) =>
        Number(b.f.selected) - Number(a.f.selected) || PRIORITY[a.severity] - PRIORITY[b.severity],
    );
  return {
    unresolvedCount: unresolved.length,
    blocking: unresolved.some(({ severity }) => severity === 'failure' || severity === 'input'),
    highlighted: visible.slice(0, MAX_HIGHLIGHTED).map(({ f }) => f.id),
    offscreenUnresolved: unresolved.filter(({ f }) => !f.visible).length,
    severityById,
  };
}

export function selectHud(input: HudInput): HudView {
  return {
    readings: selectCeiling(input.ceiling),
    activity: selectActivity(input.assistant, input.ceiling.nowMs),
    attention: input.vaultUnlocked ? selectAttention(input.findings) : selectAttention([]),
    clearPrivateAnchors: !input.vaultUnlocked,
    workspaceEmpty: !input.matterSelected,
  };
}

// ---- Notices for the non-happy paths ---------------------------------------------------------

export interface Notice {
  readonly id: string;
  readonly severity: 'info' | 'warn' | 'bad';
  readonly title: string;
  readonly body: string;
  /** A recovery the reviewer may take. Never a retry of signing or sending. */
  readonly action: { readonly label: string; readonly href: string } | null;
}

export interface NoticeExtras {
  /** The transaction controller's own reason code, when it has one. */
  readonly transactionReason: string | null;
  /** A confirmation was withdrawn after being shown. */
  readonly receiptCorrection: boolean;
}

const VAULT_PAGE = { label: 'Open the Vault page', href: '/vault' } as const;

/**
 * Every failure and degraded state the blueprint names, as plain sentences with what is and is
 * not affected. None of them retries, signs or sends, and none claims a lock retracts data that
 * was already sent.
 */
export function selectNotices(input: HudInput, extras: NoticeExtras): readonly Notice[] {
  const { ceiling, assistant } = input;
  const out: Notice[] = [];
  const add = (notice: Notice) => out.push(notice);
  const account = ceiling.account;

  if (account.availability === 'unsupported') {
    add({
      id: 'passkey-unsupported',
      severity: 'bad',
      title: 'Passkeys are not supported in this browser',
      body: 'Reviewing documents still works, but an account, the vault and approvals need passkey support with the PRF extension. Use a browser and device that offer it.',
      action: null,
    });
  } else if (account.availability === 'misconfigured') {
    add({
      id: 'account-unavailable',
      severity: 'bad',
      title: 'The account is not configured for this deployment',
      body: 'Accounts, the vault and approvals are unavailable. Local checks still work.',
      action: null,
    });
  }
  const mera = meraSessionReading(account, ceiling.nowMs);
  if (mera.text === 'Expired') {
    add({
      id: 'session-expired',
      severity: 'warn',
      title: 'Your passkey session expired',
      body: 'Nothing was approved or signed by this. Unlock again to continue; saved work stays encrypted.',
      action: VAULT_PAGE,
    });
  }

  switch (ceiling.vaultLabel) {
    case 'Locked':
      if (account.address !== null) {
        add({
          id: 'vault-locked',
          severity: 'info',
          title: 'The vault is locked',
          body: 'Decrypted text, drafts and private markers are cleared from view. Locking cannot retract anything already sent to the service or to the model provider.',
          action: VAULT_PAGE,
        });
      }
      break;
    case 'Unsaved changes':
      add({
        id: 'vault-unsaved',
        severity: 'warn',
        title: 'Changes are not saved yet',
        body: 'They exist only in this tab until the encrypted save is read back successfully.',
        action: null,
      });
      break;
    case 'Conflict':
      add({
        id: 'vault-conflict',
        severity: 'bad',
        title: 'The saved copy changed elsewhere',
        body: 'Your last save was not applied. Review the saved version before saving again.',
        action: VAULT_PAGE,
      });
      break;
    case 'Recovery failed':
      add({
        id: 'vault-recovery',
        severity: 'bad',
        title: 'The saved package could not be read back',
        body: 'Nothing was approved. A package that has not been read back cannot be used for approval.',
        action: VAULT_PAGE,
      });
      break;
    case 'Vault unavailable':
      add({
        id: 'vault-unavailable',
        severity: 'bad',
        title: 'The encrypted vault is not available',
        body: 'Matters cannot be opened or saved in this browser.',
        action: null,
      });
      break;
    default:
      break;
  }

  const run = assistant.activeRun;
  if (assistant.availability === 'unreachable') {
    add({
      id: 'assistant-offline',
      severity: 'warn',
      title: 'The assistant service could not be reached',
      body: 'Local checks still work. Nothing is resent automatically when it returns.',
      action: null,
    });
  }
  if (assistant.orb === 'failed' && run !== null) {
    const budget = run.failureCode === 'BUDGET_EXHAUSTED' || run.failureCode === 'TOOL_LIMIT';
    add({
      id: 'run-failed',
      severity: 'bad',
      title: budget ? 'The analysis budget for this run is used up' : 'The run failed',
      body: budget
        ? 'No further analysis was run. Start a new request if you still need it; checks you run locally are unaffected.'
        : (run.failureMessage ?? 'The run failed. Nothing was approved.'),
      action: null,
    });
  }
  if (assistant.orb === 'cancelled') {
    add({
      id: 'run-cancelled',
      severity: 'info',
      title: 'The run was cancelled',
      body: 'Cancelling does not reverse anything that was already sent or broadcast.',
      action: null,
    });
  }
  if (assistant.orb === 'interrupted') {
    add({
      id: 'run-interrupted',
      severity: 'warn',
      title: 'The run was interrupted and its outcome is not known',
      body: 'Do not treat any partial result as complete. Start a new request when ready.',
      action: null,
    });
  }

  const indexer = indexerReading(ceiling.indexer, ceiling.nowMs);
  if (ceiling.indexer !== null && (indexer.tone === 'warn' || indexer.tone === 'bad')) {
    add({
      id: 'indexer-lag',
      severity: 'warn',
      title: 'Receipt history may be behind',
      body: 'The index is stale, catching up or unavailable. A live registry read decides a receipt’s state, not this list.',
      action: null,
    });
  }

  const tx = ceiling.transaction;
  if (tx.stage === 'reverted') {
    add({
      id: 'tx-reverted',
      severity: 'bad',
      title: 'The transaction reverted',
      body: 'The registry rejected it on chain, so nothing was published. Nothing is retried for you.',
      action: null,
    });
  } else if (tx.stage === 'unknown') {
    add({
      id: 'tx-unknown',
      severity: 'warn',
      title: 'The transaction’s status is not known',
      body: tx.mayHaveBroadcast
        ? 'It may have been broadcast. Refresh its status and do not send it again until you know.'
        : 'Refresh its status. Nothing is resent automatically.',
      action: null,
    });
  } else if (tx.stage === 'failed' && extras.transactionReason !== null) {
    const rejected =
      extras.transactionReason === 'USER_CANCELLED' ||
      extras.transactionReason === 'SIGNING_FAILED';
    add({
      id: 'tx-not-sent',
      severity: 'warn',
      title: rejected ? 'Signing was not completed' : 'The transaction was not sent',
      body: 'Nothing was broadcast. You decide whether to try again; the app will not.',
      action: null,
    });
  }
  if (extras.receiptCorrection) {
    add({
      id: 'receipt-correction',
      severity: 'warn',
      title: 'A confirmation was withdrawn',
      body: 'The earlier “receipt confirmed” no longer holds. Its status is being checked again.',
      action: null,
    });
  }
  return out;
}
