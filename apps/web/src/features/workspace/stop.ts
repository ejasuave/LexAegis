/*
 * One Stop for everything that can still be stopped, with each part keeping its own
 * acknowledgement. Stop never submits a transaction, nonce invalidation or revocation, and it
 * never claims to reverse something already sent or disclosed. The assistant's "Stopping" becomes
 * "Cancelled" only when its runtime acknowledges it; this report only says what was requested.
 */

export interface StopPorts {
  assistant?: { active(): boolean; stop(): void };
  voice?: { active(): boolean; abort(): void };
  readAloud?: { active(): boolean; cancel(): void };
  approval?: {
    stage(): 'idle' | 'checking' | 'preview' | 'signing' | 'signed' | 'failed';
    cancelPreview(): void;
  };
  transaction?: {
    state(): { stage: string; mayHaveBroadcast: boolean };
    cancel(): void;
  };
}

export interface StopReport {
  readonly assistant: 'stop_requested' | 'idle';
  readonly voice: 'aborted' | 'idle';
  readonly readAloud: 'cancelled' | 'idle';
  readonly approvalPreview:
    'discarded' | 'signing_cannot_be_stopped' | 'signed_signature_kept' | 'none';
  readonly transaction: 'unsent_cancelled' | 'already_sent' | 'none';
  readonly notes: readonly string[];
}

const IDLE_TX = new Set(['idle', 'cancelled', 'failed', 'confirmed', 'reverted']);

export function stopAll(ports: StopPorts): StopReport {
  const notes: string[] = [];

  const assistant = ports.assistant?.active() === true ? 'stop_requested' : 'idle';
  if (assistant === 'stop_requested') ports.assistant?.stop();

  const voice = ports.voice?.active() === true ? 'aborted' : 'idle';
  if (voice === 'aborted') ports.voice?.abort();

  const readAloud = ports.readAloud?.active() === true ? 'cancelled' : 'idle';
  if (readAloud === 'cancelled') ports.readAloud?.cancel();

  let approvalPreview: StopReport['approvalPreview'] = 'none';
  const stage = ports.approval?.stage() ?? 'idle';
  if (stage === 'preview' || stage === 'checking') {
    ports.approval?.cancelPreview();
    approvalPreview = 'discarded';
  } else if (stage === 'signing') {
    approvalPreview = 'signing_cannot_be_stopped';
    notes.push('Signing was already under way and cannot be stopped; check the result.');
  } else if (stage === 'signed') {
    approvalPreview = 'signed_signature_kept';
  }

  let transaction: StopReport['transaction'] = 'none';
  const tx = ports.transaction?.state();
  if (tx !== undefined && !IDLE_TX.has(tx.stage)) {
    if (tx.mayHaveBroadcast) {
      transaction = 'already_sent';
      notes.push(
        'A transaction may already have been sent. Stop cannot cancel or reverse it; refresh its status. The approval signature stays usable until its deadline.',
      );
    } else {
      // Unused tickets die and unsent work ends. Nothing is sent, replaced or invalidated.
      ports.transaction?.cancel();
      transaction = 'unsent_cancelled';
      notes.push(
        'The transaction was not sent. If the approval signature was already disclosed it can still be used until its deadline; Cancel outstanding authorisation is a separate fee-paying action.',
      );
    }
  }
  return { assistant, voice, readAloud, approvalPreview, transaction, notes };
}

/** True while at least one part has something that Stop could end. */
export function anythingToStop(ports: StopPorts): boolean {
  const stage = ports.approval?.stage() ?? 'idle';
  const tx = ports.transaction?.state();
  return (
    ports.assistant?.active() === true ||
    ports.voice?.active() === true ||
    ports.readAloud?.active() === true ||
    stage === 'preview' ||
    stage === 'checking' ||
    (tx !== undefined && !IDLE_TX.has(tx.stage) && !tx.mayHaveBroadcast)
  );
}
