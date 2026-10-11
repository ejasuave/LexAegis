/*
 * Pure view model over existing controller state. It owns nothing: every field is read from a
 * controller snapshot and every label is derived from validated observations. Account, backend
 * sign-in, vault, assistant, review completeness, capture, transaction, live receipt lifecycle
 * and indexed history stay separate dimensions; there is deliberately no combined
 * "approved" or "ready" boolean, and nothing here can grant signing authority.
 */

export type ReviewStage =
  | 'working_draft'
  | 'decisions_recorded'
  | 'capture_saving'
  | 'capture_verified'
  | 'action_preview'
  | 'action_signed'
  | 'transaction_preview'
  | 'submission_observed';

export type BlockerCode =
  | 'NO_ACCOUNT'
  | 'SIGNING_LOCKED'
  | 'BACKEND_SIGNED_OUT'
  | 'VAULT_LOCKED'
  | 'NO_MATTER'
  | 'NO_DOCUMENT'
  | 'RESULTS_STALE'
  | 'UNCONFIRMED_FACTS'
  | 'WORKING_UNSAVED'
  | 'TECHNICAL_FAILURE'
  | 'DECISION_REQUIRED'
  | 'CHANGE_REQUIRED'
  | 'DECISIONS_STALE'
  | 'DECISIONS_NOT_RECORDED'
  | 'CAPTURE_MISSING'
  | 'CAPTURE_SAVING'
  | 'CAPTURE_UNVERIFIED'
  | 'CAPTURE_FAILED'
  | 'CHAIN_UNAVAILABLE'
  | 'LIFECYCLE_UNKNOWN';

export interface Blocker {
  readonly code: BlockerCode;
  /** Plain statement for the reviewer. */
  readonly text: string;
  /** Technical failures and integrity problems can never be waived by a human decision. */
  readonly waivable: false;
}

export type NextAction =
  | 'create_or_unlock_account'
  | 'unlock_vault'
  | 'select_matter'
  | 'add_document'
  | 'run_checks'
  | 'confirm_facts'
  | 'save_working_copy'
  | 'record_decisions'
  | 'freeze_package'
  | 'retry_capture'
  | 'verify_capture'
  | 'preview_approval'
  | 'send_transaction'
  | 'refresh_status';

/** A finding as the selector needs it. The reviewer's disposition arrives separately. */
export interface FindingReading {
  readonly findingId: string;
  /** Digest of the exact input and result the finding was computed from. */
  readonly digest: string;
  readonly state: 'ok' | 'attention' | 'needs_input' | 'not_comparable' | 'technical_failure';
  readonly summary: string;
}

export interface DispositionReading {
  readonly findingId: string;
  readonly digest: string;
  readonly kind: 'acknowledged' | 'accepted_unresolved' | 'not_applicable' | 'requires_change';
}

export type CaptureReading =
  | { readonly state: 'none' }
  | { readonly state: 'saving' }
  | { readonly state: 'failed'; readonly code: string }
  | { readonly state: 'saved_unverified' }
  | { readonly state: 'recoverable'; readonly commitment: string };

export type TransactionReading =
  | { readonly stage: 'none' }
  | { readonly stage: 'action_preview' }
  | { readonly stage: 'action_signed' }
  | { readonly stage: 'transaction_preview' }
  | {
      readonly stage: 'submitted';
      readonly outcome:
        | 'sending'
        | 'pending'
        | 'checking_execution'
        | 'confirmed'
        | 'reverted'
        | 'unknown'
        | 'failed'
        | 'cancelled';
    };

export interface WorkspaceInputs {
  readonly account: {
    readonly address: string | null;
    readonly signing: 'locked' | 'unlocked';
    readonly backend: 'unknown' | 'signed_out' | 'signing_in' | 'signed_in' | 'unavailable';
  };
  readonly vault: {
    readonly state:
      'unavailable' | 'locked' | 'unlocking' | 'unlocked' | 'saving' | 'recovering' | 'error';
    readonly selectedMatterId: string | null;
  };
  readonly review: {
    readonly documents: number;
    readonly checks: 'none' | 'running' | 'fresh' | 'stale';
    readonly unresolvedFacts: number;
    readonly save: 'saved' | 'unsaved' | 'saving' | 'error';
    readonly findings: readonly FindingReading[];
  };
  readonly decisions: {
    readonly dispositions: readonly DispositionReading[];
    /** True only after an explicit Record review decisions on the current snapshot. */
    readonly recorded: boolean;
    /** The current snapshot digest is not the one the recorded log was bound to. */
    readonly stale: boolean;
  };
  readonly capture: CaptureReading;
  readonly transaction: TransactionReading;
  readonly lifecycle: {
    readonly status: 'not_checked' | 'unknown' | 'not_found' | 'active' | 'revoked' | 'superseded';
    readonly asOfBlock: string | null;
  };
  readonly chain: 'unavailable' | 'ready' | 'unknown';
  readonly indexer: 'unavailable' | 'catching_up' | 'caught_up' | 'unknown';
  readonly assistant: 'unavailable' | 'idle' | 'running' | 'awaiting_input' | 'stopping';
}

export interface Dimensions {
  readonly account: 'none' | 'locked' | 'unlocked';
  readonly backend: WorkspaceInputs['account']['backend'];
  readonly vault: 'unavailable' | 'locked' | 'working' | 'unlocked' | 'error';
  readonly assistant: WorkspaceInputs['assistant'];
  readonly review: 'empty' | 'stale' | 'in_progress' | 'checks_current';
  readonly capture: CaptureReading['state'];
  readonly transaction: string;
  readonly lifecycle: WorkspaceInputs['lifecycle']['status'];
  readonly indexer: WorkspaceInputs['indexer'];
}

export interface Readiness {
  readonly stage: ReviewStage;
  readonly dimensions: Dimensions;
  readonly blockers: readonly Blocker[];
  /** Findings that still need a human disposition on their current digest. */
  readonly outstandingDecisions: readonly FindingReading[];
  readonly nextActions: readonly NextAction[];
  /**
   * Whether the reviewer may be shown the approval preview. A display permission only: the
   * signing controller independently re-checks every condition and owns the tickets.
   */
  readonly mayPreviewApproval: boolean;
}

const blocker = (code: BlockerCode, text: string): Blocker => ({ code, text, waivable: false });

/** Findings that need a disposition: anything that is not a clean pass and not a technical failure. */
export function needsDisposition(finding: FindingReading): boolean {
  return finding.state !== 'ok' && finding.state !== 'technical_failure';
}

export function outstandingDecisions(
  findings: readonly FindingReading[],
  dispositions: readonly DispositionReading[],
): FindingReading[] {
  return findings.filter(
    (finding) =>
      needsDisposition(finding) &&
      !dispositions.some((d) => d.findingId === finding.findingId && d.digest === finding.digest),
  );
}

export function selectStage(inputs: WorkspaceInputs): ReviewStage {
  const { transaction, capture, decisions } = inputs;
  if (transaction.stage === 'submitted') return 'submission_observed';
  if (transaction.stage === 'transaction_preview') return 'transaction_preview';
  if (transaction.stage === 'action_signed') return 'action_signed';
  if (transaction.stage === 'action_preview') return 'action_preview';
  if (capture.state === 'recoverable') return 'capture_verified';
  if (capture.state === 'saving' || capture.state === 'saved_unverified') return 'capture_saving';
  return decisions.recorded && !decisions.stale ? 'decisions_recorded' : 'working_draft';
}

export function selectReadiness(inputs: WorkspaceInputs): Readiness {
  const blockers: Blocker[] = [];
  const next: NextAction[] = [];
  const { account, vault, review, decisions, capture } = inputs;

  if (account.address === null) {
    blockers.push(blocker('NO_ACCOUNT', 'There is no account in this browser.'));
    next.push('create_or_unlock_account');
  } else if (account.signing === 'locked') {
    blockers.push(blocker('SIGNING_LOCKED', 'The account is locked.'));
    next.push('create_or_unlock_account');
  }
  if (account.address !== null && account.backend !== 'signed_in') {
    blockers.push(blocker('BACKEND_SIGNED_OUT', 'The service has not signed this account in.'));
  }
  if (vault.state !== 'unlocked' && vault.state !== 'saving') {
    blockers.push(blocker('VAULT_LOCKED', 'The vault is not unlocked.'));
    next.push('unlock_vault');
  } else if (vault.selectedMatterId === null) {
    blockers.push(blocker('NO_MATTER', 'No matter is selected.'));
    next.push('select_matter');
  } else if (review.documents === 0) {
    blockers.push(blocker('NO_DOCUMENT', 'No document is selected for review.'));
    next.push('add_document');
  }

  const working = vault.state === 'unlocked' || vault.state === 'saving';
  if (working && vault.selectedMatterId !== null && review.documents > 0) {
    if (review.checks === 'stale' || review.checks === 'none') {
      blockers.push(blocker('RESULTS_STALE', 'The checks are missing or out of date.'));
      next.push('run_checks');
    }
    if (review.unresolvedFacts > 0) {
      blockers.push(
        blocker(
          'UNCONFIRMED_FACTS',
          `${review.unresolvedFacts} fact(s) still need your confirmation.`,
        ),
      );
      next.push('confirm_facts');
    }
    if (review.save !== 'saved') {
      blockers.push(blocker('WORKING_UNSAVED', 'The working copy has unsaved changes.'));
      next.push('save_working_copy');
    }
  }

  const technical = review.findings.filter((f) => f.state === 'technical_failure');
  for (const finding of technical) {
    blockers.push(
      blocker('TECHNICAL_FAILURE', `Integrity problem, cannot be waived: ${finding.summary}`),
    );
  }
  const outstanding = outstandingDecisions(review.findings, decisions.dispositions);
  if (outstanding.length > 0) {
    blockers.push(
      blocker('DECISION_REQUIRED', `${outstanding.length} finding(s) need your decision.`),
    );
    next.push('record_decisions');
  } else if (decisions.dispositions.some((d) => d.kind === 'requires_change')) {
    blockers.push(blocker('CHANGE_REQUIRED', 'You marked a finding as requiring a change.'));
  } else if (decisions.stale) {
    blockers.push(blocker('DECISIONS_STALE', 'Inputs changed after decisions were recorded.'));
    next.push('record_decisions');
  } else if (!decisions.recorded && review.checks === 'fresh') {
    blockers.push(blocker('DECISIONS_NOT_RECORDED', 'Review decisions have not been recorded.'));
    next.push('record_decisions');
  }

  switch (capture.state) {
    case 'none':
      blockers.push(blocker('CAPTURE_MISSING', 'The review package has not been frozen.'));
      break;
    case 'saving':
      blockers.push(blocker('CAPTURE_SAVING', 'The frozen package is still being saved.'));
      break;
    case 'failed':
      blockers.push(blocker('CAPTURE_FAILED', `The package could not be saved (${capture.code}).`));
      next.push('retry_capture');
      break;
    case 'saved_unverified':
      blockers.push(
        blocker('CAPTURE_UNVERIFIED', 'The saved package has not been read back in this unlock.'),
      );
      next.push('verify_capture');
      break;
    case 'recoverable':
      break;
  }
  if (inputs.chain !== 'ready') {
    blockers.push(blocker('CHAIN_UNAVAILABLE', 'Live network state is not available.'));
  }
  if (inputs.lifecycle.status === 'unknown') {
    blockers.push(blocker('LIFECYCLE_UNKNOWN', 'The live receipt state could not be read.'));
    next.push('refresh_status');
  }

  // Freezing is offered once decisions are recorded, but only while nothing else blocks.
  const canFreeze =
    capture.state === 'none' &&
    decisions.recorded &&
    !decisions.stale &&
    blockers.every((b) => b.code === 'CAPTURE_MISSING' || b.code === 'CHAIN_UNAVAILABLE');
  if (canFreeze) next.push('freeze_package');

  const mayPreviewApproval = blockers.length === 0 && capture.state === 'recoverable';
  if (mayPreviewApproval) next.push('preview_approval');
  if (inputs.transaction.stage === 'transaction_preview') next.push('send_transaction');

  const dimensions: Dimensions = {
    account:
      account.address === null ? 'none' : account.signing === 'unlocked' ? 'unlocked' : 'locked',
    backend: account.backend,
    vault:
      vault.state === 'unlocked'
        ? 'unlocked'
        : vault.state === 'locked'
          ? 'locked'
          : vault.state === 'unavailable'
            ? 'unavailable'
            : vault.state === 'error'
              ? 'error'
              : 'working',
    assistant: inputs.assistant,
    review:
      review.documents === 0
        ? 'empty'
        : review.checks === 'fresh'
          ? 'checks_current'
          : review.checks === 'stale'
            ? 'stale'
            : 'in_progress',
    capture: capture.state,
    transaction:
      inputs.transaction.stage === 'submitted'
        ? inputs.transaction.outcome
        : inputs.transaction.stage,
    lifecycle: inputs.lifecycle.status,
    indexer: inputs.indexer,
  };

  return Object.freeze({
    stage: selectStage(inputs),
    dimensions: Object.freeze(dimensions),
    blockers: Object.freeze(blockers),
    outstandingDecisions: Object.freeze(outstanding),
    nextActions: Object.freeze([...new Set(next)]),
    mayPreviewApproval,
  });
}

/** Why a view-level action is disabled, from the same readiness. Null when it is available. */
export function disabledReason(readiness: Readiness, action: NextAction): string | null {
  return readiness.nextActions.includes(action)
    ? null
    : (readiness.blockers[0]?.text ?? 'Not available in the current state.');
}
