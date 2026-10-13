import { BoundedIdentitySet } from './hud.events';

/*
 * Effects policy. Accessibility preferences govern every effect: the operating system's
 * reduced-motion request is honoured before the first animated frame, and a site preference may
 * only reduce effects further, never override the request upward.
 */

export type EffectsPreference = 'system' | 'reduced' | 'off';
export type EffectsMode = 'full' | 'reduced' | 'off';

export const EFFECTS_PREFERENCES: readonly EffectsPreference[] = ['system', 'reduced', 'off'];

export function isEffectsPreference(value: unknown): value is EffectsPreference {
  return typeof value === 'string' && (EFFECTS_PREFERENCES as readonly string[]).includes(value);
}

export interface EffectsEnvironment {
  readonly preference: EffectsPreference;
  /** prefers-reduced-motion: reduce */
  readonly osReducedMotion: boolean;
  /** forced-colors: active. The decorative canvas gets in the way of forced colours. */
  readonly forcedColors: boolean;
  /** Canvas 2D could not be initialised. */
  readonly canvasFailed: boolean;
}

export function resolveEffects(env: EffectsEnvironment): EffectsMode {
  if (env.preference === 'off' || env.forcedColors || env.canvasFailed) return 'off';
  if (env.preference === 'reduced' || env.osReducedMotion) return 'reduced';
  return 'full';
}

// ---- Receipt confirmation ---------------------------------------------------------------------

/** The least the HUD needs of a verified signal. The transaction controller is the only source. */
export interface ReceiptSignal {
  readonly kind: 'confirmed' | 'invalidated';
  readonly id: string;
}

export interface ReceiptContext {
  readonly nowMs: number;
  /** live: delivered by the controller as it watched the operation change. hydration: replayed state. */
  readonly source: 'live' | 'hydration';
  readonly pageVisible: boolean;
  readonly mode: EffectsMode;
  /** The confirmed receipt belongs to the matter and package open now. */
  readonly sameMatter: boolean;
  readonly networkLabel: string;
}

export interface ReceiptLabel {
  readonly kind: 'confirmed' | 'correction';
  readonly id: string;
  readonly text: string;
}

export interface ReceiptLogEntry {
  readonly id: string;
  readonly kind: 'confirmed' | 'invalidated';
  readonly atMs: number;
  readonly text: string;
}

export interface ReceiptOutcome {
  /** False for a duplicate or a replay: nothing changes. */
  readonly accepted: boolean;
  readonly log: ReceiptLogEntry | null;
  /** Persistent wording; it never depends on the animation finishing. */
  readonly label: ReceiptLabel | null;
  /** Said once to assistive technology. */
  readonly announce: string | null;
  /** Start the one-shot wash and perimeter wave on the next rendered frame. */
  readonly play: boolean;
  /** A correction ends any running effect: a confirmation never hides a problem. */
  readonly cancelPlay: boolean;
}

const NONE: ReceiptOutcome = {
  accepted: false,
  log: null,
  label: null,
  announce: null,
  play: false,
  cancelPlay: false,
};

/** At most one celebration envelope in any window; a later burst is dropped, never queued. */
export const RECEIPT_COALESCE_MS = 2000;
/** Rise and fade of the wash, and its starting maximum opacity. */
export const WASH_RISE_MS = 180;
export const WASH_FADE_MS = 420;
export const WASH_MAX_OPACITY = 0.06;

/**
 * Decides what a verified signal changes on screen. It deduplicates by the stable event
 * identity, suppresses replays, hidden tabs, other matters and reduced or disabled effects (which
 * still get the persistent label and one announcement), and coalesces bursts. It reads no
 * controller and writes no business state.
 */
export class ReceiptEffects {
  readonly #seen = new BoundedIdentitySet(256);
  #lastPlayAt: number | null = null;

  consume(signal: ReceiptSignal, ctx: ReceiptContext): ReceiptOutcome {
    if (signal.kind === 'invalidated') {
      if (!this.#seen.add(`invalidated:${signal.id}`)) return NONE;
      // A later honest re-confirmation of this identity must not celebrate again.
      const text =
        'Correction: this receipt is no longer confirmed. Its status is being checked again.';
      return {
        accepted: true,
        log: { id: signal.id, kind: 'invalidated', atMs: ctx.nowMs, text },
        label: { kind: 'correction', id: signal.id, text },
        announce: text,
        play: false,
        cancelPlay: true,
      };
    }
    if (!this.#seen.add(`confirmed:${signal.id}`)) return NONE;
    // Replayed history is remembered so it cannot play later, but it is not news.
    if (ctx.source === 'hydration') return NONE;
    const text = `Receipt confirmed on ${ctx.networkLabel}.`;
    const coalesced =
      this.#lastPlayAt !== null && ctx.nowMs - this.#lastPlayAt < RECEIPT_COALESCE_MS;
    const play = ctx.pageVisible && ctx.sameMatter && ctx.mode === 'full' && !coalesced;
    if (play) this.#lastPlayAt = ctx.nowMs;
    return {
      accepted: true,
      log: { id: signal.id, kind: 'confirmed', atMs: ctx.nowMs, text },
      label: { kind: 'confirmed', id: signal.id, text },
      announce: text,
      play,
      cancelPlay: false,
    };
  }
}

/** Opacity of the full-screen wash t milliseconds after it started: a rise, then a fade to zero. */
export function washOpacity(elapsedMs: number): number {
  if (elapsedMs <= 0 || elapsedMs >= WASH_RISE_MS + WASH_FADE_MS) return 0;
  if (elapsedMs < WASH_RISE_MS) return WASH_MAX_OPACITY * (elapsedMs / WASH_RISE_MS);
  return WASH_MAX_OPACITY * (1 - (elapsedMs - WASH_RISE_MS) / WASH_FADE_MS);
}
