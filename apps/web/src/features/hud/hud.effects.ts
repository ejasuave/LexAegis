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
