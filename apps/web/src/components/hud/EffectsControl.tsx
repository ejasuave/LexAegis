'use client';

import { useId } from 'react';
import {
  EFFECTS_PREFERENCES,
  isEffectsPreference,
  resolveEffects,
  type EffectsPreference,
} from '@/features/hud/public';
import { useEffectsEnvironment, writePreference } from './effects-preference';

const LABEL: Record<EffectsPreference, string> = {
  system: 'System',
  reduced: 'Reduced',
  off: 'Off',
};

/**
 * Persistent Effects control. System follows the device; Reduced is a still picture with no
 * motion; Off removes the decorative canvas. Neither removes any status information.
 */
export function EffectsControl() {
  const env = useEffectsEnvironment();
  const id = useId();
  const mode = resolveEffects({ ...env, canvasFailed: false });
  const note =
    env.forcedColors && env.preference !== 'off'
      ? 'Off while forced colours are on.'
      : env.preference === 'system' && env.osReducedMotion
        ? 'Your device asks for reduced motion.'
        : mode === 'full'
          ? 'Animated.'
          : mode === 'reduced'
            ? 'Still.'
            : 'No canvas.';
  return (
    <div className="flex items-center gap-2 text-[0.8125rem]">
      <label htmlFor={id} className="text-lj-muted">
        Effects
      </label>
      <select
        id={id}
        value={env.preference}
        className="min-h-6 rounded border border-lj-edge bg-lj-soft px-2 text-lj-text"
        onChange={(event) => {
          if (isEffectsPreference(event.target.value)) writePreference(event.target.value);
        }}
      >
        {EFFECTS_PREFERENCES.map((preference) => (
          <option key={preference} value={preference}>
            {LABEL[preference]}
          </option>
        ))}
      </select>
      <span className="text-lj-secondary">{note}</span>
    </div>
  );
}
