import { BoundedIdentitySet } from './hud.events';
import { EnvelopeLimiter, type EffectsMode } from './hud.effects';

/*
 * Interaction feedback that is derived, never invented. Loading is a view of work a controller
 * really reports as pending; positive feedback is a view of an event a controller really
 * validated. Both are pure: they read plain inputs and an explicit clock, hold no business state
 * and own no timer, so the thresholds and the dedupe rules can be tested directly.
 */

// ---- Loading ----------------------------------------------------------------------------------

/** Work faster than this shows nothing. */
export const LOADING_SHOW_AFTER_MS = 150;
/** Once shown, the loading state stays at least this long, so it cannot flicker. */
export const LOADING_MIN_VISIBLE_MS = 300;
/** Wording such as "still working" appears only after this much real elapsed time. */
export const LOADING_STILL_WORKING_MS = 8000;

export type BusyRegion =
  'vault' | 'account' | 'document' | 'analysis' | 'save' | 'transaction' | 'assistant' | 'index';

/** One operation a controller reports as in flight right now. */
export interface PendingWork {
  /** Stable for the life of one operation; a different operation is a different key. */
  readonly key: string;
  /** Which part of the screen the work belongs to, so the right region shows the skeleton. */
  readonly region: BusyRegion;
  /** One plain sentence naming the actual operation. */
  readonly sentence: string;
  /** Present only when the controller knows the real total. */
  readonly step: { readonly done: number; readonly total: number } | null;
  /** Whether Stop reaches this work. */
  readonly cancellable: boolean;
}

export interface PendingInput {
  readonly vault: 'awaiting_passkey' | 'unlocking' | 'saving_files' | 'checking_package' | null;
  readonly account: { readonly ceremony: 'idle' | 'awaiting_passkey'; readonly backend: string };
  readonly review: {
    readonly loading: boolean;
    readonly intake: 'idle' | 'running' | 'done' | 'failed';
    readonly intakeLabel: string | null;
    readonly checks: 'none' | 'running' | 'fresh' | 'stale';
    readonly comparison: 'none' | 'running' | 'ready' | 'failed';
    readonly save: 'saved' | 'unsaved' | 'saving' | 'error';
  };
  readonly transaction:
    | 'idle'
    | 'checking_network'
    | 'awaiting_confirmation'
    | 'signing'
    | 'sending'
    | 'pending'
    | 'checking_execution'
    | 'confirmed'
    | 'reverted'
    | 'unknown'
    | 'failed'
    | 'cancelled';
  readonly run: {
    readonly active: boolean;
    readonly operation: string;
    readonly stepsCompleted: number;
    readonly stepsTotal: number | null;
  } | null;
  readonly indexerCatchingUp: boolean;
}

/**
 * The one operation to show, chosen by how directly the reviewer's last action caused it. Returns
 * null when nothing is really pending. It never makes up a step name or a total.
 */
export function selectPendingWork(input: PendingInput): PendingWork | null {
  const w = (
    key: string,
    region: BusyRegion,
    sentence: string,
    cancellable = false,
    step: PendingWork['step'] = null,
  ): PendingWork => ({ key, region, sentence, step, cancellable });
  if (input.vault === 'awaiting_passkey' || input.account.ceremony === 'awaiting_passkey')
    return w('passkey', 'account', 'Waiting for your passkey on this device.');
  if (input.vault === 'unlocking') return w('vault-unlock', 'vault', 'Unlocking the vault.');
  const tx = input.transaction;
  if (tx === 'checking_network')
    return w('tx-network', 'transaction', 'Checking the network.', true);
  if (tx === 'signing') return w('tx-sign', 'transaction', 'Waiting for your signature.', true);
  if (tx === 'sending') return w('tx-send', 'transaction', 'Sending your transaction.', true);
  if (tx === 'pending')
    return w('tx-pending', 'transaction', 'Waiting for the transaction to be confirmed.', true);
  if (tx === 'checking_execution')
    return w('tx-check', 'transaction', 'Checking that the transaction succeeded.');
  if (input.vault === 'saving_files') return w('vault-save', 'save', 'Saving encrypted files.');
  if (input.vault === 'checking_package' || input.review.save === 'saving')
    return w('save', 'save', 'Saving and reading the result back to check it.');
  if (input.review.intake === 'running')
    return w(
      'intake',
      'document',
      input.review.intakeLabel === null
        ? 'Reading the document.'
        : `Reading the document: ${input.review.intakeLabel}.`,
      true,
    );
  if (input.review.loading) return w('matter-load', 'document', 'Opening the matter.');
  if (input.review.checks === 'running')
    return w('checks', 'analysis', 'Running the checks on this device.', true);
  if (input.review.comparison === 'running')
    return w('comparison', 'analysis', 'Comparing the two documents.', true);
  if (input.run !== null && input.run.active) {
    const total = input.run.stepsTotal;
    return w(
      'run',
      'assistant',
      `Running the ${input.run.operation}.`,
      true,
      total === null || total < 1
        ? null
        : { done: Math.min(input.run.stepsCompleted, total), total },
    );
  }
  if (input.indexerCatchingUp) return w('index', 'index', 'The index is catching up.');
  return null;
}

export interface LoadingView {
  readonly visible: boolean;
  readonly work: PendingWork | null;
  /** Real elapsed time has passed the "still working" threshold. */
  readonly stillWorking: boolean;
  /** Set once when a shown operation ends: the sentence to announce, then cleared by the next call. */
  readonly finished: string | null;
  /** The next instant the gate's answer can change by itself, or null. For scheduling one timer. */
  readonly nextChangeAtMs: number | null;
}

/**
 * Applies the show-after, minimum-visible and elapsed-time rules to the controller's real
 * pending state. Call it with each new reading and its clock; it keeps only two timestamps.
 */
export class LoadingGate {
  #key: string | null = null;
  #work: PendingWork | null = null;
  #startedAt = 0;
  #shownAt: number | null = null;

  update(work: PendingWork | null, nowMs: number): LoadingView {
    let finished: string | null = null;
    if (work !== null && work.key !== this.#key) {
      // A different operation starts a fresh clock; a shown one that ended says so first.
      if (this.#shownAt !== null && this.#work !== null) finished = this.#doneText(this.#work);
      this.#key = work.key;
      this.#work = work;
      this.#startedAt = nowMs;
      this.#shownAt = null;
    } else if (work !== null) {
      this.#work = work;
    }
    if (work === null && this.#key !== null) {
      const shown = this.#shownAt !== null;
      // Within the minimum, keep showing the finished operation until the minimum has passed.
      if (shown && this.#shownAt !== null && nowMs < this.#shownAt + LOADING_MIN_VISIBLE_MS) {
        return this.#view(nowMs, null, this.#shownAt + LOADING_MIN_VISIBLE_MS);
      }
      if (shown && this.#work !== null) finished = this.#doneText(this.#work);
      this.#key = null;
      this.#work = null;
      this.#shownAt = null;
      return { visible: false, work: null, stillWorking: false, finished, nextChangeAtMs: null };
    }
    if (this.#key === null || this.#work === null) {
      return { visible: false, work: null, stillWorking: false, finished, nextChangeAtMs: null };
    }
    if (this.#shownAt === null && nowMs - this.#startedAt >= LOADING_SHOW_AFTER_MS) {
      this.#shownAt = nowMs;
    }
    return this.#view(nowMs, finished, null);
  }

  #doneText(work: PendingWork): string {
    return `Finished: ${work.sentence.replace(/\.$/, '').toLowerCase()}.`;
  }

  #view(nowMs: number, finished: string | null, holdUntil: number | null): LoadingView {
    const work = this.#work;
    const shown = this.#shownAt !== null;
    const elapsed = nowMs - this.#startedAt;
    const still = shown && elapsed >= LOADING_STILL_WORKING_MS;
    let next: number | null = null;
    if (holdUntil !== null) next = holdUntil;
    else if (!shown) next = this.#startedAt + LOADING_SHOW_AFTER_MS;
    else if (!still) next = this.#startedAt + LOADING_STILL_WORKING_MS;
    return { visible: shown, work, stillWorking: still, finished, nextChangeAtMs: next };
  }
}

// ---- Positive feedback ------------------------------------------------------------------------

export type PositiveKind =
  | 'fact_confirmed'
  | 'saved_verified'
  | 'findings_resolved'
  | 'evidence_complete'
  | 'analysis_completed';

/** What each verified event says. None implies legal approval, a signature or a receipt. */
export const POSITIVE_TEXT: Readonly<Record<PositiveKind, string>> = {
  fact_confirmed: 'Fact confirmed.',
  saved_verified: 'Saved and verified.',
  findings_resolved: 'Every finding has a recorded decision. This is not approval.',
  evidence_complete: 'Evidence checklist complete for the selected documents.',
  analysis_completed: 'Checks finished on this device.',
};

export interface PositiveEvent {
  readonly kind: PositiveKind;
  /** Stable identity of this one event, such as the saved revision or the check snapshot digest. */
  readonly id: string;
  readonly matterId: string;
}

export interface PositiveContext {
  readonly nowMs: number;
  /** live: the controller just changed state. hydration: state replayed on load or reconnect. */
  readonly source: 'live' | 'hydration';
  readonly pageVisible: boolean;
  readonly mode: EffectsMode;
  /** The event belongs to the matter open now. */
  readonly sameMatter: boolean;
}

export interface PositiveLabel {
  readonly kind: PositiveKind;
  readonly id: string;
  readonly text: string;
}

export interface PositiveOutcome {
  /** False for a duplicate or a replay: nothing changes. */
  readonly accepted: boolean;
  readonly log: { readonly id: string; readonly kind: PositiveKind; readonly text: string } | null;
  readonly label: PositiveLabel | null;
  readonly announce: string | null;
  /** Start the one-shot wave on the next rendered frame. */
  readonly play: boolean;
}

const NO_OUTCOME: PositiveOutcome = {
  accepted: false,
  log: null,
  label: null,
  announce: null,
  play: false,
};

/**
 * Dedupes by stable event identity, suppresses replays, other matters and hidden tabs, and
 * shares one envelope window with the receipt effect. Reduced and Off modes keep the label and
 * the single announcement; only the wave is skipped.
 */
export class PositiveEffects {
  readonly #seen = new BoundedIdentitySet(256);
  readonly #limiter: EnvelopeLimiter;

  constructor(limiter: EnvelopeLimiter = new EnvelopeLimiter()) {
    this.#limiter = limiter;
  }

  consume(event: PositiveEvent, ctx: PositiveContext): PositiveOutcome {
    if (!this.#seen.add(`${event.kind}:${event.id}`)) return NO_OUTCOME;
    // Replayed history is remembered so it cannot play later, but it is not news.
    if (ctx.source === 'hydration' || !ctx.sameMatter) return NO_OUTCOME;
    const text = POSITIVE_TEXT[event.kind];
    const play = ctx.pageVisible && ctx.mode === 'full' && this.#limiter.tryPlay(ctx.nowMs);
    return {
      accepted: true,
      log: { id: event.id, kind: event.kind, text },
      label: { kind: event.kind, id: event.id, text },
      announce: ctx.pageVisible ? text : null,
      play,
    };
  }
}

// ---- Detecting verified events from controller snapshots ---------------------------------------

export interface PositiveSnapshot {
  readonly matterId: string | null;
  readonly factIds: readonly string[];
  readonly checks: 'none' | 'running' | 'fresh' | 'stale';
  readonly checksDigest: string | null;
  /** A save or its read-back is in flight right now. */
  readonly saveInFlight: boolean;
  /** The vault reports 'saved' with no progress: the read-back finished. */
  readonly savedVerified: boolean;
  readonly saveRevision: number;
  readonly findingsTotal: number;
  readonly findingsUnresolved: number;
  readonly evidenceItems: number;
  readonly evidenceUnsatisfied: number;
}

/**
 * Compares two consecutive snapshots of the same matter and names what newly became true. The
 * first snapshot, a different matter and an unchanged state yield nothing, so a page load,
 * a remount or a matter switch cannot manufacture an event.
 */
export function detectPositiveEvents(
  previous: PositiveSnapshot | null,
  current: PositiveSnapshot,
): readonly PositiveEvent[] {
  if (previous === null || current.matterId === null || previous.matterId !== current.matterId) {
    return [];
  }
  const matterId = current.matterId;
  const events: PositiveEvent[] = [];
  const known = new Set(previous.factIds);
  for (const id of current.factIds) {
    if (!known.has(id)) events.push({ kind: 'fact_confirmed', id, matterId });
  }
  if (
    previous.checks === 'running' &&
    current.checks === 'fresh' &&
    current.checksDigest !== null
  ) {
    events.push({ kind: 'analysis_completed', id: current.checksDigest, matterId });
  }
  // Only a save that was really in flight and then read back counts, never a state seen on load.
  if (previous.saveInFlight && !current.saveInFlight && current.savedVerified) {
    events.push({
      kind: 'saved_verified',
      id: `${matterId}:${String(current.saveRevision)}`,
      matterId,
    });
  }
  const resolvedBefore = previous.findingsTotal > 0 && previous.findingsUnresolved === 0;
  const resolvedNow = current.findingsTotal > 0 && current.findingsUnresolved === 0;
  if (!resolvedBefore && resolvedNow && previous.findingsTotal > 0) {
    events.push({
      kind: 'findings_resolved',
      id: `${matterId}:${current.checksDigest ?? 'none'}`,
      matterId,
    });
  }
  const completeBefore = previous.evidenceItems > 0 && previous.evidenceUnsatisfied === 0;
  const completeNow = current.evidenceItems > 0 && current.evidenceUnsatisfied === 0;
  if (!completeBefore && completeNow && previous.evidenceItems > 0) {
    events.push({
      kind: 'evidence_complete',
      id: `${matterId}:${current.checksDigest ?? 'none'}`,
      matterId,
    });
  }
  return events;
}
